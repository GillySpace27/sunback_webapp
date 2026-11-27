"""cart_permalink discount windows (T14). Run: python3 api/scripts/test_holiday_cart_code.py"""
import os, sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from api.shopify_storefront import cart_permalink, holiday_discount_code

D = ZoneInfo("America/Denver")
BASE = "/cart/123:1"


def at(*a):
    return datetime(*a, tzinfo=D)


cases = [
    (at(2026, 11, 26, 23, 59, 59), None),
    (at(2026, 11, 27, 0, 0, 0), "SOLARFLARE20"),
    (at(2026, 11, 29, 23, 59, 59), "SOLARFLARE20"),
    (at(2026, 11, 30, 0, 0, 0), "CYBERSUN20"),
    (at(2026, 12, 4, 23, 59, 59), "CYBERSUN20"),
    (at(2026, 12, 5, 0, 0, 0), None),
]
for now, code in cases:
    url = cart_permalink("123", 1, now=now)
    assert holiday_discount_code(now) == code, (now, holiday_discount_code(now))
    if code is None:
        assert url.endswith(BASE) and "?" not in url, url
    else:
        assert url.endswith(BASE + "?discount=" + code), url
# A UTC instant that is still Dec 4 in Denver (Dec 5 06:59:59 UTC) is inside.
assert holiday_discount_code(datetime(2026, 12, 5, 6, 59, 59, tzinfo=ZoneInfo("UTC"))) == "CYBERSUN20"
assert holiday_discount_code(datetime(2026, 12, 5, 7, 0, 0, tzinfo=ZoneInfo("UTC"))) is None
print("test_holiday_cart_code: ok")
