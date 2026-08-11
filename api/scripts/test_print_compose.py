"""Pin the server-side print compositor's formulas.

Run: python3 api/scripts/test_print_compose.py

These are unit checks against hand-computed values — they catch a
transcription error in the colour maths or the geometry. They do NOT prove
the server matches the browser; that is what
api/scripts/compare_print_compose.mjs does, by rendering the same params in
a real canvas and diffing. Run both before trusting this path with an order.
"""
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api.print_compose import compose, supports_params  # noqa: E402

tmp = Path(tempfile.mkdtemp())


def _src(w=64, h=64, colour=(120, 60, 30, 255)):
    p = tmp / f"src_{w}x{h}_{colour[0]}.png"
    Image.new("RGBA", (w, h), colour).save(p)
    return str(p)


def _out(name):
    return str(tmp / name)


def _px(path, x, y):
    return Image.open(path).convert("RGBA").getpixel((x, y))


# ── scope gate ────────────────────────────────────────────────────────
assert supports_params({}) is True
assert supports_params({"textOverlay": {"text": "hi"}}) is False, "text must go to the browser"
assert supports_params({"timestampStamp": True}) is False
assert supports_params({"dualPanel": True}) is False
assert supports_params(None) is False

# ── identity: no edits, square aspect → unchanged colour ──────────────
src = _src()
o = compose(src, {}, _out("identity.png"))
assert _px(o, 32, 32) == (120, 60, 30, 255), _px(o, 32, 32)

# ── canvas takes the product aspect ───────────────────────────────────
o = compose(src, {"aspectRatio": {"w": 11, "h": 14}}, _out("aspect.png"))
w, h = Image.open(o).size
assert (w, h) == (50, 64), (w, h)          # 64 * 11/14 = 50.28 -> 50
o = compose(src, {"aspectRatio": {"w": 2250, "h": 1650}}, _out("aspect_ls.png"))
w, h = Image.open(o).size
assert (w, h) == (64, 46), (w, h)          # 64 / (2250/1650) = 46.9 -> 46

# ── brightness is a plain additive offset ─────────────────────────────
o = compose(src, {"brightness": 20}, _out("bright.png"))
assert _px(o, 32, 32)[:3] == (140, 80, 50), _px(o, 32, 32)

# ── contrast uses renderCanvas's exact factor ─────────────────────────
co = 50 / 100
factor = (259 * (co * 255 + 255)) / (255 * (259 - co * 255))
expect = tuple(int(np.clip(round(factor * (c - 128) + 128), 0, 255)) for c in (120, 60, 30))
o = compose(src, {"contrast": 50}, _out("contrast.png"))
got = _px(o, 32, 32)[:3]
assert all(abs(a - b) <= 1 for a, b in zip(got, expect)), (got, expect)

# ── saturation 0 collapses to the 0.2989/0.587/0.114 luma ─────────────
o = compose(src, {"saturation": 0}, _out("gray.png"))
gray = round(0.2989 * 120 + 0.587 * 60 + 0.114 * 30)
got = _px(o, 32, 32)[:3]
assert all(abs(c - gray) <= 1 for c in got), (got, gray)

# ── invert ────────────────────────────────────────────────────────────
o = compose(src, {"inverted": True}, _out("invert.png"))
assert _px(o, 32, 32)[:3] == (135, 195, 225), _px(o, 32, 32)

# ── hue 0 is a no-op; hue 360 likewise ────────────────────────────────
for deg in (0, 360):
    o = compose(src, {"hue": deg}, _out(f"hue{deg}.png"))
    assert _px(o, 32, 32)[:3] == (120, 60, 30), (deg, _px(o, 32, 32))

# ── vignette (transparent) clears the corners, keeps the centre ───────
o = compose(src, {"vignette": 80, "vignetteWidth": 50}, _out("vig.png"))
assert _px(o, 32, 32)[3] == 255, "centre must stay opaque"
assert _px(o, 0, 0)[3] == 0, "corner must fade out"

# ── circular products clip to the inscribed circle ────────────────────
o = compose(src, {"printShape": "circle"}, _out("circ.png"))
assert _px(o, 32, 32)[3] == 255
assert _px(o, 1, 1)[3] == 0, "outside the disc must be transparent"

# ── background fill replaces transparency when asked ──────────────────
o = compose(src, {"printShape": "circle", "background": "black"}, _out("circ_bg.png"))
assert _px(o, 1, 1) == (0, 0, 0, 255), _px(o, 1, 1)

# ── zoom magnifies: a centred stripe doubles in width at 2x ───────────
stripe = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
stripe.paste(Image.new("RGBA", (8, 64), (0, 0, 255, 255)), (28, 0))  # x 28..35
sp = tmp / "stripe.png"
stripe.save(sp)


def _stripe_width(path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    row = [im.getpixel((x, h // 2)) for x in range(w)]
    # blue-dominant, not pure blue: bicubic blends the stripe edges, and a
    # strict test would under-count by one pixel per edge.
    return sum(1 for p in row if p[2] > p[0])


w1 = _stripe_width(compose(str(sp), {}, _out("z1.png")))
w2 = _stripe_width(compose(str(sp), {"cropZoom": 200}, _out("z2.png")))
assert abs(w1 - 8) <= 1, f"1x stripe should be ~8 px, got {w1}"
assert abs(w2 - 16) <= 2, f"2x stripe should be ~16 px, got {w2}"

# ── pan shifts the frame ──────────────────────────────────────────────
# Moving the pan point right means the content slides left.
base = compose(str(sp), {}, _out("pan0.png"))
panned = compose(str(sp), {"panX": 48}, _out("pan1.png"))


def _stripe_centre(path):
    im = Image.open(path).convert("RGBA")
    w, h = im.size
    xs = [x for x in range(w) if im.getpixel((x, h // 2))[2] > im.getpixel((x, h // 2))[0]]
    return sum(xs) / len(xs) if xs else None


c0, c1 = _stripe_centre(base), _stripe_centre(panned)
assert c0 is not None and c1 is not None, (c0, c1)
assert c1 < c0 - 10, f"panning right must move content left ({c0} -> {c1})"

# ── flips actually mirror ─────────────────────────────────────────────
off = Image.new("RGBA", (64, 64), (255, 0, 0, 255))
off.paste(Image.new("RGBA", (12, 64), (0, 0, 255, 255)), (0, 0))  # blue on the LEFT
op = tmp / "offset.png"
off.save(op)
assert _px(compose(str(op), {}, _out("noflip.png")), 5, 32)[2] > 200, "unflipped: blue on left"
assert _px(compose(str(op), {"flipH": True}, _out("flip.png")), 58, 32)[2] > 200, \
    "flipH must move blue to the right"

print("print-compose formula self-check OK")
