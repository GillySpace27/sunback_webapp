#!/usr/bin/env python3
"""Generate the co-registered image pair for the landing before/after slider.

Usage:
    python3 api/scripts/make_compare_pair.py [raw_full.png] [rhef_full.png]

Inputs default to /tmp/ar2192_{raw,rhef}_full.png — the same AR 2192 frames the
quality-strip diptych is rendered from (fetch them from
https://myheliograph.com/asset/default/vibe/ar2192/{raw,rhef}_full.png).

Outputs two 900x900 webps into infra/data_mirror/mirror/default_cache/:
    compare_raw.webp   — sqrt-brightened raw (matches the baked-thumb and
                         diptych "Original" convention, see PR #26 history)
    compare_rhef.webp  — the RHEF frame as-is

Both come from the SAME source framing, so the slider divider lines up
pixel-for-pixel. Keep total size well under 300 KB — these ship as edge
static assets on the landing page.
"""
import os
import sys

import numpy as np
from PIL import Image

SIZE = 900
QUALITY = 78

def main() -> int:
    raw_in = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ar2192_raw_full.png"
    rhef_in = sys.argv[2] if len(sys.argv) > 2 else "/tmp/ar2192_rhef_full.png"
    out_dir = os.path.join(os.path.dirname(__file__), "..", "..",
                           "infra", "data_mirror", "mirror", "default_cache")
    out_dir = os.path.abspath(out_dir)
    if not os.path.isdir(out_dir):
        print(f"ERROR: mirror dir not found: {out_dir}")
        return 1

    raw = Image.open(raw_in).convert("RGB")
    rhef = Image.open(rhef_in).convert("RGB")
    if raw.size != rhef.size:
        print(f"ERROR: sources are not co-registered: {raw.size} vs {rhef.size}")
        return 1

    # Original = sqrt-brightened raw, the same stretch baked into the vibe
    # thumbs and the diptych, so the slider agrees with the rest of the site.
    a = np.asarray(raw).astype(np.float32) / 255.0
    raw_bright = Image.fromarray(
        (np.sqrt(a) * 255).round().clip(0, 255).astype(np.uint8), "RGB")

    total = 0
    for name, im in (("compare_raw.webp", raw_bright), ("compare_rhef.webp", rhef)):
        path = os.path.join(out_dir, name)
        im.resize((SIZE, SIZE), Image.LANCZOS).save(
            path, "WEBP", quality=QUALITY, method=6)
        kb = os.path.getsize(path) // 1024
        total += kb
        print(f"  {name}: {kb} KB")
    print(f"total: {total} KB {'OK' if total < 300 else 'OVER BUDGET'}")
    return 0 if total < 300 else 1

if __name__ == "__main__":
    sys.exit(main())
