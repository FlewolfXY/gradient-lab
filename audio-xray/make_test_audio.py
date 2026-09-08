"""合成一段 64 秒、带明显段落结构的测试音频，用来验证分析管线。
结构：pad 独奏 → +低音 → +节奏 → 高潮(全开+高频) → 回落。
"""
import numpy as np
import soundfile as sf

SR = 22050
BPM = 100
BEAT = 60 / BPM


def note_hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)


def adsr(n, a=0.02, r=0.1):
    env = np.ones(n)
    na, nr = int(a * SR), int(r * SR)
    if na > 0:
        env[:na] = np.linspace(0, 1, na)
    if nr > 0:
        env[-nr:] = np.linspace(1, 0, nr)
    return env


def tone(freq, dur, kind="sine", harmonics=1):
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for h in range(1, harmonics + 1):
        y += np.sin(2 * np.pi * freq * h * t) / h
    return y * adsr(n)


total = 64.0
y = np.zeros(int(total * SR))


def add(sig, at, gain=1.0):
    a = int(at * SR)
    if a >= len(y):
        return
    b = min(len(y), a + len(sig))
    y[a:b] += sig[: b - a] * gain


# 和弦进行 Am - F - C - G，每和弦 2 小节 (8 拍)
CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]

sec = 0.0
chord_i = 0
while sec < total - 0.1:
    chord = CHORDS[chord_i % 4]
    dur = 8 * BEAT
    # pad：全程都在
    for m in chord:
        add(tone(note_hz(m + 12), dur, harmonics=3), sec, 0.08)
    # 低音：16s 后进入
    if sec >= 16:
        for k in range(8):
            add(tone(note_hz(chord[0] - 12), BEAT * 0.9, harmonics=2), sec + k * BEAT, 0.22)
    # 节奏（噪声打点）：32s 后进入
    if sec >= 32:
        for k in range(8):
            n = int(0.05 * SR)
            burst = np.random.randn(n) * np.linspace(1, 0, n) ** 3
            add(burst, sec + k * BEAT, 0.25 if k % 2 == 0 else 0.12)
    # 高潮：40—56s，加高八度旋律 + 明亮泛音
    if 40 <= sec < 56:
        melody = [chord[2] + 24, chord[1] + 24, chord[0] + 24, chord[1] + 24]
        for k, m in enumerate(melody):
            add(tone(note_hz(m), BEAT * 1.8, harmonics=6), sec + k * 2 * BEAT, 0.15)
    sec += dur
    chord_i += 1

# 结尾 8s 淡出
fade = int(8 * SR)
y[-fade:] *= np.linspace(1, 0, fade)
y = y / max(1e-9, np.abs(y).max()) * 0.85
sf.write("test_song.wav", y, SR)
print(f"OK test_song.wav {total}s")
