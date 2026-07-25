#!/usr/bin/env python3
"""Bake the sqrt display stretch into committed vibe RAW thumbnails.

The vibe RAW frames are stored linearly, so at card size they read dim next to
the RHEF frame. sqrt is the standard AIA display stretch (Gilly, 2026-07-24);
we bake it into the committed 256² raw_thumb.png so the gallery is bright with
ZERO runtime cost and no per-frame client work. RHEF thumbs are left alone
(already contrast-stretched). NOT median-normalized — that read garish.

Run ONCE after pulling fresh thumbs off the Fly volume (they come out linear):

    python3 infra/scripts/bake_raw_thumb_sqrt.py

NOT idempotent and deliberately NOT wired into build-public.sh — running it
twice would sqrt twice (too bright). The committed PNGs are the source of
truth; git history holds the pre-bake originals.

sqrt is applied on the stored 8-bit sRGB values (value/255 -> sqrt -> *255),
which is pixel-identical to the SVG feComponentTransfer gamma-0.5 filter used
for arbitrary (non-committed) dates — verified in-browser, mean diff 0.00.
"""
import glob
import os
import sys

import numpy as np
from PIL import Image

MIRROR = os.path.join(
    os.path.dirname(__file__), "..", "data_mirror", "mirror", "default_cache", "vibe"
)


def bake(path: str) -> None:
    im = Image.open(path)
    had_alpha = im.mode in ("RGBA", "LA", "P") and "A" in im.convert("RGBA").getbands()
    rgb = np.asarray(im.convert("RGB")).astype(np.float32) / 255.0
    out = Image.fromarray((np.sqrt(rgb) * 255.0).round().clip(0, 255).astype(np.uint8), "RGB")
    if had_alpha:
        alpha = im.convert("RGBA").split()[-1]
        if alpha.getextrema() != (255, 255):  # a real mask, not fully opaque
            out = out.convert("RGBA")
            out.putalpha(alpha)
    out.save(path)


def main() -> int:
    files = sorted(glob.glob(os.path.join(MIRROR, "*", "raw_thumb.png")))
    if not files:
        print("no raw_thumb.png found under %s" % MIRROR)
        return 1
    for f in files:
        bake(f)
    print("baked sqrt into %d raw thumbnails" % len(files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
