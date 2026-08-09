"""Server-side print compositor — phase 1 of moving checkout off the
browser round trip.

Today the browser downloads the 4096² integrated render, draws the user's
edits onto a canvas, exports a lossless PNG and uploads it back as base64.
That payload measured 41.7 MB on a real order and 413'd against Printify's
POST limit. The pixels already live on this server, so shipping them to the
browser and back to be decorated is pure waste.

This module reproduces the geometry and colour stages of the editor's
`renderCanvas` (api/solar-archive.js) so the print file can be produced
here from a few hundred bytes of parameters.

SCOPE (phase 1): geometry (product aspect, zoom, pan, rotation, flips),
colour (invert, brightness, contrast, saturation, hue), vignette, crop-edge
feather, circular clip, background fill. TEXT OVERLAY IS DELIBERATELY OUT —
canvas text metrics and font hinting will not match a server rasteriser
without work that has to be proven, and a caption 3 px out of place on a
$69 metal print is a refund. The caller keeps the browser upload path for
text orders; `supports_params()` is the single source of truth for which
side handles a given order.

FIDELITY: every formula below is transcribed from renderCanvas, including
the exact contrast factor, the YIQ hue matrix, the smoothstep ramps and the
0.2989/0.587/0.114 luma weights. The one thing that cannot match bit-for-bit
is the resampling kernel in the draw step (browser bilinear vs PIL); at 4096²
that difference is sub-pixel. api/scripts/test_print_compose.py pins the
formulas against hand-computed values.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np
from PIL import Image

# Parameters whose non-default presence means the browser must do the work.
_CLIENT_ONLY_KEYS = ("textOverlay", "timestampStamp", "dualPanel")


def supports_params(params: dict) -> bool:
    """True when this module can produce the print file for `params`.

    Conservative by construction: anything unrecognised or out of scope
    sends the order down the existing browser-upload path rather than
    risking a print that does not match what the customer approved."""
    if not isinstance(params, dict):
        return False
    if params.get("textOverlay"):
        return False
    if params.get("timestampStamp"):
        return False
    if params.get("dualPanel"):
        return False
    # Clock numerals are drawn by the editor, not here.
    if params.get("clockNumbers"):
        return False
    return True


def _smoothstep(t: np.ndarray) -> np.ndarray:
    return t * t * (3.0 - 2.0 * t)


def _hex_rgb(value: Optional[str], default=(0, 0, 0)):
    try:
        h = (value or "").lstrip("#")
        if len(h) != 6:
            return default
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except Exception:
        return default


def _canvas_size(src_w: int, src_h: int, rotation: int, aspect: Optional[dict]):
    """Frame size before the HQ scale bump — mirrors renderCanvas's
    refCW/refCH → cw/ch derivation."""
    rotated = (rotation % 180) != 0
    ref_cw = src_h if rotated else src_w
    ref_ch = src_w if rotated else src_h
    cw, ch = ref_cw, ref_ch
    if aspect and aspect.get("w") and aspect.get("h"):
        ratio = float(aspect["w"]) / float(aspect["h"])
        if ratio >= ref_cw / ref_ch:
            cw = ref_cw
            ch = max(1, int(ref_cw / ratio))
        else:
            ch = ref_ch
            cw = max(1, int(ref_ch * ratio))
    return int(cw), int(ch), int(ref_cw), int(ref_ch)


def compose(src_path: str, params: dict, out_path: str) -> str:
    """Render the print file. Returns `out_path`.

    `params` uses the editor's own state names so the client can pass its
    state through without a translation layer that could drift.
    """
    src = Image.open(src_path).convert("RGBA")
    src_w, src_h = src.size

    rotation = int(params.get("rotation") or 0)
    aspect = params.get("aspectRatio") or None
    cw, ch, ref_cw, ref_ch = _canvas_size(src_w, src_h, rotation, aspect)

    zoom = float(params.get("cropZoom") or 100) / 100.0
    pan_x = params.get("panX")
    pan_y = params.get("panY")
    pan_x = (ref_cw / 2.0) if pan_x is None else float(pan_x)
    pan_y = (ref_ch / 2.0) if pan_y is None else float(pan_y)
    flip_h = bool(params.get("flipH"))
    flip_v = bool(params.get("flipV"))

    # ── Geometry ──────────────────────────────────────────────────────
    # renderCanvas builds this transform (canvas ops apply in reverse of
    # the source-code order):
    #   translate(cw/2, ch/2) · scale(zoom) · translate(-panX,-panY)
    #   · translate(refCW/2, refCH/2) · rotate · scale(flip)
    #   · translate(-refCW/2, -refCH/2)
    # then draws the image cover-scaled into the refCW×refCH box.
    # We invert it and sample, which is exact for affine maps.
    scale_img = max(ref_cw / src_w, ref_ch / src_h)
    draw_w = src_w * scale_img
    draw_h = src_h * scale_img
    off_x = (ref_cw - draw_w) / 2.0
    off_y = (ref_ch - draw_h) / 2.0

    theta = math.radians(rotation)
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    sx = -1.0 if flip_h else 1.0
    sy = -1.0 if flip_v else 1.0

    # Forward: src px -> canvas px. Build as matrix, then invert for PIL's
    # AFFINE transform (which maps output -> input).
    def mat_mul(a, b):
        return (
            a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2],
            a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5],
        )

    m = (1, 0, cw / 2.0, 0, 1, ch / 2.0)                 # translate(cw/2, ch/2)
    m = mat_mul(m, (zoom, 0, 0, 0, zoom, 0))              # scale(zoom)
    m = mat_mul(m, (1, 0, -pan_x, 0, 1, -pan_y))          # translate(-pan)
    m = mat_mul(m, (1, 0, ref_cw / 2.0, 0, 1, ref_ch / 2.0))
    m = mat_mul(m, (cos_t, -sin_t, 0, sin_t, cos_t, 0))   # rotate
    m = mat_mul(m, (sx, 0, 0, 0, sy, 0))                  # flip
    m = mat_mul(m, (1, 0, -ref_cw / 2.0, 0, 1, -ref_ch / 2.0))
    m = mat_mul(m, (1, 0, off_x, 0, 1, off_y))            # draw offset
    m = mat_mul(m, (scale_img, 0, 0, 0, scale_img, 0))    # cover scale

    det = m[0] * m[4] - m[1] * m[3]
    if abs(det) < 1e-12:
        raise ValueError("degenerate transform")
    inv = (
        m[4] / det, -m[1] / det, (m[1] * m[5] - m[2] * m[4]) / det,
        -m[3] / det, m[0] / det, (m[2] * m[3] - m[0] * m[5]) / det,
    )
    canvas = src.transform((cw, ch), Image.AFFINE, inv,
                           resample=Image.BICUBIC, fillcolor=(0, 0, 0, 0))

    arr = np.asarray(canvas).astype(np.float64)
    r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]

    # ── Colour, in renderCanvas's order ───────────────────────────────
    if params.get("inverted"):
        r, g, b = 255.0 - r, 255.0 - g, 255.0 - b

    br = float(params.get("brightness") or 0)
    if br:
        r, g, b = r + br, g + br, b + br

    co = float(params.get("contrast") or 0) / 100.0
    if co:
        factor = (259.0 * (co * 255.0 + 255.0)) / (255.0 * (259.0 - co * 255.0))
        r = factor * (r - 128.0) + 128.0
        g = factor * (g - 128.0) + 128.0
        b = factor * (b - 128.0) + 128.0

    sat = float(params.get("saturation", 100) if params.get("saturation") is not None else 100) / 100.0
    if sat != 1.0:
        gray = 0.2989 * r + 0.587 * g + 0.114 * b
        r = gray + sat * (r - gray)
        g = gray + sat * (g - gray)
        b = gray + sat * (b - gray)

    hue_deg = float(params.get("hue") or 0)
    if hue_deg % 360 != 0:
        hc, hs = math.cos(math.radians(hue_deg)), math.sin(math.radians(hue_deg))
        hrr = 0.213 + 0.787 * hc - 0.213 * hs
        hrg = 0.715 - 0.715 * hc - 0.715 * hs
        hrb = 0.072 - 0.072 * hc + 0.928 * hs
        hgr = 0.213 - 0.213 * hc + 0.143 * hs
        hgg = 0.715 + 0.285 * hc + 0.140 * hs
        hgb = 0.072 - 0.072 * hc - 0.283 * hs
        hbr = 0.213 - 0.213 * hc - 0.787 * hs
        hbg = 0.715 - 0.715 * hc + 0.715 * hs
        hbb = 0.072 + 0.928 * hc + 0.072 * hs
        r, g, b = (hrr * r + hrg * g + hrb * b,
                   hgr * r + hgg * g + hgb * b,
                   hbr * r + hbg * g + hbb * b)

    is_circular = bool(params.get("printShape") == "circle"
                       or params.get("productId") == "wall_clock")
    fade_mode = params.get("vignetteFade") or "transparent"
    fade_rgb = _hex_rgb(params.get("vignetteFadeColor"), (0, 0, 0))
    if fade_mode == "black":
        fade_rgb = (0, 0, 0)
    elif fade_mode == "white":
        fade_rgb = (255, 255, 255)
    elif fade_mode == "mode":
        fade_rgb = (int(params.get("vignetteModeR") or 0),
                    int(params.get("vignetteModeG") or 0),
                    int(params.get("vignetteModeB") or 0))

    def _apply_fade(t):
        nonlocal r, g, b, a
        if fade_mode == "transparent":
            a = a * (1.0 - t)
        else:
            fr, fg, fb = fade_rgb
            r = r * (1.0 - t) + fr * t
            g = g * (1.0 - t) + fg * t
            b = b * (1.0 - t) + fb * t

    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float64)

    vig = float(params.get("vignette") or 0)
    if vig > 0:
        cx, cy = cw / 2.0, ch / 2.0
        max_r = (min(cw, ch) / 2.0) if is_circular else math.sqrt(cx * cx + cy * cy)
        vig_r = max_r * (1.0 - (vig / 100.0) * 0.9)
        width_factor = float(params.get("vignetteWidth") or 0) / 100.0
        dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
        fade_len = (max_r - vig_r) * width_factor
        t = np.zeros_like(dist)
        outside = dist > vig_r
        if fade_len > 0.5:
            t[outside] = np.minimum((dist[outside] - vig_r) / fade_len, 1.0)
        else:
            t[outside] = 1.0
        _apply_fade(_smoothstep(t))

    fx = float(params.get("cropEdgeFeatherX") or 0)
    fy = float(params.get("cropEdgeFeatherY") or 0)
    if fx > 0 or fy > 0:
        e_tx = np.zeros((ch, cw))
        e_ty = np.zeros((ch, cw))
        if fx > 0:
            w_x = (fx / 100.0) * (cw * 0.25)
            if w_x > 0:
                d_x = np.minimum(xx, (cw - 1) - xx)
                raw = np.clip(1.0 - (d_x / w_x), 0.0, 1.0)
                e_tx = _smoothstep(raw)
        if fy > 0:
            w_y = (fy / 100.0) * (ch * 0.25)
            if w_y > 0:
                d_y = np.minimum(yy, (ch - 1) - yy)
                raw = np.clip(1.0 - (d_y / w_y), 0.0, 1.0)
                e_ty = _smoothstep(raw)
        _apply_fade(np.maximum(e_tx, e_ty))

    if is_circular:
        # The browser does clearRect + drawImage(clipped), which leaves
        # fully-transparent BLACK outside the disc. Zeroing only alpha and
        # keeping the RGB underneath looks identical on screen but produces
        # different bytes, and anything downstream that ignores alpha (a
        # flattener, a proofing tool) would show the ghost. Match exactly.
        circ_r = min(cw, ch) / 2.0
        dist = np.sqrt((xx - cw / 2.0) ** 2 + (yy - ch / 2.0) ** 2)
        # One-pixel coverage ramp at the rim, matching the canvas clip's
        # antialiasing. A hard cut left a visible stair-step against the
        # browser's smooth edge on round products.
        cov = np.clip(circ_r + 0.5 - dist, 0.0, 1.0)
        a = a * cov
        r, g, b = r * cov, g * cov, b * cov

    out = np.clip(np.stack([r, g, b, a], axis=-1), 0, 255).astype(np.uint8)
    img = Image.fromarray(out, mode="RGBA")

    # Background fill for transparent areas — matches renderCanvas's
    # "fill any pixel with alpha < 10" pass. "transparent" leaves alpha.
    bg = params.get("background")
    if bg and bg != "transparent":
        bg_rgb = {"black": (0, 0, 0), "white": (255, 255, 255)}.get(bg, _hex_rgb(bg, (0, 0, 0)))
        flat = Image.new("RGBA", img.size, bg_rgb + (255,))
        flat.alpha_composite(img)
        img = flat

    img.save(out_path, "PNG", optimize=False)
    return out_path
