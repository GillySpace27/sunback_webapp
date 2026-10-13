"""Self-check for infra/scripts/hq_retest.py (MH-5).

Run: python3 api/scripts/test_hq_retest.py

No network: the HTTP layer, the clock and the sleep are fakes. Pins: the script
renders on dev only, a cache hit is flagged as not a render, a 503 "server is
busy" is recorded as a failure with its text, a timeout is a failure, and the
record file is append-only.
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("hq_retest", ROOT / "infra" / "scripts" / "hq_retest.py")
hq = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hq)

DEV = "https://dev.myheliograph.com"
URL = "/asset/hq_SDO_193_20141024_1204.png"


class Http:
    """Replays canned replies in order; an Exception in the list is raised."""
    def __init__(self, *replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, method, url, payload=None):
        self.calls.append((method, url, payload))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return 200, reply


def boom(*args, **kwargs):
    raise AssertionError("no network in this test")


def counter(step):
    state = {"t": -step}

    def clock():
        state["t"] += step
        return state["t"]
    return clock


def busy_503():
    body = io.BytesIO(json.dumps({"detail": "Server is busy (212 MB free; need >=400 MB). Try again."}).encode())
    return urllib.error.HTTPError(DEV + "/api/generate", 503, "Service Unavailable", {}, body)


class RetestTests(unittest.TestCase):
    def go(self, http, clock=None, head=lambda base, path: 31415926, timeout=900, poll=5):
        payload = hq.build_payload("2014-10-24", "12:04", 193, False)
        return hq.run_retest(DEV, payload, timeout, poll, None, http, clock or counter(10),
                             lambda s: None, head, lambda: "2026-10-06T03:10:00+00:00")

    def test_refuses_the_prod_host(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = hq.main(["--base", "https://myheliograph.com"], http_fn=boom)
        self.assertEqual(code, 64)
        self.assertIn("REFUSING", err.getvalue())

    def test_refuses_the_prod_origin_host(self):
        with contextlib.redirect_stderr(io.StringIO()):
            code = hq.main(["--base", "https://myheliograph-api.fly.dev"], http_fn=boom)
        self.assertEqual(code, 64)

    def test_dry_run_sends_nothing_and_shows_the_request(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = hq.main(["--dry-run"], http_fn=boom)
        self.assertEqual(code, 0)
        self.assertIn('"time": "12:04"', out.getvalue())
        self.assertIn("nothing sent", out.getvalue())

    def test_a_render_is_recorded_with_its_timing_and_size(self):
        http = Http({"task_id": "t1"}, {"status": "queued"}, {"status": "started"},
                    {"status": "completed", "message": "HQ image ready", "image_url": URL})
        rec = self.go(http)
        self.assertTrue(rec["ok"])
        self.assertFalse(rec["cached"])
        self.assertEqual(rec["bytes"], 31415926)
        self.assertEqual(rec["image_url"], URL)
        self.assertEqual(rec["task_id"], "t1")
        self.assertEqual(rec["elapsed_s"], 30.0)
        self.assertEqual(http.calls[0], ("POST", DEV + "/api/generate", {
            "date": "2014-10-24", "time": "12:04", "wavelength": 193, "mission": "SDO",
            "detector": "AIA", "format": "rhef", "integrate": False}))

    def test_a_cache_hit_is_flagged_as_not_a_render(self):
        http = Http({"task_id": "t1"},
                    {"status": "completed", "message": "HQ image ready (cached)", "image_url": URL})
        rec = self.go(http)
        self.assertTrue(rec["cached"])

    def test_a_busy_503_is_a_recorded_failure_with_its_text(self):
        rec = self.go(Http(busy_503()))
        self.assertFalse(rec["ok"])
        self.assertIn("503", rec["error"])
        self.assertIn("212 MB free", rec["error"])

    def test_a_failed_task_is_a_recorded_failure(self):
        http = Http({"task_id": "t1"}, {"status": "failed", "message": "No VSO AIA data"})
        rec = self.go(http)
        self.assertFalse(rec["ok"])
        self.assertIn("No VSO AIA data", rec["error"])

    def test_a_timeout_is_a_recorded_failure(self):
        http = Http({"task_id": "t1"}, *[{"status": "queued"}] * 6)
        rec = self.go(http, clock=counter(400))
        self.assertFalse(rec["ok"])
        self.assertIn("timeout after 900 s", rec["error"])

    def test_a_master_that_cannot_be_fetched_is_a_failure(self):
        http = Http({"task_id": "t1"}, {"status": "completed", "message": "HQ image ready", "image_url": URL})
        rec = self.go(http, head=lambda base, path: None)
        self.assertFalse(rec["ok"])
        self.assertIn("not reachable", rec["error"])

    def test_the_record_file_is_append_only(self):
        d = tempfile.mkdtemp(prefix="mh5hq-")
        self.addCleanup(shutil.rmtree, d, True)
        path = os.path.join(d, ".launch-hq.json")
        first = {"ok": True, "n": 1}
        hq.append_run(path, first)
        hq.append_run(path, {"ok": False, "n": 2})
        with open(path) as f:
            runs = json.load(f)["runs"]
        self.assertEqual(runs[0], first)
        self.assertEqual([r["n"] for r in runs], [1, 2])
        with open(path, "w") as f:
            f.write("not json")
        with self.assertRaises(ValueError):
            hq.append_run(path, {"n": 3})
        with open(path) as f:
            self.assertEqual(f.read(), "not json")


if __name__ == "__main__":
    unittest.main()
