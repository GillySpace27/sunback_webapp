#!/usr/bin/env python3
"""Generate the co-registered image pair for the landing before/after slider.

Usage:
    python3 api/scripts/make_compare_pair.py [jpg_hq.png] [raw_full.png] [rhef_full.png]

Inputs default to /tmp/ar2192_{jpg_hq,raw,rhef}_full.png — the same AR 2192
frames the quality-strip diptych is rendered from (fetch them from
https://myheliograph.com/asset/default/vibe/ar2192/{jpg_hq,raw_full,rhef_full}.png).

Outputs two 900x900 webps into infra/data_mirror/mirror/default_cache/:
    compare_raw.webp   — the Helioviewer JPG ("Original") the same way customers
                         browse it on the vibe grid, but REGISTERED into the FITS
                         frame so its solar limb lines up with the RHEF pane.
    compare_rhef.webp  — the RHEF frame as-is

Why the JPG and not sqrt(raw): the vibe grid shows Helioviewer JPGs, so the
before/after "Original" has to match what people have already been looking at
(bright disk on black), not a sqrt-stretched raw FITS with an off-disk noise
halo. The JPG has a different plate scale, so we detect the solar limb in the
JPG and in raw_full (rhef_full has no sharp limb — it's equalized — but shares
raw_full's FITS framing) and scale the JPG about frame-centre so both limbs
coincide. Result: the slider divider lines up pixel-for-pixel on the disk.

Keep total size well under 300 KB — these ship as edge static assets.
"""
import os
import sys

import numpy as np
from PIL import Image

SIZE = 900
QUALITY = 78


def _limb_radius(im):
    """Solar limb radius in pixels, from the sharpest negative radial gradient
    of the azimuthally-averaged brightness. Assumes a centred full disk."""
    a = np.asarray(im.convert("L"), dtype=np.float32)
    n = a.shape[0]
    c = (n - 1) / 2.0
    yy, xx = np.mgrid[0:n, 0:n]
    r = np.sqrt((xx - c) ** 2 + (yy - c) ** 2).astype(int)
    prof = np.bincount(r.ravel(), a.ravel()) / np.maximum(np.bincount(r.ravel()), 1)
    ps = np.convolve(prof, np.ones(15) / 15, "same")
    g = np.gradient(ps)
    lo, hi = int(0.45 * n / 2), int(0.99 * n / 2)
    return lo + int(np.argmin(g[lo:hi]))


def main() -> int:
    jpg_in = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ar2192_jpg_hq.png"
    raw_in = sys.argv[2] if len(sys.argv) > 2 else "/tmp/ar2192_raw_full.png"
    rhef_in = sys.argv[3] if len(sys.argv) > 3 else "/tmp/ar2192_rhef_full.png"
    out_dir = os.path.join(os.path.dirname(__file__), "..", "..",
                           "infra", "data_mirror", "mirror", "default_cache")
    out_dir = os.path.abspath(out_dir)
    if not os.path.isdir(out_dir):
        print(f"ERROR: mirror dir not found: {out_dir}")
        return 1

    jpg = Image.open(jpg_in).convert("RGB")
    raw = Image.open(raw_in).convert("RGB")
    rhef = Image.open(rhef_in).convert("RGB")
    if raw.size != rhef.size:
        print(f"ERROR: raw/rhef are not co-registered: {raw.size} vs {rhef.size}")
        return 1

    # Register the Helioviewer JPG into the FITS frame so its limb matches
    # rhef's (== raw's, same FITS WCS). Pure centre-scale — both are centred
    # full disks. Scale the JPG so its limb radius equals raw's, then centre-
    # crop/pad to the FITS frame size.
    n_fits = raw.size[0]
    r_target = _limb_radius(raw)
    r_jpg = _limb_radius(jpg)
    scale = r_target / float(r_jpg)
    new = int(round(jpg.size[0] * scale))
    jpg_big = jpg.resize((new, new), Image.LANCZOS)
    canvas = Image.new("RGB", (n_fits, n_fits), (0, 0, 0))
    off = (n_fits - new) // 2          # negative -> PIL crops, staying centred
    canvas.paste(jpg_big, (off, off))
    r_check = _limb_radius(canvas)
    if abs(r_check - r_target) > 0.02 * n_fits:
        print(f"WARN: registered limb {r_check} off target {r_target} "
              f"(>2% of frame) — check inputs are centred full disks")

    total = 0
    for name, im in (("compare_raw.webp", canvas), ("compare_rhef.webp", rhef)):
        path = os.path.join(out_dir, name)
        im.resize((SIZE, SIZE), Image.LANCZOS).save(
            path, "WEBP", quality=QUALITY, method=6)
        kb = os.path.getsize(path) // 1024
        total += kb
        print(f"  {name}: {kb} KB")
    print(f"registered JPG limb {r_check}px -> raw limb {r_target}px "
          f"(scale {scale:.3f})")
    print(f"total: {total} KB {'OK' if total < 300 else 'OVER BUDGET'}")
    return 0 if total < 300 else 1


if __name__ == "__main__":
    sys.exit(main())
