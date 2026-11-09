#!/usr/bin/env python3
"""Inpaint Studio —— 交互式 bbox inpainting 对比工具（本地网页应用）。

零第三方依赖：只用 Python 标准库 + opencv-python（numpy 随 opencv 一起装）。
biharmonic / patchmatch 为可选后端，装了就自动启用。

启动：
    python3 web/server.py                 # 默认 http://127.0.0.1:8788
    python3 web/server.py --port 9000
    python3 web/server.py --samples ~/pics  # 换掉"工作区示例"的目录
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import threading
import uuid
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(ROOT)
STATIC = os.path.join(ROOT, "static")
sys.path.insert(0, REPO)

from bbox_inpaint import BACKENDS, available_backends, inpaint_region  # noqa: E402

# ---------------------------------------------------------------- 图片缓存
_LOCK = threading.Lock()
_IMAGES: "OrderedDict[str, dict]" = OrderedDict()
_MAX_IMAGES = 6
SAMPLES_DIR = os.path.join(REPO, "examples")   # 可用 --samples 覆盖
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


def put_image(name: str, img: np.ndarray) -> str:
    iid = uuid.uuid4().hex[:12]
    with _LOCK:
        _IMAGES[iid] = {"name": name, "img": img}
        while len(_IMAGES) > _MAX_IMAGES:
            _IMAGES.popitem(last=False)
    return iid


def get_image(iid: str) -> dict:
    with _LOCK:
        rec = _IMAGES.get(iid)
        if rec is None:
            raise KeyError("图片会话已过期，请重新打开")
        _IMAGES.move_to_end(iid)
        return rec


def b64png(img: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    if not ok:
        raise RuntimeError("PNG 编码失败")
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode()


def mask_overlay(win: np.ndarray, mask: np.ndarray) -> np.ndarray:
    m = mask > 0
    out = win.copy()
    if m.any():
        red = np.zeros_like(win)
        red[..., 2] = 255
        out[m] = (0.6 * win[m] + 0.4 * red[m]).astype(np.uint8)
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(out, cnts, -1, (0, 255, 255), 2)
    return out


def scan_samples():
    out = []
    if not os.path.isdir(SAMPLES_DIR):
        return out
    for base, _dirs, files in os.walk(SAMPLES_DIR):
        for f in sorted(files):
            if f.lower().endswith(IMAGE_EXT):
                p = os.path.join(base, f)
                out.append({"label": f, "path": os.path.relpath(p, SAMPLES_DIR)})
        if len(out) > 40:
            break
    return out


def resolve_sample(rel: str) -> str:
    root = os.path.abspath(SAMPLES_DIR)
    p = os.path.abspath(os.path.join(root, rel))
    if not p.startswith(root + os.sep) or not p.lower().endswith(IMAGE_EXT):
        raise ValueError("非法路径")
    return p


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "InpaintStudio/1.0"
    protocol_version = "HTTP/1.1"

    # -- helpers ---------------------------------------------------------
    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode())

    def _err(self, code, msg):
        self._json({"error": msg}, code)

    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _json_body(self) -> dict:
        raw = self._read_body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def log_message(self, fmt, *args):  # 静音，只打印启动信息
        pass

    # -- routes ----------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        p = unquote(u.path)
        try:
            if p in ("/", "/index.html"):
                return self._serve_file(os.path.join(STATIC, "index.html"), "text/html; charset=utf-8")
            if p.startswith("/static/"):
                name = p[len("/static/"):]
                if "/" in name or name.startswith("."):
                    return self._err(400, "bad path")
                ctype = {
                    ".css": "text/css; charset=utf-8",
                    ".js": "application/javascript; charset=utf-8",
                    ".png": "image/png", ".svg": "image/svg+xml",
                }.get(os.path.splitext(name)[1], "application/octet-stream")
                return self._serve_file(os.path.join(STATIC, name), ctype)
            if p == "/api/methods":
                return self._json({
                    "available": available_backends(),
                    "defaults": {"telea": {"radius": 3}, "ns": {"radius": 3},
                                 "patchmatch": {"patch_size": 5}, "biharmonic": {}},
                })
            if p == "/api/samples":
                return self._json({"samples": scan_samples()})
            if p == "/api/image":
                q = parse_qs(u.query)
                rec = get_image((q.get("id") or [""])[0])
                ok, buf = cv2.imencode(".jpg", rec["img"], [cv2.IMWRITE_JPEG_QUALITY, 92])
                if not ok:
                    raise ValueError("编码失败")
                return self._send(200, buf.tobytes(), "image/jpeg")
            return self._err(404, "not found")
        except Exception as e:  # noqa: BLE001
            return self._err(500, f"{type(e).__name__}: {e}")

    def _serve_file(self, path, ctype):
        if not os.path.isfile(path):
            return self._err(404, "missing file")
        with open(path, "rb") as f:
            return self._send(200, f.read(), ctype)

    def do_POST(self):
        p = urlparse(self.path).path
        try:
            if p == "/api/upload":
                return self._upload()
            if p == "/api/open":
                return self._open()
            if p == "/api/inpaint":
                return self._inpaint()
            if p == "/api/export":
                return self._export()
            return self._err(404, "not found")
        except ValueError as e:
            return self._err(400, str(e))
        except KeyError as e:
            return self._err(410, str(e).strip("'\""))
        except Exception as e:  # noqa: BLE001
            return self._err(500, f"{type(e).__name__}: {e}")

    # -- api -------------------------------------------------------------
    def _upload(self):
        q = parse_qs(urlparse(self.path).query)
        name = (q.get("name") or ["upload"])[0]
        body = self._read_body()
        img = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("无法解码这张图片")
        iid = put_image(name, img)
        return self._json({"id": iid, "w": img.shape[1], "h": img.shape[0], "name": name})

    def _open(self):
        body = self._json_body()
        path = resolve_sample(body["path"])
        img = cv2.imread(path, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("读不到这张图片")
        iid = put_image(os.path.basename(path), img)
        return self._json({"id": iid, "w": img.shape[1], "h": img.shape[0],
                           "name": os.path.basename(path)})

    def _inpaint(self):
        body = self._json_body()
        rec = get_image(body["id"])
        bbox = tuple(int(v) for v in body["bbox"])
        if bbox[2] < 2 or bbox[3] < 2:
            raise ValueError("bbox 太小")
        method = body.get("method", "telea")
        r = inpaint_region(
            rec["img"], bbox, method,
            dilate=int(body.get("dilate", 6)),
            feather=int(body.get("feather", 4)),
            margin=float(body.get("margin", 1.5)),
            mask_mode=body.get("mask_mode", "rect"),
            method_params=body.get("params") or {},
        )
        x0, y0, x1, y1 = r["rect"]
        # 只回传真正被改动的区域（mask 外 alpha=0，像素与原图相同），省 3~4 倍带宽
        bx, by, bw, bh = bbox
        pad = int(body.get("dilate", 6)) + 6 * int(body.get("feather", 4)) + 8
        cx0, cy0 = max(x0, bx - pad), max(y0, by - pad)
        cx1, cy1 = min(x1, bx + bw + pad), min(y1, by + bh + pad)
        core = r["image"][cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
        mslice = r["mask"][cy0 - y0:cy1 - y0, cx0 - x0:cx1 - x0]
        return self._json({
            "method": r["name"], "ms": round(r["ms"], 2), "note": r["note"],
            "rect": [cx0, cy0, cx1, cy1],
            "png": b64png(core),
            "mask_png": b64png(mask_overlay(rec["img"][cy0:cy1, cx0:cx1], mslice)),
        })

    def _export(self):
        body = self._json_body()
        rec = get_image(body["id"])
        img = rec["img"]
        bbox = tuple(int(v) for v in body["bbox"])
        r = inpaint_region(
            img, bbox, body.get("method", "telea"),
            dilate=int(body.get("dilate", 6)),
            feather=int(body.get("feather", 4)),
            margin=float(body.get("margin", 1.5)),
            mask_mode=body.get("mask_mode", "rect"),
            method_params=body.get("params") or {},
        )
        x0, y0, x1, y1 = r["rect"]
        full = img.copy()
        full[y0:y1, x0:x1] = r["image"]
        base = os.path.splitext(rec["name"])[0]
        return self._json({"png": b64png(full), "method": r["name"],
                           "name": f"{base}-{r['name']}.png"})


def warmup():
    """预热可选后端：首次 import skimage / patchmatch 要几秒，提前付掉。"""
    img = np.zeros((240, 240, 3), np.uint8)
    img[:] = 180
    img[70:150, 80:160] = 40
    avail = available_backends()
    for name in BACKENDS:
        if not avail.get(name):
            continue
        try:
            inpaint_region(img, (90, 80, 60, 60), name, dilate=4, feather=3, margin=1.0)
        except Exception as e:  # noqa: BLE001
            print("  warmup failed:", name, e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--samples", default=None, help="示例图目录（默认仓库下的 examples/）")
    a = ap.parse_args()

    global SAMPLES_DIR
    if a.samples:
        SAMPLES_DIR = os.path.abspath(os.path.expanduser(a.samples))
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    avail = available_backends()
    print(f"Inpaint Studio  ->  http://{a.host}:{a.port}")
    print("backends:", ", ".join(k if v else f"{k}(未安装,自动跳过)" for k, v in avail.items()))
    threading.Thread(target=warmup, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()