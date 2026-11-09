"""命令行入口：python -m bbox_inpaint.cli in.jpg 800,400,240,180 out.png"""

from __future__ import annotations

import argparse

import cv2

from .core import BACKENDS, inpaint, parse_bbox


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="bbox_inpaint",
        description="按 bbox 做轻量图像修复（Telea / NS / Biharmonic / PatchMatch）",
    )
    ap.add_argument("image", nargs="?", help="输入图片路径")
    ap.add_argument("bbox", nargs="?", help="x,y,w,h （左上角 + 宽高，像素）")
    ap.add_argument("out", nargs="?", help="输出图片路径")
    ap.add_argument("--method", default="auto", choices=["auto", *BACKENDS])
    ap.add_argument("--dilate", type=int, default=6, help="mask 外扩像素，防留边（默认 6）")
    ap.add_argument("--feather", type=int, default=4, help="羽化半径，防接缝（默认 4）")
    ap.add_argument("--margin", type=float, default=1.5, help="取参考上下文的窗口倍数（默认 1.5）")
    ap.add_argument("--mask", default="rect", choices=["rect", "grabcut"], help="mask 形状")
    ap.add_argument("--list", action="store_true", help="只打印可用后端并退出")
    return ap


def main(argv=None) -> int:
    a = build_parser().parse_args(argv)

    if a.list:
        from .core import available_backends

        for name, ok in available_backends().items():
            print(f"{name:12s} {'可用' if ok else '未安装（跳过）'}")
        return 0

    missing = [k for k in ("image", "bbox", "out") if not getattr(a, k)]
    if missing:
        build_parser().error(f"缺少参数: {', '.join(missing)}（用法见 -h）")

    img = cv2.imread(a.image, cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"读不到图片: {a.image}")

    bbox = parse_bbox(a.bbox)
    out, used, ms = inpaint(img, bbox, a.method, a.dilate, a.feather, a.margin, a.mask)
    cv2.imwrite(a.out, out)
    print(f"method={used}  {ms:.1f} ms  bbox={bbox}  -> {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
