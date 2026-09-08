"""
paint→MIDI 召唤台 v2：把一幅画沿任意"扫描场"读成一段音乐。

核心抽象：扫描 = 给每个像素一个"到达时间"的标量场 F。
- lr     : F = x（从左到右，画 = 卷轴）
- tb     : F = y（从上到下，画 = 瀑布）
- ripple : F = 到焦点的距离（从任意一点向外漫溢，画 = 水面）
小节 = F 的等像素量分位带：每个小节"读"掉同样多的颜料。

映射规则（画面 → 音乐决策）：
- 全画主色相（饱和度加权）走五度圈 → 主音
- 明度 + 冷暖 → 大调 / 小调
- 每小节区域偏离全画基调的程度（排名）→ 和弦功能（主/下属/属）
- 饱和度 → 和弦张力（三和弦 / 加7音 / 加9音）
- 明度 → 音区；区域内最亮处的位置 → 旋律轮廓
- 边缘/细节密度 → 节奏密度；近黑区域 = 休止
- 第 1、末小节锁主和弦，每 4 小节拉属和弦（终止式）

用法：
    ./.venv/bin/python paint_to_midi.py 画.png
    ./.venv/bin/python paint_to_midi.py 画.png --scan ripple --focus 0.62,0.40
    ./.venv/bin/python paint_to_midi.py 画.png --scan tb --tempo 66
"""

import argparse
import hashlib
import math
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
import mido

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]

MAJOR_DEGREES = [
    ("I", 0, "maj"), ("ii", 2, "min"), ("iii", 4, "min"),
    ("IV", 5, "maj"), ("V", 7, "maj"), ("vi", 9, "min"),
]
MINOR_DEGREES = [
    ("i", 0, "min"), ("III", 3, "maj"), ("iv", 5, "min"),
    ("v", 7, "min"), ("VI", 8, "maj"), ("VII", 10, "maj"),
]

# 和弦功能三档：主功能（家）/ 下属功能（出门）/ 属功能（想回家）
FAMILIES_MAJOR = [("主功能", [0, 5]), ("下属功能", [3, 1]), ("属功能", [4, 2])]
FAMILIES_MINOR = [("主功能", [0, 4]), ("下属功能", [2, 1]), ("属功能", [5, 3])]

# 节奏模板：按细节密度分级，(起拍, 时值) 单位为拍
RHYTHM_TEMPLATES = [
    [(0, 2), (2, 2)],
    [(0, 1.5), (1.5, 1.5), (3, 1)],
    [(0, 1), (1, 1), (2, 0.5), (2.5, 0.5), (3, 1)],
    [(0, 0.5), (0.5, 0.5), (1, 1), (2, 0.5), (2.5, 0.5), (3, 0.5), (3.5, 0.5)],
]

TICKS = 480
SCAN_NAMES = {"lr": "左→右", "tb": "上→下", "ripple": "涟漪"}


# ---------------- 图像分析 ----------------

def load_image(path: str, width=640):
    img = Image.open(path).convert("RGB")
    h = max(1, int(img.height * width / img.width))
    img = img.resize((width, h))
    hsv = np.asarray(img.convert("HSV"), dtype=float)
    H = hsv[:, :, 0] / 255.0 * 360.0
    S = hsv[:, :, 1] / 255.0
    V = hsv[:, :, 2] / 255.0
    gray = np.asarray(img.convert("L"), dtype=float) / 255.0
    gy, gx = np.gradient(gray)
    edges = np.hypot(gx, gy)
    return img, H, S, V, edges


def circular_mean_deg(deg, weights):
    ang = np.radians(deg)
    w = weights + 1e-6
    x = float(np.sum(np.cos(ang) * w))
    y = float(np.sum(np.sin(ang) * w))
    return math.degrees(math.atan2(y, x)) % 360.0


def analyze_global(H, S, V):
    hue = circular_mean_deg(H.flatten(), S.flatten() ** 2)
    hue_idx = int(round(hue / 30.0)) % 12
    tonic_pc = (hue_idx * 7) % 12
    warmth = (math.cos(math.radians(hue)) + 1) / 2
    brightness = float(V.mean())
    mode_score = 0.55 * brightness + 0.45 * warmth
    mode = "major" if mode_score > 0.5 else "minor"
    return {"hue": hue, "warmth": warmth, "brightness": brightness,
            "tonic_pc": tonic_pc, "mode": mode, "mode_score": mode_score}


def brightest_point(V):
    """默认涟漪焦点：画面最亮处（粗网格上找，避免单像素噪声）。"""
    h, w = V.shape
    gw, gh = 32, max(4, int(32 * h / w))
    small = np.asarray(Image.fromarray((V * 255).astype(np.uint8)).resize((gw, gh)), dtype=float)
    iy, ix = np.unravel_index(int(small.argmax()), small.shape)
    return (ix + 0.5) / gw, (iy + 0.5) / gh


# ---------------- 扫描场 ----------------

class ScanField:
    """把扫描方式统一成标量场 F：小节/时值槽 = F 的分位带。"""

    def __init__(self, shape, scan="lr", focus=None):
        h, w = shape
        self.scan = scan
        self.shape = shape
        Y, X = np.mgrid[0:h, 0:w].astype(float)
        if scan == "lr":
            self.F = X
        elif scan == "tb":
            self.F = Y
        elif scan == "ripple":
            fx, fy = focus
            self.focus_px = (fx * w, fy * h)
            self.F = np.hypot(X - self.focus_px[0], Y - self.focus_px[1])
        else:
            raise ValueError(f"未知扫描方式 {scan}")
        self.Y, self.X = Y, X
        self._flat = self.F.flatten()

    def q(self, p):
        """F 的 p 分位数（p∈[0,1]）。"""
        return float(np.quantile(self._flat, min(1.0, max(0.0, p))))

    def band_mask(self, p0, p1):
        """分位带 [p0, p1) 的像素掩码。保证非空（碰上大片纯色时兜底）。"""
        a, b = self.q(p0), self.q(p1)
        if p1 >= 1.0:
            m = (self.F >= a)
        else:
            m = (self.F >= a) & (self.F < b)
        if not m.any():
            m = np.abs(self.F - a) <= np.abs(self.F - a).min() + 1e-9
        return m

    def bar_bounds(self, n_bars):
        """给标注/前端用的几何边界（原始场单位）。"""
        return [self.q(k / n_bars) for k in range(n_bars + 1)]


def analyze_bars(field, H, S, V, edges, n_bars):
    e_ref = np.percentile(edges, 95) + 1e-9
    bars = []
    for k in range(n_bars):
        m = field.band_mask(k / n_bars, (k + 1) / n_bars)
        bars.append({
            "hue": circular_mean_deg(H[m], S[m] ** 2),
            "sat": float(S[m].mean()),
            "val": float(V[m].mean()),
            "edge": float(min(1.0, edges[m].mean() / e_ref * 2.5)),
        })
    return bars


def slot_pitch_pos(field, mask, V):
    """时值槽的'高度'∈[0,1]（0=该出高音）。
    lr/ripple：亮度重心的纵向位置（旋律住在画面最亮处）；
    tb：扫描轴本身是 y，改用横向位置（右=高音，像钢琴键盘）。"""
    w2 = V[mask] ** 2
    tot = w2.sum()
    if tot < 1e-9:
        return 0.5
    if field.scan == "tb":
        cx = float((field.X[mask] * w2).sum() / tot) / max(1, field.shape[1] - 1)
        return 1.0 - cx
    cy = float((field.Y[mask] * w2).sum() / tot) / max(1, field.shape[0] - 1)
    return cy


# ---------------- 和弦 ----------------

def hue_diff_deg(a, b):
    return (a - b + 180) % 360 - 180


def compute_departures(bars, g):
    raw = []
    for s in bars:
        d_hue = abs(hue_diff_deg(s["hue"], g["hue"])) / 90.0
        d_val = abs(s["val"] - g["brightness"]) * 2.0
        d_sat = abs(s["sat"] - np.mean([x["sat"] for x in bars])) * 1.5
        raw.append(0.5 * min(1.0, d_hue) + 0.3 * min(1.0, d_val) + 0.2 * min(1.0, d_sat))
    order = np.argsort(np.argsort(raw))
    n = max(1, len(bars) - 1)
    return [float(r) / n for r in order]


def pick_chord(strip, g, bar_i, n_bars, departure, prev_chord):
    degrees = MAJOR_DEGREES if g["mode"] == "major" else MINOR_DEGREES
    families = FAMILIES_MAJOR if g["mode"] == "major" else FAMILIES_MINOR
    scale_root = g["tonic_pc"]

    if bar_i == 0:
        deg = degrees[0]
        reason = "第一小节：先在主和弦上安家，让耳朵知道'家'在哪"
    elif bar_i == n_bars - 1:
        deg = degrees[0]
        reason = "最后一小节：回到主和弦收束"
    elif bar_i % 4 == 3:
        fam_name, cands = families[2]
        deg = degrees[cands[0]]
        if prev_chord and deg[0] == prev_chord["degree"]:
            deg = degrees[cands[1]]
        reason = "第 4 小节位置：拉向属功能，制造'该回家了'的引力"
    else:
        tier = min(2, int(departure * 3))
        fam_name, cands = families[tier]
        side = 0 if hue_diff_deg(strip["hue"], g["hue"]) >= 0 else 1
        deg = degrees[cands[side]]
        if prev_chord and deg[0] == prev_chord["degree"]:
            deg = degrees[cands[1 - side]]
        reason = f"偏离全画基调 {departure:.2f}（0=最像基调）→ {fam_name}"

    name, interval, quality = deg
    root_pc = (scale_root + interval) % 12
    third = 4 if quality == "maj" else 3
    pcs = [root_pc, (root_pc + third) % 12, (root_pc + 7) % 12]
    label = PITCH_NAMES[root_pc] + ("m" if quality == "min" else "")

    tension = ""
    scale = MAJOR_SCALE if g["mode"] == "major" else MINOR_SCALE
    if strip["sat"] > 0.45:
        seventh = (root_pc + (11 if quality == "maj" and g["mode"] == "major" else 10)) % 12
        pcs.append(seventh)
        label += "7" if not (quality == "maj" and g["mode"] == "major") else "maj7"
        tension = "饱和度高 → 加 7 音"
    if strip["sat"] > 0.7:
        ninth = (root_pc + 2) % 12
        if (ninth - scale_root) % 12 in scale:
            pcs.append(ninth)
            label += "(9)"
            tension = "饱和度很高 → 加 7、9 音"

    octave = 4 if strip["val"] > 0.55 else 3
    notes = []
    base = 12 * (octave + 1) + root_pc
    prev = base
    for i, pc in enumerate(pcs):
        n = base if i == 0 else prev + ((pc - prev) % 12)
        notes.append(n)
        prev = n
    return {"label": label, "degree": name, "notes": notes, "reason": reason,
            "tension": tension, "pcs": pcs}


# ---------------- 旋律与贝斯 ----------------

def build_scale_pool(g, lo=48, hi=84):
    scale = MAJOR_SCALE if g["mode"] == "major" else MINOR_SCALE
    return [n for n in range(lo, hi + 1) if (n - g["tonic_pc"]) % 12 in scale]


def make_melody(field, bars, chords, g, V, rng, n_bars):
    pool = build_scale_pool(g)
    events = []
    prev_note = None
    for bar_i, (strip, chord) in enumerate(zip(bars, chords)):
        level = min(3, int(strip["edge"] * 4))
        template = RHYTHM_TEMPLATES[level]
        register_shift = int((strip["val"] - 0.5) * 14)
        for slot_i, (onset, dur) in enumerate(template):
            p0 = (bar_i + onset / 4) / n_bars
            p1 = (bar_i + min(4, onset + dur) / 4) / n_bars
            mask = field.band_mask(p0, p1)
            if float(V[mask].mean()) < 0.06:
                continue                                   # 近黑 = 休止
            cy = slot_pitch_pos(field, mask, V)
            cy = (cy - 0.5) * 1.8 + 0.5
            target = 76 - int(cy * 24) + register_shift
            cands = pool
            if slot_i == 0:
                cands = [n for n in pool if n % 12 in chord["pcs"][:3]] or pool
            note = min(cands, key=lambda n: abs(n - target))
            if prev_note is not None and abs(note - prev_note) > 7:
                pulled = [n for n in cands if abs(n - prev_note) <= 7]
                if pulled:
                    note = min(pulled, key=lambda n: abs(n - target))
            vel = int(58 + strip["sat"] * 40 + rng.integers(-5, 6))
            start = bar_i * 4 + onset + float(rng.normal(0, 0.008))
            events.append((max(0, start), dur * 0.92, note, max(30, min(110, vel))))
            prev_note = note
    return events


def make_bass(bars, chords, rng):
    events = []
    for bar_i, (strip, chord) in enumerate(zip(bars, chords)):
        root = chord["notes"][0] - 12
        if strip["edge"] > 0.5 and bar_i != len(bars) - 1:
            events.append((bar_i * 4, 2.8, root, 78))
            events.append((bar_i * 4 + 3, 0.9, root, 64))
        else:
            events.append((bar_i * 4, 3.9, root, 74))
    return events


def make_chord_events(chords):
    events = []
    for bar_i, chord in enumerate(chords):
        for n in chord["notes"]:
            events.append((bar_i * 4, 3.9, n, 52))
    return events


# ---------------- MIDI ----------------

def events_to_track(events, name, tempo_bpm, channel=0):
    track = mido.MidiTrack()
    track.append(mido.MetaMessage("track_name", name=name, time=0))
    track.append(mido.MetaMessage("set_tempo", tempo=mido.bpm2tempo(tempo_bpm), time=0))
    msgs = []
    for start, dur, note, vel in events:
        msgs.append((int(start * TICKS), "on", note, vel))
        msgs.append((int((start + dur) * TICKS), "off", note, 0))
    msgs.sort(key=lambda m: (m[0], m[1] == "on"))
    now = 0
    for t, kind, note, vel in msgs:
        delta = t - now
        now = t
        if kind == "on":
            track.append(mido.Message("note_on", note=note, velocity=vel, time=delta, channel=channel))
        else:
            track.append(mido.Message("note_off", note=note, velocity=0, time=delta, channel=channel))
    return track


def save_midi(path, tracks_events, tempo_bpm):
    mid = mido.MidiFile(ticks_per_beat=TICKS)
    for i, (name, events) in enumerate(tracks_events):
        mid.tracks.append(events_to_track(events, name, tempo_bpm, channel=i))
    mid.save(str(path))


# ---------------- 预听合成 ----------------

def synth_preview(parts, tempo_bpm, out_path, sr=22050):
    beat_sec = 60.0 / tempo_bpm
    total_beats = max((s + d) for evs in parts.values() for s, d, _, _ in evs) + 2
    buf = np.zeros(int(total_beats * beat_sec * sr))

    def add_note(start_b, dur_b, midi, vel, timbre):
        f = 440.0 * 2 ** ((midi - 69) / 12)
        n = int(dur_b * beat_sec * sr)
        if n < 8:
            return
        t = np.arange(n) / sr
        if timbre == "melody":
            w = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) + 0.12 * np.sin(6 * np.pi * f * t)
        elif timbre == "bass":
            w = np.sin(2 * np.pi * f * t) + 0.2 * np.sin(4 * np.pi * f * t)
        else:
            w = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
        att = max(8, int(0.012 * sr))
        env = np.ones(n)
        env[:att] = np.linspace(0, 1, att)
        env *= np.exp(-t / (dur_b * beat_sec * (0.9 if timbre == "chords" else 0.6)))
        gain = {"melody": 0.30, "chords": 0.10, "bass": 0.22}[timbre] * (vel / 100)
        a = int(start_b * beat_sec * sr)
        b = min(len(buf), a + n)
        buf[a:b] += (w * env)[: b - a] * gain

    for timbre, evs in parts.items():
        for s, d, m, v in evs:
            add_note(s, d, m, v, timbre)

    buf = buf / max(1e-9, np.abs(buf).max()) * 0.85
    pcm = (buf * 32767).astype(np.int16)
    with wave.open(str(out_path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())


# ---------------- 标注图与报告 ----------------

def annotate(img, field, chords, n_bars, out_path):
    im = img.copy()
    draw = ImageDraw.Draw(im, "RGBA")
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 15)
    except OSError:
        font = ImageFont.load_default()
    w, h = im.size
    bounds = field.bar_bounds(n_bars)

    def label_at(x, y, text, color=(125, 211, 252, 255)):
        tw = draw.textlength(text, font=font)
        x = max(2, min(w - tw - 6, x))
        y = max(2, min(h - 20, y))
        draw.rectangle([x - 3, y - 2, x + tw + 3, y + 16], fill=(10, 15, 26, 190))
        draw.text((x, y), text, fill=color, font=font)

    if field.scan == "lr":
        for i in range(n_bars):
            if i > 0:
                draw.line([(bounds[i], 0), (bounds[i], h)], fill=(255, 255, 255, 90), width=1)
            label_at((bounds[i] + bounds[i + 1]) / 2 - 14, 6, chords[i]["label"])
            label_at(bounds[i] + 4, h - 22, chords[i]["degree"], (251, 191, 36, 220))
    elif field.scan == "tb":
        for i in range(n_bars):
            if i > 0:
                draw.line([(0, bounds[i]), (w, bounds[i])], fill=(255, 255, 255, 90), width=1)
            label_at(6, (bounds[i] + bounds[i + 1]) / 2 - 8, chords[i]["label"])
            label_at(w - 40, (bounds[i] + bounds[i + 1]) / 2 - 8, chords[i]["degree"], (251, 191, 36, 220))
    else:  # ripple
        fx, fy = field.focus_px
        draw.ellipse([fx - 5, fy - 5, fx + 5, fy + 5], outline=(251, 191, 36, 255), width=2)
        for i in range(n_bars):
            r = bounds[i + 1]
            if i < n_bars - 1:
                draw.ellipse([fx - r, fy - r, fx + r, fy + r], outline=(255, 255, 255, 80), width=1)
            rm = (bounds[i] + bounds[i + 1]) / 2
            lx = fx + rm * 0.7071
            ly = fy + rm * 0.7071
            label_at(lx, ly, chords[i]["label"])
    im.save(str(out_path))


def write_report(path, image_name, g, bars, chords, tempo, seed, scan, focus):
    tonic = PITCH_NAMES[g["tonic_pc"]]
    mode_cn = "大调" if g["mode"] == "major" else "小调"
    scan_cn = SCAN_NAMES.get(scan, scan)
    focus_txt = f"，焦点 ({focus[0]:.2f}, {focus[1]:.2f})" if scan == "ripple" else ""
    lines = [
        f"# {image_name} 的召唤报告",
        "",
        f"- 扫描方式：**{scan_cn}**{focus_txt}（每小节读掉等量的颜料）",
        f"- 全画主色相：**{g['hue']:.0f}°**（饱和度加权，灰色不投票）",
        f"- 冷暖 {g['warmth']:.2f}、明度 {g['brightness']:.2f} → 调式判定分 {g['mode_score']:.2f}"
        f"（>0.5 大调）→ **{tonic} {mode_cn}**",
        f"- 速度 {tempo} BPM，共 {len(bars)} 小节，随机种子 {seed}",
        "",
        "## 逐小节",
        "",
        "| 小节 | 色相 | 饱和 | 明度 | 细节 | 和弦 | 级数 | 为什么 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for i, (s, c) in enumerate(zip(bars, chords)):
        why = c["reason"] + (("；" + c["tension"]) if c["tension"] else "")
        lines.append(
            f"| {i+1} | {s['hue']:.0f}° | {s['sat']:.2f} | {s['val']:.2f} "
            f"| {s['edge']:.2f} | **{c['label']}** | {c['degree']} | {why} |"
        )
    lines += [
        "",
        "## 五分钟乐理（这份报告用到的全部概念）",
        "",
        f"- **调 (Key)**：全曲的引力中心。这幅画是 {tonic} {mode_cn}，{tonic} 听起来最像'家'。",
        "- **音级和弦**：调内六个常用和弦，大调 I ii iii IV V vi，小调 i III iv v VI VII。"
        "大写=大和弦（亮），小写=小和弦（暗）。砖全来自同一个音阶，随便排都协和。",
        "- **属功能**：离家最远、最想回家的和弦；每 4 小节拉一次，就是终止式的引力。",
        "- **7 音 / 9 音**：往和弦上加盖，声音变复杂变湿润。饱和度高就多盖一层。",
        "- **和弦音 vs 经过音**：强拍踩和弦音（稳），弱拍可以踩音阶其他音（流动）。",
        "",
        "## 怎么用产物",
        "",
        "1. 听 `preview.wav`（粗糙合成，只为快速听结构）。",
        "2. 把三个 `.mid` 拖进 Logic 各配一个软件乐器 → 换音色（Gradient 时间）。",
        "3. Piano Roll 里改掉不顺耳的句子。算法给骨架，审美归你。",
    ]
    Path(path).write_text("\n".join(lines))


# ---------------- 主流程（CLI 与网页共用） ----------------

def summon(image_path, out_dir=None, bars=16, tempo=80, key=None, mode=None,
           seed=None, scan="lr", focus=None):
    image_path = Path(image_path)
    if seed is None:
        seed = int(hashlib.md5(image_path.read_bytes()).hexdigest()[:6], 16) % 10000
    rng = np.random.default_rng(seed)

    img, H, S, V, edges = load_image(str(image_path))
    g = analyze_global(H, S, V)
    if key:
        g["tonic_pc"] = PITCH_NAMES.index(key.upper())
    if mode:
        g["mode"] = mode

    if scan == "ripple" and focus is None:
        focus = brightest_point(V)
    field = ScanField(V.shape, scan=scan, focus=focus)

    bar_feats = analyze_bars(field, H, S, V, edges, bars)
    departures = compute_departures(bar_feats, g)
    chords = []
    for i, s in enumerate(bar_feats):
        prev = chords[-1] if chords else None
        chords.append(pick_chord(s, g, i, bars, departures[i], prev))
    melody = make_melody(field, bar_feats, chords, g, V, rng, bars)
    bass = make_bass(bar_feats, chords, rng)
    chord_events = make_chord_events(chords)

    out = Path(out_dir) if out_dir else Path(__file__).parent / "out" / image_path.stem
    out.mkdir(parents=True, exist_ok=True)

    save_midi(out / "melody.mid", [("melody", melody)], tempo)
    save_midi(out / "chords.mid", [("chords", chord_events)], tempo)
    save_midi(out / "bass.mid", [("bass", bass)], tempo)
    save_midi(out / "combined.mid",
              [("melody", melody), ("chords", chord_events), ("bass", bass)], tempo)
    synth_preview({"melody": melody, "chords": chord_events, "bass": bass},
                  tempo, out / "preview.wav")
    annotate(img, field, chords, bars, out / "annotated.png")
    write_report(out / "report.md", image_path.name, g, bar_feats, chords, tempo, seed, scan, focus)

    w, h = img.size
    bounds = field.bar_bounds(bars)
    if scan == "lr":
        geometry = {"type": "lr", "bounds": [b / w for b in bounds]}
    elif scan == "tb":
        geometry = {"type": "tb", "bounds": [b / h for b in bounds]}
    else:
        geometry = {"type": "ripple", "focus": list(focus),
                    "bounds": [b / w for b in bounds]}   # 半径按图宽归一

    return {
        "key": f"{PITCH_NAMES[g['tonic_pc']]} {'大调' if g['mode'] == 'major' else '小调'}",
        "mode_score": round(g["mode_score"], 3),
        "hue": round(g["hue"], 1),
        "tempo": tempo, "bars": bars, "seed": seed, "scan": scan,
        "chords": [{"label": c["label"], "degree": c["degree"]} for c in chords],
        "geometry": geometry,
        "out_dir": str(out),
    }


def main():
    ap = argparse.ArgumentParser(description="把一幅画召唤成 MIDI")
    ap.add_argument("image")
    ap.add_argument("--scan", choices=["lr", "tb", "ripple"], default="lr")
    ap.add_argument("--focus", type=str, default=None,
                    help="涟漪焦点，如 0.62,0.40（图宽高的比例）；默认取画面最亮处")
    ap.add_argument("--bars", type=int, default=16)
    ap.add_argument("--tempo", type=int, default=80)
    ap.add_argument("--key", type=str, default=None)
    ap.add_argument("--mode", choices=["major", "minor"], default=None)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", type=str, default=None)
    args = ap.parse_args()

    focus = None
    if args.focus:
        fx, fy = args.focus.split(",")
        focus = (float(fx), float(fy))

    r = summon(args.image, out_dir=args.out, bars=args.bars, tempo=args.tempo,
               key=args.key, mode=args.mode, seed=args.seed, scan=args.scan, focus=focus)
    print(f"召唤完成：{r['key']} · {r['tempo']} BPM · {r['bars']} 小节 · "
          f"扫描 {SCAN_NAMES[r['scan']]} · 种子 {r['seed']}")
    print(f"和弦进行：{' → '.join(c['label'] for c in r['chords'])}")
    print(f"产物在 {r['out_dir']}/")


if __name__ == "__main__":
    main()
