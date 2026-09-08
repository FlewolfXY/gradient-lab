"""
audio-xray 分析管线 v1.5。

输入一个 wav 文件，输出一个 dict（存成 analysis.json），包含：
- 波形峰值
- BPM 与逐拍位置
- CQT 音高频谱（每行 = 一个半音，给缺乐理的人看的频谱）
- Mel 频谱（负责高频空气与质感，做过对比度拉伸）
- Chroma 十二音级热图
- 三层响度带：低音层 / 中频层 / 高频层（平滑后），外加节奏密度
- 和弦候选（三和弦模板匹配，明确是候选不是真理）
- 全曲调性估计
- 自动分段 + 每段统计 + 每段中文解说（把物理量翻译成音乐语义）
- 自相似矩阵
"""

import numpy as np
import librosa

SR = 22050
HOP = 512

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

MAX_COLS = 2400
WAVE_BUCKETS = 2400
SSM_MAX = 360

# CQT：C1 到 C8，共 84 个半音
CQT_FMIN_NOTE = "C1"
CQT_BINS = 84

# 三个频段的分界（Hz）：低音层 / 中频层 / 高频层
BAND_LOW = 180.0
BAND_HIGH = 1800.0


def _downsample_cols(M: np.ndarray, max_cols: int) -> np.ndarray:
    """把 (bins, frames) 矩阵在时间方向压缩到 <= max_cols 列（块平均）。"""
    n = M.shape[1]
    if n <= max_cols:
        return M
    idx = np.linspace(0, n, max_cols + 1).astype(int)
    return np.stack([M[:, a:b].mean(axis=1) for a, b in zip(idx[:-1], idx[1:])], axis=1)


def _downsample_1d(v: np.ndarray, max_len: int) -> np.ndarray:
    if len(v) <= max_len:
        return v
    idx = np.linspace(0, len(v), max_len + 1).astype(int)
    return np.array([v[a:b].mean() for a, b in zip(idx[:-1], idx[1:])])


def _smooth(v: np.ndarray, win_frames: int) -> np.ndarray:
    """移动平均平滑。曲线是给眼睛读趋势的，不是给示波器看的。"""
    if win_frames <= 1 or len(v) < win_frames:
        return v
    kernel = np.ones(win_frames) / win_frames
    return np.convolve(v, kernel, mode="same")


def _quantize(M: np.ndarray) -> list:
    """线性归一化到 0-99 整数。"""
    lo, hi = float(M.min()), float(M.max())
    if hi - lo < 1e-9:
        return np.zeros_like(M, dtype=int).tolist()
    return np.round((M - lo) / (hi - lo) * 99).astype(int).tolist()


def _stretch_quantize(M: np.ndarray, p_lo=2.0, p_hi=99.5, gamma=0.65) -> list:
    """百分位对比度拉伸 + gamma，防止热图糊成一片深色。"""
    lo = float(np.percentile(M, p_lo))
    hi = float(np.percentile(M, p_hi))
    if hi - lo < 1e-9:
        return np.zeros_like(M, dtype=int).tolist()
    N = np.clip((M - lo) / (hi - lo), 0, 1) ** gamma
    return np.round(N * 99).astype(int).tolist()


# ---------- 和弦模板 ----------

def _chord_templates():
    maj = np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], float)
    minor = np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], float)
    templates, labels = [], []
    for r in range(12):
        templates.append(np.roll(maj, r))
        labels.append(PITCH_NAMES[r])
        templates.append(np.roll(minor, r))
        labels.append(PITCH_NAMES[r] + "m")
    T = np.array(templates)
    T = T / np.linalg.norm(T, axis=1, keepdims=True)
    return T, labels


def _estimate_chords(chroma_sync: np.ndarray, sync_times: np.ndarray, duration: float,
                     conf_threshold=0.62) -> list:
    """每个网格单元匹配 24 个三和弦模板；置信度不足记 '—'。返回合并后的块。"""
    T, labels = _chord_templates()
    cn = chroma_sync / (np.linalg.norm(chroma_sync, axis=0, keepdims=True) + 1e-9)
    sim = T @ cn
    best = sim.argmax(axis=0)
    conf = sim.max(axis=0)
    seq = [labels[b] if c >= conf_threshold else "—" for b, c in zip(best, conf)]

    # 众数平滑（窗口 5），压掉短暂的抖动——和声模糊的音乐会产生大量碎块
    smoothed = list(seq)
    half = 2
    for i in range(len(seq)):
        window = seq[max(0, i - half): i + half + 1]
        smoothed[i] = max(set(window), key=window.count)

    blocks = []
    for i, lab in enumerate(smoothed):
        t0 = float(sync_times[i])
        t1 = float(sync_times[i + 1]) if i + 1 < len(sync_times) else duration
        if blocks and blocks[-1]["label"] == lab:
            blocks[-1]["end"] = round(t1, 3)
        else:
            blocks.append({"label": lab, "start": round(t0, 3), "end": round(t1, 3)})
    # 过短的块并入前一块（< 1.5 秒的和弦候选基本是噪声）
    merged = []
    for b in blocks:
        if merged and (b["end"] - b["start"]) < 1.5:
            merged[-1]["end"] = b["end"]
        else:
            merged.append(b)
    # 再跑一遍相邻合并（吞并之后可能出现同名相邻块）
    final = []
    for b in merged:
        if final and final[-1]["label"] == b["label"]:
            final[-1]["end"] = b["end"]
        else:
            final.append(b)
    return final


# ---------- 调性估计（Krumhansl-Schmuckler） ----------

KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _estimate_key(mean_chroma: np.ndarray) -> dict:
    best = {"corr": -2.0, "name": "?", "mode": ""}
    for r in range(12):
        rolled = np.roll(mean_chroma, -r)
        for profile, mode in [(KS_MAJOR, "大调"), (KS_MINOR, "小调")]:
            c = float(np.corrcoef(rolled, profile)[0, 1])
            if c > best["corr"]:
                best = {"corr": round(c, 3), "name": PITCH_NAMES[r], "mode": mode}
    return {"label": f"{best['name']} {best['mode']}", "confidence": best["corr"]}


# ---------- 每段中文解说 ----------

def _fmt_db(d):
    return f"+{d:.1f}dB" if d >= 0 else f"{d:.1f}dB"


def _narrate(seg: dict, prev: dict | None) -> str:
    """把段落间的物理差异翻译成音乐语义。这是给初学者的翻译层，不是审美判断。"""
    if prev is None:
        parts = []
        parts.append("响度高于全曲平均" if seg["rms_db_rel"] > 1 else
                     "响度低于全曲平均" if seg["rms_db_rel"] < -1 else "响度接近全曲平均")
        parts.append("高频层活跃" if seg["high_db_rel"] > 2 else
                     "高频层安静" if seg["high_db_rel"] < -2 else "高频层中等")
        parts.append("低音在场" if seg["low_db_rel"] > 0 else "低音克制")
        return "开场基调：" + "，".join(parts) + "。"

    d_rms = seg["rms_db_rel"] - prev["rms_db_rel"]
    d_low = seg["low_db_rel"] - prev["low_db_rel"]
    d_high = seg["high_db_rel"] - prev["high_db_rel"]
    onset_ratio = seg["onset_per_sec"] / max(0.05, prev["onset_per_sec"])

    parts = []
    if abs(d_rms) < 1.0:
        rms_word = "响度几乎不变"
    elif d_rms > 0:
        rms_word = f"响度 {_fmt_db(d_rms)}"
    else:
        rms_word = f"响度回落 {_fmt_db(d_rms)}"
    parts.append(rms_word)

    if d_low > 12:
        parts.append("低音层大幅增强（低音落地）")
    elif d_low > 3:
        parts.append(f"低音层增强 {_fmt_db(d_low)}（低音落地）")
    elif d_low < -12:
        parts.append("低音层大幅撤走")
    elif d_low < -3:
        parts.append(f"低音层撤走 {_fmt_db(d_low)}")

    if d_high > 12:
        parts.append("高频层大幅打开（空间变亮）")
    elif d_high > 3:
        parts.append(f"高频层打开 {_fmt_db(d_high)}（空间变亮）")
    elif d_high < -12:
        parts.append("高频层大幅收拢")
    elif d_high < -3:
        parts.append(f"高频层收拢 {_fmt_db(d_high)}")

    if onset_ratio > 1.5:
        parts.append(f"节奏密度 ×{onset_ratio:.1f}")
    elif onset_ratio < 0.67:
        parts.append(f"节奏变疏（×{onset_ratio:.1f}）")

    text = "相比上一段：" + "，".join(parts) + "。"

    # 她最关心的那种情况，单独点破
    if abs(d_rms) < 1.5 and d_high > 3:
        text += " —— 不是更响，而是更亮。"
    elif abs(d_rms) < 1.5 and onset_ratio > 1.5:
        text += " —— 不是更响，而是更密。"
    return text


def analyze(wav_path: str) -> dict:
    y, sr = librosa.load(wav_path, sr=SR, mono=True)
    duration = float(len(y) / sr)

    # ---------- 波形峰值 ----------
    n_b = min(WAVE_BUCKETS, len(y))
    idx = np.linspace(0, len(y), n_b + 1).astype(int)
    wave_max = [float(np.max(y[a:b])) if b > a else 0.0 for a, b in zip(idx[:-1], idx[1:])]
    wave_min = [float(np.min(y[a:b])) if b > a else 0.0 for a, b in zip(idx[:-1], idx[1:])]
    peak = max(1e-9, max(abs(v) for v in wave_max + wave_min))
    wave_max = [round(v / peak, 3) for v in wave_max]
    wave_min = [round(v / peak, 3) for v in wave_min]

    # ---------- 基础特征 ----------
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    rms_db = librosa.amplitude_to_db(rms, ref=np.max(rms) if np.max(rms) > 0 else 1.0)
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=HOP)[0]
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)

    n_frames = len(rms)
    times = librosa.frames_to_time(np.arange(n_frames), sr=sr, hop_length=HOP)
    frames_per_sec = sr / HOP

    # ---------- 三层响度带（低/中/高） ----------
    S_pow = np.abs(librosa.stft(y, hop_length=HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=sr)
    total_ref = float(S_pow.sum(axis=0).max())
    def band_db(mask):
        p = S_pow[mask].sum(axis=0)
        # 地板 -60dB：纯零能量段不该把差值算成天文数字
        return np.clip(librosa.power_to_db(p, ref=total_ref), -60.0, 0.0)
    low_db = band_db(freqs < BAND_LOW)[:n_frames]
    mid_db = band_db((freqs >= BAND_LOW) & (freqs < BAND_HIGH))[:n_frames]
    high_db = band_db(freqs >= BAND_HIGH)[:n_frames]

    smooth_win = max(3, int(0.4 * frames_per_sec))
    low_s = _smooth(low_db, smooth_win)
    mid_s = _smooth(mid_db, smooth_win)
    high_s = _smooth(high_db, smooth_win)
    rms_s = _smooth(rms_db, smooth_win)
    onset_s = _smooth(onset_env[:n_frames], max(3, int(0.25 * frames_per_sec)))

    # ---------- 节拍 ----------
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=HOP)
    tempo = float(np.atleast_1d(tempo)[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)

    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, hop_length=HOP)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr, hop_length=HOP)

    # ---------- CQT 音高频谱 ----------
    C = np.abs(librosa.cqt(y, sr=sr, hop_length=HOP,
                           fmin=librosa.note_to_hz(CQT_FMIN_NOTE),
                           n_bins=CQT_BINS, bins_per_octave=12))
    C_db = librosa.amplitude_to_db(C, ref=np.max)
    cqt_small = _downsample_cols(C_db, MAX_COLS)

    # ---------- Mel 频谱（负责高频空气与质感） ----------
    S = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=84, hop_length=HOP, fmax=sr / 2)
    S_db = librosa.power_to_db(S, ref=np.max)
    mel_small = _downsample_cols(S_db, MAX_COLS)

    # ---------- Chroma ----------
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    chroma_small = _downsample_cols(chroma, MAX_COLS)

    # ---------- 0.5 秒网格特征（分段、SSM、和弦共用） ----------
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=HOP)
    grid_sec = 0.5
    step = max(1, int(grid_sec * sr / HOP))
    sync_frames = np.arange(0, n_frames, step)
    sync_times_all = librosa.frames_to_time(sync_frames, sr=sr, hop_length=HOP)

    feats = np.vstack([
        librosa.util.sync(mfcc, sync_frames, aggregate=np.mean),
        librosa.util.sync(chroma, sync_frames, aggregate=np.mean),
        librosa.util.sync(rms_db[None, :], sync_frames, aggregate=np.mean),
        librosa.util.sync(np.log1p(centroid[None, :]), sync_frames, aggregate=np.mean),
        librosa.util.sync(onset_env[None, :n_frames], sync_frames, aggregate=np.mean),
    ])
    mu = feats.mean(axis=1, keepdims=True)
    sd = feats.std(axis=1, keepdims=True)
    sd[sd < 1e-9] = 1.0
    feats = (feats - mu) / sd

    # ---------- 和弦候选与调性 ----------
    chroma_sync = librosa.util.sync(chroma, sync_frames, aggregate=np.median)
    chords = _estimate_chords(chroma_sync, sync_times_all, duration)
    key = _estimate_key(chroma.mean(axis=1))

    # ---------- 分段（novelty 峰值） ----------
    from scipy.signal import find_peaks
    n_units = feats.shape[1]
    w = max(2, int(3.0 / grid_sec))
    novelty = np.zeros(n_units)
    for i in range(w, n_units - w):
        novelty[i] = np.linalg.norm(feats[:, i:i + w].mean(axis=1) - feats[:, i - w:i].mean(axis=1))

    k = int(np.clip(round(duration / 12), 4, 16))
    min_seg_sec = 6.0
    bound_times = [0.0, duration]
    if novelty.max() > 0:
        peaks, props = find_peaks(
            novelty,
            height=float(np.percentile(novelty[novelty > 0], 50)),
            distance=max(1, int(min_seg_sec / grid_sec)),
        )
        if len(peaks):
            order = np.argsort(props["peak_heights"])[::-1][: k - 1]
            picked = sorted(float(sync_times_all[p]) for p in peaks[order])
            bound_times = [0.0] + [t for t in picked if min_seg_sec / 2 < t < duration - min_seg_sec / 2] + [duration]

    # ---------- 每段统计 + 解说 ----------
    track_rms_mean = float(np.mean(rms_db))
    track_low_mean = float(np.mean(low_db))
    track_high_mean = float(np.mean(high_db))
    segments = []
    for i in range(len(bound_times) - 1):
        t0, t1 = bound_times[i], bound_times[i + 1]
        if t1 - t0 < 0.5:
            continue
        m = (times >= t0) & (times < t1)
        if not m.any():
            continue
        seg_chroma = chroma[:, m].mean(axis=1)
        top = np.argsort(seg_chroma)[::-1][:3]
        n_onsets = int(((onset_times >= t0) & (onset_times < t1)).sum())
        segments.append({
            "start": round(t0, 3),
            "end": round(t1, 3),
            "rms_db_rel": round(float(np.mean(rms_db[m]) - track_rms_mean), 2),
            "low_db_rel": round(float(np.mean(low_db[m]) - track_low_mean), 2),
            "high_db_rel": round(float(np.mean(high_db[m]) - track_high_mean), 2),
            "centroid_hz": round(float(np.mean(centroid[m])), 1),
            "onset_per_sec": round(n_onsets / (t1 - t0), 2),
            "top_pitches": [PITCH_NAMES[j] for j in top],
        })
    for i, seg in enumerate(segments):
        seg["narrative"] = _narrate(seg, segments[i - 1] if i > 0 else None)

    # ---------- 自相似矩阵 ----------
    fn = librosa.util.normalize(feats, norm=2, axis=0)
    ssm = fn.T @ fn
    if ssm.shape[0] > SSM_MAX:
        ssm = _downsample_cols(_downsample_cols(ssm, SSM_MAX).T, SSM_MAX).T

    # ---------- 曲线降采样 ----------
    n_pts = min(MAX_COLS, n_frames)
    curve_times = _downsample_1d(times, n_pts)

    return {
        "duration": round(duration, 3),
        "sr": sr,
        "tempo_bpm": round(tempo, 1),
        "key": key,
        "beat_times": [round(float(t), 3) for t in beat_times],
        "onset_times": [round(float(t), 3) for t in onset_times],
        "wave": {"max": wave_max, "min": wave_min},
        "curves": {
            "times": [round(float(t), 3) for t in curve_times],
            "rms_db": [round(float(v), 2) for v in _downsample_1d(rms_s, n_pts)],
            "low_db": [round(float(v), 2) for v in _downsample_1d(low_s, n_pts)],
            "mid_db": [round(float(v), 2) for v in _downsample_1d(mid_s, n_pts)],
            "high_db": [round(float(v), 2) for v in _downsample_1d(high_s, n_pts)],
            "onset_strength": [round(float(v), 3) for v in _downsample_1d(onset_s, n_pts)],
        },
        "cqt": {
            "n_bins": CQT_BINS,
            "fmin_note": CQT_FMIN_NOTE,
            "data": _stretch_quantize(cqt_small, p_lo=25.0, p_hi=99.7, gamma=0.8),
        },
        "mel": {"n_bins": mel_small.shape[0], "data": _stretch_quantize(mel_small), "fmax": sr / 2},
        "chroma": {"labels": PITCH_NAMES, "data": _quantize(chroma_small)},
        "chords": chords,
        "segments": segments,
        "boundaries": [round(float(t), 3) for t in bound_times],
        "ssm": {
            "size": ssm.shape[0],
            "data": _quantize(np.clip(ssm, 0, 1)),
            "t0": round(float(sync_times_all[0]), 3) if len(sync_times_all) else 0.0,
            "t1": round(float(sync_times_all[-1]), 3) if len(sync_times_all) else duration,
        },
    }
