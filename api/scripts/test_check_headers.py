#!/usr/bin/env python3
"""Self-check for infra/scripts/check_headers.py (MH-10).

Run: python3 api/scripts/test_check_headers.py

Offline: fetch is replaced by a stub. Also pins that the expected HSTS values in
the table equal the ones in the files that set them (infra/worker/src/index.js,
infra/worker/_headers, api/main.py), so changing one without the other fails
here before it fails in production.
"""
import importlib.util
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra" / "scripts" / "check_headers.py"
spec = importlib.util.spec_from_file_location("check_headers", SCRIPT)
ch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ch)  # FileNotFoundError until the script exists


def stub(headers):
    return lambda url, timeout=45: {k.lower(): v for k, v in headers.items()}


GOOD_EDGE = {
    "Strict-Transport-Security": ch.EXPECTED[ch.PROD]["Strict-Transport-Security"],
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'self'",
}


def test_hosts_and_table_shape():
    assert ch.PROD == "https://myheliograph.com" and ch.DEV == "https://dev.myheliograph.com"
    assert ch.PROD_ORIGIN == "https://myheliograph-api.fly.dev" and ch.DEV_ORIGIN == "https://myheliograph-api-dev.fly.dev"
    assert set(ch.EXPECTED) == {ch.PROD, ch.DEV, ch.PROD_ORIGIN, ch.DEV_ORIGIN}
    for host, exp in ch.EXPECTED.items():
        assert {"Strict-Transport-Security", "X-Frame-Options", "Referrer-Policy",
                "X-Content-Type-Options", "Content-Security-Policy"} <= set(exp), host


def test_all_pass_on_good_headers():
    rows = ch.check_host(ch.PROD, ch.EXPECTED[ch.PROD], fetch=stub(GOOD_EDGE))
    assert rows and all(r[0] == "PASS" for r in rows), rows


def test_wrong_expected_value_fails_and_names_the_header():
    wrong = dict(ch.EXPECTED[ch.PROD], **{"Strict-Transport-Security": "max-age=1"})
    rows = ch.check_host(ch.PROD, wrong, fetch=stub(GOOD_EDGE))
    bad = [r for r in rows if r[0] == "FAIL"]
    assert len(bad) == 1 and bad[0][1] == "Strict-Transport-Security", rows
    assert "max-age=1" in bad[0][2] and ch.EXPECTED[ch.PROD]["Strict-Transport-Security"] in bad[0][2], bad[0]


def test_missing_header_fails():
    headers = dict(GOOD_EDGE)
    headers.pop("X-Frame-Options")
    rows = ch.check_host(ch.PROD, ch.EXPECTED[ch.PROD], fetch=stub(headers))
    assert [r[1] for r in rows if r[0] == "FAIL"] == ["X-Frame-Options"], rows


def test_prefix_rule_for_a_trailing_star():
    exp = {"Content-Security-Policy": "default-src 'self'; *"}
    ok = ch.check_host("https://h", exp, fetch=stub({"Content-Security-Policy": "default-src 'self'; img-src 'self'"}))
    bad = ch.check_host("https://h", exp, fetch=stub({"Content-Security-Policy": "frame-ancestors 'self'"}))
    assert ok[0][0] == "PASS" and bad[0][0] == "FAIL", (ok, bad)


def test_unreachable_host_is_skip_not_fail():
    def boom(url, timeout=45):
        raise OSError("connection refused")
    rows = ch.check_host(ch.PROD, ch.EXPECTED[ch.PROD], fetch=boom)
    assert rows == [("SKIP", "(request)", "OSError: connection refused")], rows


def test_expected_hsts_matches_the_files_that_set_it():
    index_js = (ROOT / "infra/worker/src/index.js").read_text(encoding="utf-8")
    m = re.search(r'headers\.set\("Strict-Transport-Security",\s*"([^"]+)"\)', index_js)
    assert m, "secure() in index.js sets no Strict-Transport-Security"
    assert ch.EXPECTED[ch.PROD]["Strict-Transport-Security"] == m.group(1), "edge table != index.js"
    assert ch.EXPECTED[ch.DEV]["Strict-Transport-Security"] == m.group(1), "dev edge table != index.js"
    hdr = (ROOT / "infra/worker/_headers").read_text(encoding="utf-8")
    m2 = re.search(r"(?m)^\s*Strict-Transport-Security:\s*(\S.*?)\s*$", hdr)
    assert m2 and m2.group(1) == m.group(1), "_headers != index.js"
    main_py = (ROOT / "api/main.py").read_text(encoding="utf-8")
    m3 = re.search(r'h\.setdefault\("Strict-Transport-Security",\s*"([^"]+)"\)', main_py)
    assert m3 and ch.EXPECTED[ch.PROD_ORIGIN]["Strict-Transport-Security"] == m3.group(1), "origin table != main.py"


def test_host_constants_equal_probe_py_when_present():
    probe = ROOT / "infra" / "scripts" / "probe.py"
    if not probe.exists():
        print("     (infra/scripts/probe.py absent: MH-6 has not landed; UNCHECKED)")
        return
    text = probe.read_text(encoding="utf-8")
    for name in ("PROD", "DEV", "PROD_ORIGIN", "DEV_ORIGIN"):
        m = re.search(r'(?m)^%s\s*=\s*"([^"]+)"' % name, text)
        assert m and m.group(1) == getattr(ch, name), f"{name} differs from probe.py"


def run():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except Exception as ex:  # noqa: BLE001 - report every failure, then exit 1
            failed += 1
            print("FAIL", name, "-", type(ex).__name__, ex)
    if failed:
        print(f"test_check_headers: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_check_headers: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
