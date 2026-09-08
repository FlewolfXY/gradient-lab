"""
paint→MIDI 交互召唤台（网页版）。

跑法：
    ./.venv/bin/python web.py
浏览器打开 http://127.0.0.1:5200

把画放进本文件夹（或网页里直接上传），点画上任意位置 → 音乐从那里荡开。
"""

import hashlib
import json
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_file

import paint_to_midi as ptm

BASE = Path(__file__).resolve().parent
WEB_OUT = BASE / "out" / "web"
WEB_OUT.mkdir(parents=True, exist_ok=True)

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 60 * 1024 * 1024


def list_paintings():
    return sorted(
        [p.name for p in BASE.iterdir()
         if p.suffix.lower() in IMAGE_EXTS and not p.name.startswith(".")],
        key=lambda n: (BASE / n).stat().st_mtime, reverse=True)


def painting_path(name: str) -> Path:
    p = (BASE / name).resolve()
    if p.parent != BASE or p.suffix.lower() not in IMAGE_EXTS or not p.exists():
        abort(404)
    return p


@app.route("/")
def index():
    return render_template("paint.html", paintings=list_paintings())


@app.route("/painting/<name>")
def painting(name):
    return send_file(painting_path(name))


@app.route("/upload", methods=["POST"])
def upload():
    f = request.files.get("image")
    if not f or not f.filename:
        abort(400)
    ext = Path(f.filename).suffix.lower()
    if ext not in IMAGE_EXTS:
        abort(400, "只收图片")
    safe = Path(f.filename).stem[:40].replace("/", "_") + ext
    f.save(str(BASE / safe))
    return jsonify(name=safe)


@app.route("/render", methods=["POST"])
def render():
    p = request.get_json(force=True)
    img = painting_path(p["image"])
    opts = {
        "scan": p.get("scan", "lr"),
        "focus": tuple(p["focus"]) if p.get("focus") else None,
        "tempo": int(p.get("tempo", 80)),
        "bars": int(p.get("bars", 16)),
        "mode": p.get("mode") or None,
        "key": p.get("key") or None,
        "seed": int(p["seed"]) if p.get("seed") not in (None, "") else None,
    }
    cache_key = hashlib.md5(
        (img.name + str(img.stat().st_mtime) + json.dumps(opts, sort_keys=True)).encode()
    ).hexdigest()[:12]
    out_dir = WEB_OUT / cache_key

    if not (out_dir / "result.json").exists():
        result = ptm.summon(str(img), out_dir=str(out_dir), **opts)
        (out_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False))
    result = json.loads((out_dir / "result.json").read_text())
    result["urls"] = {
        "preview": f"/out/{cache_key}/preview.wav",
        "melody": f"/out/{cache_key}/melody.mid",
        "chords": f"/out/{cache_key}/chords.mid",
        "bass": f"/out/{cache_key}/bass.mid",
        "combined": f"/out/{cache_key}/combined.mid",
        "annotated": f"/out/{cache_key}/annotated.png",
        "report": f"/out/{cache_key}/report.md",
    }
    return jsonify(result)


@app.route("/out/<cache_key>/<filename>")
def out_file(cache_key, filename):
    p = (WEB_OUT / cache_key / filename).resolve()
    if WEB_OUT not in p.parents or not p.exists():
        abort(404)
    return send_file(p, conditional=True)


if __name__ == "__main__":
    print("paint→MIDI 召唤台运行在 http://127.0.0.1:5200")
    app.run(host="127.0.0.1", port=5200, debug=False)
