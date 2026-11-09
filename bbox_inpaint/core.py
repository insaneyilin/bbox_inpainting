"""按 bbox 做轻量图像修复（inpainting）的核心实现。

只依赖 numpy + opencv-python；可选后端：
  - biharmonic  需要 scikit-image
  - patchmatch  需要 PyPatchMatch

主入口是 inpaint_region()：给一张图和一个 bbox，返回"被改动的小块"以及用了哪个后端、耗时。
CLI 见 bbox_inpaint.cli，网页界面见 web/server.py。

bbox 格式: x,y,w,h （左上角 + 宽高，像素）
"""
from __future__ import annotations

import time

import cv2
import numpy as np


# ---------------------------------------------------------------- mask 构造
def parse_bbox(s: str) -> tuple[int, int, int, int]:
    parts = [int(p) for p in s.replace(" ", "").split(",")]
    if len(parts) != 4:
        raise SystemExit("bbox 需要 4 个数: x,y,w,h")
    return parts[0], parts[1], parts[2], parts[3]


def grabcut_mask(img: np.ndarray, bbox: tuple[int, int, int, int]) -> np.ndarray:
    """用 bbox 作为初始框跑 GrabCut，尝试只框住物体、少删背景。

    注意：GrabCut 在低对比/模糊图上很不可靠（可能把物体判成背景、或跑到框外）。
    这里的做法是加一道 sanity check，结果离谱就自动退回整矩形。
    """
    x, y, w, h = bbox
    mask = np.zeros(img.shape[:2], np.uint8)
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(img, mask, (x, y, w, h), bgd, fgd, 3, cv2.GC_INIT_WITH_RECT)
    m = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)

    total = float((m > 0).sum())
    inside = float((m[y:y + h, x:x + w] > 0).sum())
    ok = total > 0 and inside / total > 0.8 and inside / (w * h) > 0.05
    if not ok:  # 分割结果不可信 -> 退回整矩形，宁可多删一点也不毁图
        m[:] = 0
        m[y:y + h, x:x + w] = 255
    return m


def build_mask(shape, bbox, dilate: int, mask_mode: str, img=None) -> np.ndarray:
    if mask_mode == "grabcut":
        m = grabcut_mask(img, bbox)
    else:
        x, y, w, h = bbox
        m = np.zeros(shape[:2], np.uint8)
        m[max(0, y):y + h, max(0, x):x + w] = 255
    if dilate > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate + 1, 2 * dilate + 1))
        m = cv2.dilate(m, k)
    return m


# ---------------------------------------------------------------- 各种后端
def _telea(img, mask, radius=3, **_):
    return cv2.inpaint(img, mask, int(radius), cv2.INPAINT_TELEA)


def _ns(img, mask, radius=3, **_):
    return cv2.inpaint(img, mask, int(radius), cv2.INPAINT_NS)


def _biharmonic(img, mask, **_):
    from skimage.restoration import inpaint_biharmonic

    out = inpaint_biharmonic(img.astype(np.float64) / 255.0, mask > 0, channel_axis=-1)
    return np.clip(out * 255, 0, 255).astype(np.uint8)


def _patchmatch(img, mask, patch_size=6, **_):
    import patchmatch as pm

    return pm.inpaint(img.astype(np.uint8), (mask > 0).astype(np.uint8), patch_size=int(patch_size))


BACKENDS = {
    "telea": _telea,
    "ns": _ns,
    "biharmonic": _biharmonic,
    "patchmatch": _patchmatch,
}


def _available(name: str) -> bool:
    """可选后端没装就自动降级，不让整个流程挂掉。"""
    try:
        if name == "biharmonic":
            import skimage  # noqa: F401
        elif name == "patchmatch":
            import patchmatch  # noqa: F401
        return True
    except Exception:
        return False


def pick_method(img, mask) -> str:
    """规则化选路：看洞占比 + 洞周围的边缘强度。"""
    hole = float((mask > 0).mean())
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    ring = cv2.dilate(mask, np.ones((25, 25), np.uint8)) & ~mask
    edge = float(np.abs(cv2.Laplacian(gray, cv2.CV_32F)[ring > 0]).mean()) if ring.any() else 0.0
    if hole < 0.01 and edge < 12:
        return "ns"                                    # 小洞 + 平坦背景：PDE 扩散，最快
    if hole < 0.10 and edge < 12 and _available("biharmonic"):
        return "biharmonic"                            # 较大洞 + 平滑渐变：双调和方程
    if _available("patchmatch"):
        return "patchmatch"                            # 有纹理/结构：样本块合成
    return "ns" if edge < 12 else "telea"              # 兜底：总能跑的两个基线


# 不同后端能接受的上下文窗口上限（像素）。PatchMatch 成本随窗口线性涨，必须收紧。
REGION_LIMITS = {"telea": 2_000_000, "ns": 2_000_000, "biharmonic": 1_500_000,
                 "patchmatch": 500_000, "auto": 2_000_000}


# ---------------------------------------------------------------- 主流程
def inpaint_region(img, bbox, method="auto", dilate=6, feather=4, margin=1.5,
                   mask_mode="rect", method_params=None):
    """按 bbox 修复，只返回受影响的小窗口（Web 端逐方法请求用这个，省带宽）。

    返回 dict: name / ms / rect=(x0,y0,x1,y1) / image(窗口内结果 BGR) / mask(窗口内 mask) / note
    """
    params = method_params or {}
    m_full = build_mask(img.shape, bbox, dilate, mask_mode, img)
    if m_full.max() == 0:
        raise ValueError("mask 为空，检查 bbox 是否落在图像内")

    x, y, w, h = bbox
    H, W = img.shape[:2]
    # 关键：只处理 bbox 附近的窗口，而不是整图缩放 —— 保住高频细节、也更快
    mx, my = int(w * margin) + dilate, int(h * margin) + dilate
    # 窗口太大时收缩上下文：保证交互/批量场景的响应速度
    LIMIT = REGION_LIMITS.get(method, 3_000_000)
    while (mx > 24 or my > 24) and \
            (min(W, x + w + mx) - max(0, x - mx)) * (min(H, y + h + my) - max(0, y - my)) > LIMIT:
        mx, my = int(mx * 0.8), int(my * 0.8)
    x0, y0 = max(0, x - mx), max(0, y - my)
    x1, y1 = min(W, x + w + mx), min(H, y + h + my)
    win = img[y0:y1, x0:x1].copy()
    mask = m_full[y0:y1, x0:x1]

    note = ""
    name = pick_method(win, mask) if method == "auto" else method
    if name not in BACKENDS:
        raise ValueError(f"未知 method: {name}，可选 {list(BACKENDS)} 或 auto")

    t0 = time.perf_counter()
    try:
        rec = BACKENDS[name](win, mask, **params)
    except ImportError as e:
        note = f"{name} 不可用（{e}），降级到 telea"
        name = "telea"
        rec = BACKENDS[name](win, mask)
    ms = (time.perf_counter() - t0) * 1000

    # 羽化合成，避免硬边接缝
    if feather > 0:
        alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), feather * 2 + 0.5)
        alpha[alpha < 0.5 / 255] = 0.0        # 羽化尾巴截断：保证远处像素与原图逐位相同
        alpha = np.clip(alpha, 0, 1)[..., None]
    else:
        alpha = (mask > 0).astype(np.float32)[..., None]
    out = np.clip(win.astype(np.float32) * (1 - alpha) + np.asarray(rec, np.float32) * alpha, 0, 255)

    return {"name": name, "ms": ms, "rect": (x0, y0, x1, y1),
            "image": out.astype(np.uint8), "mask": mask, "note": note}


def available_backends() -> dict[str, bool]:
    """各后端是否可用（未安装的可选依赖返回 False，调用时会自动跳过）。"""
    return {name: _available(name) for name in BACKENDS}


def inpaint(img: np.ndarray, bbox, method="auto", dilate=6, feather=4, margin=2.0,
            mask_mode="rect", method_params=None):
    """整图版本（CLI / 导出用）。"""
    r = inpaint_region(img, bbox, method, dilate, feather, margin, mask_mode, method_params)
    x0, y0, x1, y1 = r["rect"]
    result = img.copy()
    result[y0:y1, x0:x1] = r["image"]
    return result, r["name"], r["ms"]

__all__ = [
    "BACKENDS", "REGION_LIMITS", "parse_bbox", "build_mask", "grabcut_mask",
    "available_backends", "pick_method", "inpaint_region", "inpaint",
]
