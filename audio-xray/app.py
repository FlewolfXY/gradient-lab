"""
audio-xray 本地服务器。

跑法：
    ./.venv/bin/python app.py
然后浏览器打开 http://127.0.0.1:5199

上传音频 → 自动分析 → 打开图层视图。
每首歌的所有产物都在 data/<id>/ 里：
    source.<ext>     原始文件（浏览器播放用）
    audio.wav        解码后的 wav（分析与导出选区用）
    analysis.json    全部分析结果
    notes.json       你的笔记
    meta.json        标题、时间
"""

import io
import json
import re
import subprocess
import time
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from flask import (Flask, abort, jsonify, redirect, render_template, request,
                   send_file, url_for)

import analyzer

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
DATA.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 300 * 1024 * 1024  # 300MB 上限


def ensure_wav(src: Path, dst: Path):
    """尽量用 libsndfile 解码；不支持的格式（m4a/aac 等）用 macOS 自带 afconvert。"""
    try:
        data, sr = sf.read(str(src))
        sf.write(str(dst), data, sr)
        return
    except Exception:
        pass
    r = subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", "LEI16", str(src), str(dst)],
        capture_output=True, text=True,
    )
    if r.returncode != 0 or not dst.exists():
        raise RuntimeError(f"无法解码这个音频格式：{src.suffix}（afconvert: {r.stderr.strip()}）")


def track_dir(track_id: str) -> Path:
    d = DATA / track_id
    if not d.is_dir():
        abort(404)
    return d


@app.route("/")
def index():
    tracks = []
    for d in sorted(DATA.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        meta_f = d / "meta.json"
        if meta_f.exists():
            meta = json.loads(meta_f.read_text())
            meta["id"] = d.name
            tracks.append(meta)
    return render_template("index.html", tracks=tracks)


@app.route("/upload", methods=["POST"])
def upload():
    f = request.files.get("audio")
    if not f or not f.filename:
        abort(400, "没有收到文件")
    track_id = uuid.uuid4().hex[:10]
    d = DATA / track_id
    d.mkdir()

    ext = Path(f.filename).suffix.lower() or ".bin"
    src = d / f"source{ext}"
    f.save(str(src))

    wav = d / "audio.wav"
    try:
        ensure_wav(src, wav)
        result = analyzer.analyze(str(wav))
    except Exception as e:
        # 失败就清掉这条，别留半成品
        for p in d.iterdir():
            p.unlink()
        d.rmdir()
        abort(500, f"分析失败：{e}")

    (d / "analysis.json").write_text(json.dumps(result, ensure_ascii=False))
    title = re.sub(r"\.[^.]+$", "", f.filename)
    (d / "meta.json").write_text(json.dumps({
        "title": title,
        "created": time.strftime("%Y-%m-%d %H:%M"),
        "duration": result["duration"],
        "tempo_bpm": result["tempo_bpm"],
        "source_ext": ext,
    }, ensure_ascii=False))
    (d / "notes.json").write_text(json.dumps({"global": "", "segments": {}}))
    return redirect(url_for("track_page", track_id=track_id))


@app.route("/track/<track_id>")
def track_page(track_id):
    d = track_dir(track_id)
    meta = json.loads((d / "meta.json").read_text())
    return render_template("track.html", track_id=track_id, meta=meta)


@app.route("/track/<track_id>/analysis.json")
def track_analysis(track_id):
    return send_file(track_dir(track_id) / "analysis.json")


@app.route("/track/<track_id>/audio")
def track_audio(track_id):
    d = track_dir(track_id)
    meta = json.loads((d / "meta.json").read_text())
    src = d / f"source{meta['source_ext']}"
    if not src.exists():
        src = d / "audio.wav"
    return send_file(src, conditional=True)  # conditional=True 支持拖动进度条


@app.route("/track/<track_id>/notes", methods=["GET", "POST"])
def track_notes(track_id):
    d = track_dir(track_id)
    nf = d / "notes.json"
    if request.method == "POST":
        nf.write_text(json.dumps(request.get_json(force=True), ensure_ascii=False, indent=2))
        return jsonify(ok=True)
    return send_file(nf)


@app.route("/track/<track_id>/clip")
def track_clip(track_id):
    """导出选区 WAV，直接拖进 Logic。 /clip?start=12.3&end=20.1"""
    d = track_dir(track_id)
    try:
        start = float(request.args["start"])
        end = float(request.args["end"])
    except (KeyError, ValueError):
        abort(400, "需要 start / end 参数")
    if end <= start:
        abort(400, "end 必须大于 start")

    data, sr = sf.read(str(d / "audio.wav"))
    a, b = int(start * sr), int(end * sr)
    clip = data[a:b]
    buf = io.BytesIO()
    sf.write(buf, clip, sr, format="WAV")
    buf.seek(0)
    meta = json.loads((d / "meta.json").read_text())
    name = f"{meta['title']}_{start:.1f}s-{end:.1f}s.wav"
    return send_file(buf, as_attachment=True, download_name=name, mimetype="audio/wav")


@app.route("/track/<track_id>/reanalyze", methods=["POST"])
def track_reanalyze(track_id):
    """用最新的分析管线重跑一遍（升级 analyzer 后不用重新上传）。"""
    d = track_dir(track_id)
    result = analyzer.analyze(str(d / "audio.wav"))
    (d / "analysis.json").write_text(json.dumps(result, ensure_ascii=False))
    meta = json.loads((d / "meta.json").read_text())
    meta["duration"] = result["duration"]
    meta["tempo_bpm"] = result["tempo_bpm"]
    (d / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))
    return redirect(url_for("track_page", track_id=track_id))


@app.route("/track/<track_id>/delete", methods=["POST"])
def track_delete(track_id):
    d = track_dir(track_id)
    for p in d.iterdir():
        p.unlink()
    d.rmdir()
    return redirect(url_for("index"))


if __name__ == "__main__":
    print("audio-xray 运行在 http://127.0.0.1:5199")
    app.run(host="127.0.0.1", port=5199, debug=False)
