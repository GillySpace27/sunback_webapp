"""Per-date share card (MH-18): a branded 1200x630 JPEG of one day's Sun.

Pure Pillow, no network and no FastAPI, so the identity rules and the layout
can be checked offline (api/scripts/test_og_card.py). The route that fetches
the Helioviewer frame and calls compose_card lives in api/main.py.

The picture is a Helioviewer screenshot of the AIA channel, so it is a
visualization of that observation, not a calibrated radiance. NASA/SDO is
credited on the card itself.
"""
import io
import re
from datetime import date as _date

from PIL import Image, ImageDraw, ImageFont

CARD_W, CARD_H = 1200, 630
SDO_FIRST_LIGHT = "2010-05-15"
# Same set the store offers (api/main.py AIA_WAVELENGTHS, plus the 1700 tile).
WAVELENGTHS = (94, 131, 171, 193, 211, 304, 335, 1600, 1700)
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def parse_identity(d, t, wl, today=None):
    """Return (date_iso, 'HH:MM', wavelength) or None when any part is unusable.

    None means "serve the static card": a bad, pre-launch or future date never
    reaches Helioviewer and never becomes a cache key.
    """
    try:
        day = _date.fromisoformat(str(d))
        wave = int(wl)
    except (TypeError, ValueError):
        return None
    if wave not in WAVELENGTHS:
        return None
    t = (t or "12:00").strip()
    if not _TIME_RE.match(t):
        return None
    today = today or _date.today()
    if day < _date.fromisoformat(SDO_FIRST_LIGHT) or day > today:
        return None
    return day.isoformat(), t, wave


def _font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow older than 10.1 has no sized default font
        return ImageFont.load_default()


def compose_card(sun_bytes, date_iso, time_hhmm, wavelength):
    """Sun on the left over black, date and credit on the right. Returns JPEG bytes."""
    sun = Image.open(io.BytesIO(sun_bytes)).convert("RGB")
    card = Image.new("RGB", (CARD_W, CARD_H), (8, 8, 12))
    side = CARD_H
    sun = sun.resize((side, side), Image.LANCZOS)
    card.paste(sun, (0, 0))
    draw = ImageDraw.Draw(card)
    x = side + 48
    draw.text((x, 150), "My Heliogram", fill=(255, 190, 90), font=_font(54))
    draw.text((x, 240), "The Sun on", fill=(220, 220, 225), font=_font(34))
    draw.text((x, 284), date_iso, fill=(255, 255, 255), font=_font(58))
    draw.text((x, 370), f"{time_hhmm} UT, AIA {wavelength} A", fill=(200, 200, 205), font=_font(30))
    draw.text((x, 560), "Image: NASA/SDO (AIA)", fill=(150, 150, 158), font=_font(24))
    out = io.BytesIO()
    card.save(out, "JPEG", quality=85)
    return out.getvalue()


CERT_W, CERT_H = 1200, 1600


def compose_certificate(sun_bytes, date_iso, time_hhmm, wavelength, gloss="", observed=None):
    """MH-19: a 1200x1600 PNG that states what the picture is. Returns PNG bytes.

    Only facts the caller passes in; `observed` (the FITS DATE-OBS) is shown
    when known, otherwise the requested time is labelled as requested.
    """
    sun = Image.open(io.BytesIO(sun_bytes)).convert("RGB").resize((1080, 1080), Image.LANCZOS)
    page = Image.new("RGB", (CERT_W, CERT_H), (12, 12, 16))
    page.paste(sun, (60, 150))
    d = ImageDraw.Draw(page)
    d.text((60, 50), "My Heliogram", fill=(255, 190, 90), font=_font(56))
    d.text((60, 1260), f"The Sun on {date_iso}", fill=(255, 255, 255), font=_font(54))
    lines = [f"SDO / AIA {wavelength} A" + (f": {gloss}" if gloss else "")]
    if observed:
        lines.append("Observed " + observed.replace("T", " ").replace("Z", " UT"))
    else:
        lines.append(f"Requested {date_iso} {time_hhmm} UT (nearest available frame)")
    lines += ["Image: NASA/SDO, AIA science team.",
              "Shown as a visualization, not a calibrated radiance."]
    y = 1350
    for ln in lines:
        d.text((60, y), ln, fill=(200, 200, 205), font=_font(30))
        y += 50
    out = io.BytesIO()
    page.save(out, "PNG")
    return out.getvalue()
