"""冒烟测试：不需要可选后端，验证"洞内被改、洞外逐位不变"。"""

from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bbox_inpaint import available_backends, inpaint_region  # noqa: E402


def make_image() -> np.ndarray:
    img = np.full((240, 320, 3), 200, np.uint8)
    img[160:, :] = 150                      # 下半部分是"地面"
    img[90:170, 120:190] = (40, 60, 200)    # 要抹掉的物体
    return img


class SmokeTest(unittest.TestCase):
    def test_telea_keeps_outside_untouched(self):
        img = make_image()
        r = inpaint_region(img, (120, 90, 70, 80), method="telea", dilate=6, feather=4, margin=1.0)
        x0, y0, x1, y1 = r["rect"]
        self.assertEqual(r["name"], "telea")
        self.assertGreater(r["ms"], 0)

        out, ref = r["image"], img[y0:y1, x0:x1]
        self.assertEqual(out.shape, ref.shape)

        # 返回块的边框必须与原图完全一致（前端才能无缝贴回去）
        border = np.concatenate([out[0], out[-1], out[:, 0], out[:, -1]])
        border_ref = np.concatenate([ref[0], ref[-1], ref[:, 0], ref[:, -1]])
        self.assertEqual(int(np.abs(border.astype(int) - border_ref.astype(int)).max()), 0)

        # 洞内确实被改了（换成 rect 内的局部坐标）
        cx, cy = 155 - x0, 130 - y0
        self.assertGreater(int(np.abs(out[cy, cx].astype(int) - ref[cy, cx].astype(int)).max()), 20)

    def test_window_shrinks_for_patchmatch(self):
        img = make_image()
        small = inpaint_region(img, (120, 90, 70, 80), method="telea", margin=3.0)
        self.assertLessEqual(small["rect"][2] - small["rect"][0], 320)

    def test_backends_probe(self):
        avail = available_backends()
        self.assertTrue(avail["telea"])
        self.assertTrue(avail["ns"])

    def test_export_full_size(self):
        img = make_image()
        from bbox_inpaint import inpaint

        out, used, _ms = inpaint(img, (120, 90, 70, 80), method="ns", margin=1.0)
        self.assertEqual(out.shape, img.shape)
        self.assertEqual(used, "ns")


if __name__ == "__main__":
    unittest.main()
