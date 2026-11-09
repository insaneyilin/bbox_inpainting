"""bbox_inpaint —— 基于 bbox 的轻量图像修复（规则方法为主）。"""

from .core import (  # noqa: F401
    BACKENDS,
    REGION_LIMITS,
    available_backends,
    build_mask,
    grabcut_mask,
    inpaint,
    inpaint_region,
    parse_bbox,
    pick_method,
)

__version__ = "0.1.0"
__all__ = [
    "BACKENDS", "REGION_LIMITS", "available_backends", "build_mask", "grabcut_mask",
    "inpaint", "inpaint_region", "parse_bbox", "pick_method", "__version__",
]
