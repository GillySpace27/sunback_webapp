"""Pin the share-card identity rules and layout (MH-18).

Run: python3 api/scripts/test_og_card.py
Offline: no network, no Helioviewer. The route itself is UNCHECKED here.
"""
import io
import sys
from datetime import date
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api.og_card import CARD_H, CARD_W, compose_card, parse_identity  # noqa: E402

TODAY = date(2026, 10, 15)
ok = lambda *a: parse_identity(*a, today=TODAY)  # noqa: E731

assert ok("2026-10-01", "12:00", 193) == ("2026-10-01", "12:00", 193)
assert ok("2026-10-01", None, "171") == ("2026-10-01", "12:00", 171), "time defaults, wl may be a string"
assert ok("2010-01-01", "12:00", 193) is None, "before SDO first light"
assert ok("2026-10-16", "12:00", 193) is None, "future date"
assert ok("2026-10-01", "12:00", 999) is None, "unknown wavelength"
assert ok("2026-10-01", "25:00", 193) is None, "bad time"
assert ok("2026-10-01", "12:00\" onload=x", 193) is None, "no injection through the time"
assert ok("not-a-date", "12:00", 193) is None
assert ok("", "12:00", 193) is None

src = io.BytesIO()
Image.new("RGB", (630, 630), (200, 120, 20)).save(src, "PNG")
jpg = compose_card(src.getvalue(), "2026-10-01", "12:00", 193)
im = Image.open(io.BytesIO(jpg))
assert im.format == "JPEG" and im.size == (CARD_W, CARD_H) == (1200, 630), im.size
r, g, b = im.getpixel((300, 300))
assert r > 150 and b < 90, "the Sun image sits on the left"
print("test_og_card: ok")
