"""Self-check for infra/scripts/probe.py (MH-6).

Run: python3 api/scripts/test_probe.py

No network: probe.fetch, tls_expiry, first_byte_seconds and the clock are replaced by
fakes. Pins: every probe can FAIL, lowering the disk threshold to 1 percent makes the
health probe fail, dev must carry noindex and prod must not, a missing /build.json is a
SKIP, and the probe source never mentions the Printify or admin routes (the Printify
pricing route writes to the live shop on a cost gap; no probe may call it).
"""
import contextlib
import datetime
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROBE_PATH = ROOT / "infra" / "scripts" / "probe.py"
_spec = importlib.util.spec_from_file_location("probe_mh6", PROBE_PATH)
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)

NOW = datetime.datetime(2026, 10, 10, 12, 0, tzinfo=datetime.timezone.utc)


def table_fetch(table):
    def fetch(url, timeout=60.0):
        status, body = table[url]
        return status, {}, body.encode() if isinstance(body, str) else body, 0.5
    return fetch


class Base(unittest.TestCase):
    def setUp(self):
        saved = (probe.fetch, probe.tls_expiry, probe.first_byte_seconds, probe.today,
                 probe.now_utc, probe.run_tier, dict(probe.CFG))
        self.addCleanup(self.restore, saved)
        probe.today = lambda: NOW.date()
        probe.now_utc = lambda: NOW

    @staticmethod
    def restore(saved):
        (probe.fetch, probe.tls_expiry, probe.first_byte_seconds, probe.today,
         probe.now_utc, probe.run_tier, cfg) = saved
        probe.CFG.clear()
        probe.CFG.update(cfg)

    def serve(self, table):
        probe.fetch = table_fetch(table)


class HealthTests(Base):
    URL = probe.PROD + "/api/health"

    def health(self, body, status=200):
        self.serve({self.URL: (status, body)})
        return probe.probe_health(probe.PROD)

    def test_ok_below_the_alert(self):
        s, d = self.health('{"status": "ok", "disk_pct": 40}')
        self.assertEqual(s, "PASS")
        self.assertIn("disk_pct 40", d)

    def test_alert_at_the_threshold(self):
        s, d = self.health('{"status": "ok", "disk_pct": 80}')
        self.assertEqual(s, "FAIL")
        self.assertIn("80", d)

    def test_lowering_the_threshold_to_one_percent_makes_it_fail(self):
        probe.CFG["disk_alert_pct"] = 1.0
        s, _ = self.health('{"status": "ok", "disk_pct": 40}')
        self.assertEqual(s, "FAIL")

    def test_a_missing_disk_pct_passes_unless_required(self):
        s, d = self.health('{"status": "ok"}')
        self.assertEqual(s, "PASS")
        self.assertIn("not reported", d)
        probe.CFG["require_disk_pct"] = True
        s, _ = self.health('{"status": "ok"}')
        self.assertEqual(s, "FAIL")

    def test_zero_is_reported_as_a_reading_with_a_caveat(self):
        s, d = self.health('{"status": "ok", "disk_pct": 0}')
        self.assertEqual(s, "PASS")
        self.assertIn("disk_pct 0", d)

    def test_http_error_fails(self):
        s, d = self.health("down", status=503)
        self.assertEqual(s, "FAIL")
        self.assertIn("503", d)

    def test_not_json_fails(self):
        self.assertEqual(self.health("<html>")[0], "FAIL")

    def test_status_other_than_ok_fails(self):
        self.assertEqual(self.health('{"status": "degraded"}')[0], "FAIL")


class FrontierTests(Base):
    URL = probe.PROD + "/api/data_frontier"

    def frontier(self, latest):
        self.serve({self.URL: (200, json.dumps({"latest": latest, "earliest": "2010-05-15"}))})
        return probe.probe_frontier(probe.PROD)

    def test_a_normal_lag_passes(self):
        s, d = self.frontier("2026-10-04")
        self.assertEqual(s, "PASS")
        self.assertIn("6 days", d)

    def test_a_stalled_frontier_fails(self):
        s, d = self.frontier("2026-09-28")
        self.assertEqual(s, "FAIL")
        self.assertIn("12 days", d)

    def test_a_malformed_date_fails(self):
        self.assertEqual(self.frontier("soon")[0], "FAIL")


class PagesTests(Base):
    def pages(self, root_body, store_body, root_status=200):
        self.serve({probe.PROD + "/": (root_status, root_body), probe.PROD + "/store/": (200, store_body)})
        return probe.probe_pages(probe.PROD)

    def test_both_markers_present_passes(self):
        s, _ = self.pages('<div id="root"></div>', "Courtesy of NASA/SDO and the AIA")
        self.assertEqual(s, "PASS")

    def test_missing_nasa_attribution_on_the_store_fails(self):
        s, d = self.pages('<div id="root"></div>', "<html>a store without credit</html>")
        self.assertEqual(s, "FAIL")
        self.assertIn("/store/", d)

    def test_an_error_status_on_the_landing_page_fails(self):
        s, d = self.pages("nope", "Courtesy of NASA/SDO", root_status=500)
        self.assertEqual(s, "FAIL")
        self.assertIn("HTTP 500", d)


class TlsTtfbTests(Base):
    def test_tls_far_from_expiry_passes(self):
        probe.tls_expiry = lambda host: NOW + datetime.timedelta(days=60)
        self.assertEqual(probe.probe_tls(probe.PROD)[0], "PASS")

    def test_tls_near_expiry_fails(self):
        probe.tls_expiry = lambda host: NOW + datetime.timedelta(days=5)
        s, d = probe.probe_tls(probe.PROD)
        self.assertEqual(s, "FAIL")
        self.assertIn("5 days", d)

    def test_fast_first_byte_passes_and_slow_fails(self):
        probe.first_byte_seconds = lambda url, timeout=30.0: (200, 0.4)
        self.assertEqual(probe.probe_ttfb(probe.PROD)[0], "PASS")
        probe.first_byte_seconds = lambda url, timeout=30.0: (200, 5.0)
        self.assertEqual(probe.probe_ttfb(probe.PROD)[0], "FAIL")


class NoindexTests(Base):
    NOINDEX = '<meta name="robots" content="noindex, nofollow">'

    def serve_pages(self, base, bodies):
        self.serve({base + p: (200, b) for p, b in bodies.items()})

    def test_prod_without_noindex_passes(self):
        self.serve_pages(probe.PROD, {"/": "<html></html>", "/store/": "<html></html>"})
        self.assertEqual(probe.probe_noindex(probe.PROD)[0], "PASS")

    def test_prod_with_noindex_fails(self):
        self.serve_pages(probe.PROD, {"/": self.NOINDEX, "/store/": "<html></html>"})
        s, d = probe.probe_noindex(probe.PROD)
        self.assertEqual(s, "FAIL")
        self.assertIn("/", d)

    def test_dev_with_noindex_everywhere_passes(self):
        self.serve_pages(probe.DEV, {"/": self.NOINDEX, "/store/": self.NOINDEX, "/experience/": self.NOINDEX})
        self.assertEqual(probe.probe_noindex(probe.DEV)[0], "PASS")

    def test_dev_missing_noindex_on_the_experience_page_fails(self):
        self.serve_pages(probe.DEV, {"/": self.NOINDEX, "/store/": self.NOINDEX, "/experience/": "<html></html>"})
        s, d = probe.probe_noindex(probe.DEV)
        self.assertEqual(s, "FAIL")
        self.assertIn("/experience/", d)


class SkewTests(Base):
    def test_missing_build_json_is_a_skip(self):
        self.serve({probe.PROD + "/build.json": (404, "nope")})
        self.assertEqual(probe.probe_build_skew(probe.PROD)[0], "SKIP")

    def test_equal_shas_pass(self):
        sha = "a" * 40
        self.serve({probe.PROD + "/build.json": (200, json.dumps({"sha": sha})),
                    probe.PROD + "/api/build-info": (200, json.dumps({"sha": sha, "built": None}))})
        self.assertEqual(probe.probe_build_skew(probe.PROD)[0], "PASS")

    def test_different_shas_fail_and_name_both(self):
        self.serve({probe.PROD + "/build.json": (200, json.dumps({"sha": "a" * 40})),
                    probe.PROD + "/api/build-info": (200, json.dumps({"sha": "b" * 40}))})
        s, d = probe.probe_build_skew(probe.PROD)
        self.assertEqual(s, "FAIL")
        self.assertIn("aaaaaaaa", d)
        self.assertIn("bbbbbbbb", d)

    def test_an_origin_without_a_sha_is_a_skip(self):
        self.serve({probe.PROD + "/build.json": (200, json.dumps({"sha": "a" * 40})),
                    probe.PROD + "/api/build-info": (200, json.dumps({"built": None}))})
        self.assertEqual(probe.probe_build_skew(probe.PROD)[0], "SKIP")


class RunnerTests(Base):
    def test_an_exception_inside_a_probe_is_a_fail_not_a_crash(self):
        def boom(*args, **kwargs):
            raise OSError("connection refused")
        probe.fetch = probe.tls_expiry = probe.first_byte_seconds = boom
        rows = probe.run_tier("prod")
        self.assertEqual(len(rows), 8)
        self.assertTrue(all(status == "FAIL" for status, _, _ in rows), rows)

    def test_main_exit_code_follows_the_rows_and_json_is_a_list(self):
        probe.run_tier = lambda tier: [("PASS", "probe_health", "ok"), ("FAIL", "probe_tls", "5 days")]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = probe.main(["--tier", "prod", "--json"])
        self.assertEqual(code, 1)
        data = json.loads(out.getvalue())
        self.assertEqual(data[1], {"name": "probe_tls", "status": "FAIL", "detail": "5 days"})
        probe.run_tier = lambda tier: [("PASS", "probe_health", "ok"), ("SKIP", "probe_build_skew", "later")]
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(probe.main(["--tier", "dev"]), 0)

    def test_tiers_name_the_probes_the_register_lists(self):
        self.assertEqual(probe.TIER_PROBES["prod"], (
            "probe_health", "probe_frontier", "probe_pages", "probe_tls", "probe_ttfb",
            "probe_noindex", "probe_build_skew", "probe_headers"))
        self.assertEqual(probe.TIER_PROBES["dev"], (
            "probe_health", "probe_pages", "probe_tls", "probe_noindex", "probe_build_skew",
            "probe_headers"))

    def test_probe_headers_passes_and_fails_on_stubbed_headers(self):
        sys.path.insert(0, str(PROBE_PATH.parent))
        import check_headers
        good = {k.lower(): v for k, v in check_headers.EXPECTED[probe.PROD].items()}
        probe.fetch = lambda url, timeout=60.0: (200, good, b"", 0.0)
        self.assertEqual(probe.probe_headers(probe.PROD)[0], "PASS")
        bad = dict(good, **{"strict-transport-security": "max-age=1"})
        probe.fetch = lambda url, timeout=60.0: (200, bad, b"", 0.0)
        status, detail = probe.probe_headers(probe.PROD)
        self.assertEqual(status, "FAIL")
        self.assertIn("Strict-Transport-Security", detail)

    def test_probe_headers_skips_an_unknown_host_and_never_touches_the_network_for_it(self):
        self.assertEqual(probe.probe_headers("https://example.invalid"),
                         ("SKIP", "no expected header table for https://example.invalid"))


class GuardTests(unittest.TestCase):
    def test_the_probe_never_mentions_the_printify_or_admin_routes(self):
        text = PROBE_PATH.read_text().lower()
        for word in ("printify", "/admin", "x-admin-key", "feedback_admin"):
            self.assertNotIn(word, text)


if __name__ == "__main__":
    unittest.main()
