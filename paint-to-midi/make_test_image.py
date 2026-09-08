"""合成一张测试画：冷蓝雾渐变 + 一枚暖色心洞光点 + 右侧细节噪点。
模拟她的画面语言，用来验证映射管线（开发用）。
"""
import numpy as np
from PIL import Image

W, H = 960, 540
rng = np.random.default_rng(7)

x = np.linspace(0, 1, W)[None, :]
y = np.linspace(0, 1, H)[:, None]

# 底：深蓝到雾蓝的渐变，左暗右稍亮
r = 18 + 40 * x + 10 * (1 - y)
g = 30 + 70 * x + 25 * (1 - y)
b = 55 + 110 * x + 40 * (1 - y)

# 中景雾团
for cx, cy, rad, amp in [(0.35, 0.45, 0.25, 30), (0.6, 0.3, 0.2, 25), (0.8, 0.55, 0.3, 20)]:
    d2 = ((x - cx) ** 2 + (y - cy) ** 2) / rad ** 2
    glow = amp * np.exp(-d2)
    r += glow * 0.6; g += glow * 0.9; b += glow

# 暖色心洞光点（2/3 处）
d2 = ((x - 0.68) ** 2 + (y - 0.5) ** 2) / 0.045 ** 2
heart = np.exp(-d2)
r += heart * 200; g += heart * 150; b += heart * 60

# 右侧细节噪点（羽毛/枝条质感 → 节奏密度）
noise = rng.normal(0, 1, (H, W))
mask = (x > 0.55) * 18
r += noise * mask * 0.8; g += noise * mask; b += noise * mask * 1.1

img = np.stack([r, g, b], axis=2).clip(0, 255).astype(np.uint8)
Image.fromarray(img).save("test_painting.png")
print("OK test_painting.png")
