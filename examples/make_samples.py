#!/usr/bin/env python3
"""生成示例图（纯合成，无版权/隐私问题）。

    python examples/make_samples.py

会覆盖 examples/ 下的 demo_*.png，方便直接试「打开示例」。
"""

from __future__ import annotations

import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def _noise(h, w, scale=0.0, amp=0.0):
    """低频噪声，给平坦区域一点质感，避免算法"填空"得太假。"""
    if amp <= 0:
        return np.zeros((h, w, 1), np.float32)
    small = np.random.default_rng(7).normal(0, 1, (max(2, int(h * scale)), max(2, int(w * scale)))).astype(np.float32)
    big = cv2.resize(small, (w, h), interpolation=cv2.INTER_CUBIC)
    return (big[..., None] * amp)


def demo_wall() -> np.ndarray:
    """白墙 + 海报 + 地面上的小瓶子：典型"去掉前景物体"场景。"""
    h, w = 384, 512
    yy = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    base = np.array([236, 238, 240], np.float32) * (1 - yy * 0.18)
    img = np.repeat(base, w, axis=1) + _noise(h, w, 0.05, 6)

    # 墙面/地面分界
    floor_y = int(h * 0.72)
    img[floor_y:] = np.array([196, 190, 184], np.float32) + _noise(h - floor_y, w, 0.08, 5)
    cv2.line(img, (0, floor_y), (w, floor_y), (176, 172, 168), 1)

    # 海报（斜一点，避免全是正矩形）
    poster = np.array([168, 96, 46], np.float32) + _noise(150, 110, 0.2, 8)  # BGR：蓝色海报
    cv2.rectangle(poster, (8, 8), (101, 141), (140, 74, 32), -1)
    cv2.rectangle(poster, (18, 22), (92, 40), (238, 236, 232), -1)
    cv2.rectangle(poster, (18, 54), (72, 62), (222, 224, 230), -1)
    cv2.rectangle(poster, (18, 72), (84, 80), (222, 224, 230), -1)
    cv2.rectangle(poster, (18, 90), (60, 98), (222, 224, 230), -1)
    _paste(img, poster, (120, 40))

    # 地面上的瓶子
    bottle = np.zeros((86, 34, 3), np.float32) + np.array([210, 160, 90], np.float32)
    cv2.rectangle(bottle, (6, 26), (27, 84), (200, 150, 78), -1)
    cv2.rectangle(bottle, (12, 10), (21, 27), (170, 130, 70), -1)
    cv2.ellipse(bottle, (17, 26), (11, 5), 0, 0, 360, (150, 120, 60), -1)
    _paste(img, bottle, (392, 246))

    # 绿植
    # 花盆 + 几片叶子
    cv2.rectangle(img, (452, 300), (492, 340), (70, 92, 120), -1)
    rng = np.random.default_rng(3)
    for i in range(26):
        cx = int(rng.integers(440, 504))
        cy = int(rng.integers(228, 306))
        g = int(rng.integers(120, 170))
        cv2.ellipse(img, (cx, cy), (int(rng.integers(4, 9)), int(rng.integers(2, 4))),
                    float(rng.integers(0, 180)), 0, 360, (int(g * 0.45), g, int(g * 0.5)), -1)
    return np.clip(img, 0, 255).astype(np.uint8)


def demo_floor() -> np.ndarray:
    """地板 + 散落线缆：纹理延续能力（PatchMatch）的对照场景。"""
    h, w = 384, 512
    rng = np.random.default_rng(11)
    img = np.zeros((h, w, 3), np.float32) + np.array([120, 128, 122], np.float32)
    img += _noise(h, w, 0.02, 10)
    for _ in range(90):  # 地板砖块随机色斑
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        cv2.circle(img, (x, y), int(rng.integers(10, 45)),
                   tuple(float(v) for v in rng.integers(90, 150, 3)), -1)
    img = cv2.GaussianBlur(img, (0, 0), 1.2)

    # 一条麻花线缆
    pts = np.array([[60, 300], [180, 262], [300, 300], [420, 250], [500, 292]], np.int32)
    cv2.polylines(img, [pts], False, (28, 30, 34), 9, cv2.LINE_AA)
    cv2.polylines(img, [pts], False, (60, 62, 68), 4, cv2.LINE_AA)

    # 一个小盒子
    box = np.zeros((54, 66, 3), np.float32) + np.array([70, 90, 190], np.float32)
    cv2.rectangle(box, (2, 2), (63, 51), (40, 60, 160), -1)
    cv2.putText(box, "BOX", (8, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (230, 235, 245), 2, cv2.LINE_AA)
    _paste(img, box, (300, 150))
    return np.clip(img, 0, 255).astype(np.uint8)


def demo_flat() -> np.ndarray:
    """纯色墙面 + 一张小贴纸：规则方法的舒适区。"""
    h, w = 288, 384
    yy = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
    img = np.array([205, 208, 212], np.float32) * (1 - yy * 0.12)
    img = np.repeat(img, w, axis=1) + _noise(h, w, 0.06, 4)
    sticker = np.zeros((76, 76, 3), np.float32) + np.array([60, 60, 235], np.float32)
    cv2.circle(sticker, (38, 38), 33, (50, 50, 225), -1)
    cv2.circle(sticker, (38, 38), 20, (235, 240, 250), -1)
    _paste(img, sticker, (150, 100))
    return np.clip(img, 0, 255).astype(np.uint8)


def _paste(dst: np.ndarray, patch: np.ndarray, at: tuple[int, int]) -> None:
    x, y = at
    ph, pw = patch.shape[:2]
    h, w = dst.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(w, x + pw), min(h, y + ph)
    dst[y0:y1, x0:x1] = patch[y0 - y:y1 - y, x0 - x:x1 - x]


def main() -> None:
    for name, fn in (("demo_wall", demo_wall), ("demo_floor", demo_floor), ("demo_flat", demo_flat)):
        out = os.path.join(HERE, f"{name}.png")
        cv2.imwrite(out, fn())
        print("wrote", out)


if __name__ == "__main__":
    main()