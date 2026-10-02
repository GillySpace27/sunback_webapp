#!/usr/bin/env python3
"""Self-check for /api/health's disk_pct (MH-6).

Run: python3 api/scripts/test_health_disk_pct.py

The outside probe alerts at 80 percent, so disk_pct must be reported at every level,
not only from the 85 percent warning up. The "warning" key stays gated at _DISK_WARN_PCT.
"""
import asyncio
import json
import os
import sys
import tempfile

_d = tempfile.mkdtemp(prefix="health-test-")
os.environ["SOLAR_ARCHIVE_OUTPUT_DIR"] = os.path.join(_d, "output")
os.environ["FEEDBACK_DATA_DIR"] = os.path.join(_d, "data")
os.makedirs(os.environ["SOLAR_ARCHIVE_OUTPUT_DIR"], exist_ok=True)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("SOLAR_ARCHIVE_SKIP_HEAVY_IMPORTS", "1")

import api.main as m  # noqa: E402


def health(pct):
    saved = m._disk_used_pct
    m._disk_used_pct = lambda path=None: pct
    try:
        resp = asyncio.run(m.api_health())
    finally:
        m._disk_used_pct = saved
    return json.loads(resp.body)


def test_disk_pct_is_reported_below_the_warning_level():
    body = health(12.4)
    # MH-10 added a "config" key beside these two, so compare the two keys, not the whole body.
    assert body["status"] == "ok" and body["disk_pct"] == 12 and "warning" not in body, body


def test_no_warning_just_below_the_threshold():
    body = health(84.4)
    assert body["disk_pct"] == 84 and "warning" not in body, body


def test_the_warning_still_appears_at_the_threshold():
    body = health(85.0)
    assert body["disk_pct"] == 85 and body["warning"] == "disk nearly full", body


def test_status_ok_is_unchanged_when_the_disk_is_full():
    assert health(99.0)["status"] == "ok"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok  %s" % name)
    print("all health disk_pct checks passed")
