#!/usr/bin/env python3
"""Outside probes for myheliograph.com (MH-6). Standard library only, public endpoints only.

    python3 infra/scripts/probe.py --tier prod [--disk-alert-pct 80] [--require-disk-pct] [--json]
    python3 infra/scripts/probe.py --tier dev

Each probe is probe_<name>(base) -> (status, detail) with status PASS, FAIL or SKIP. A row
prints as "<STATUS> <name>: <detail>". Exit 1 if any probe FAILs, which makes the scheduled
GitHub Actions run fail and GitHub email its owner. It calls only ungated GET endpoints (the
health, frontier and page URLs, and /build.json and /api/build-info): no key, no write
route, no secret. Thresholds marked "estimated" are guesses to tune after a week
of history.
"""
import argparse
import datetime
import http.client
import json
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROD = "https://myheliograph.com"
DEV = "https://dev.myheliograph.com"
PROD_ORIGIN = "https://myheliograph-api.fly.dev"
DEV_ORIGIN = "https://myheliograph-api-dev.fly.dev"

CFG = {"disk_alert_pct": 80.0, "require_disk_pct": False}
FRONTIER_MAX_AGE_DAYS = 9    # estimated: lag was ~5-6 days on 2026-08-09, the fallback is 7
TLS_MIN_DAYS = 14            # estimated
TTFB_MAX_SECONDS = 3.0       # estimated: the landing page is a static asset at the edge
HEALTH_MAX_SECONDS = 60.0    # a cold Fly wake was ~25 s (infra/scripts/pull_fly_assets.sh)
UA = "myheliograph-probe/1"

TIER_PROBES = {
    "prod": ("probe_health", "probe_frontier", "probe_pages", "probe_tls", "probe_ttfb",
             "probe_noindex", "probe_build_skew", "probe_headers"),
    "dev": ("probe_health", "probe_pages", "probe_tls", "probe_noindex", "probe_build_skew",
            "probe_headers"),
}
TIER_BASE = {"prod": PROD, "dev": DEV}


def today():
    return datetime.datetime.now(datetime.timezone.utc).date()


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def fetch(url, timeout=60.0):
    """(status, lower-cased headers, body bytes, elapsed seconds). An HTTP error status is returned, not raised."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, body, time.monotonic() - t0
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read(), time.monotonic() - t0


def first_byte_seconds(url, timeout=30.0):
    """(status, seconds from connect to the first response byte)."""
    u = urllib.parse.urlparse(url)
    conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=timeout,
                                       context=ssl.create_default_context())
    t0 = time.monotonic()
    conn.request("GET", u.path or "/", headers={"User-Agent": UA})
    resp = conn.getresponse()
    resp.read(1)
    elapsed = time.monotonic() - t0
    conn.close()
    return resp.status, elapsed


def tls_expiry(host, port=443, timeout=15.0):
    ctx = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as tls:
            cert = tls.getpeercert()
    return datetime.datetime.fromtimestamp(ssl.cert_time_to_seconds(cert["notAfter"]), datetime.timezone.utc)


def _json(body):
    try:
        return json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return None


def probe_health(base):
    status, _, body, elapsed = fetch(base + "/api/health", timeout=HEALTH_MAX_SECONDS)
    if status != 200:
        return "FAIL", "HTTP %d from /api/health" % status
    data = _json(body)
    if not isinstance(data, dict):
        return "FAIL", "/api/health is not JSON"
    if data.get("status") != "ok":
        return "FAIL", "status is %r, not 'ok'" % (data.get("status"),)
    pct = data.get("disk_pct")
    took = "answered in %.1f s" % elapsed
    if pct is None:
        if CFG["require_disk_pct"]:
            return "FAIL", "%s; disk_pct is missing and --require-disk-pct is on" % took
        return "PASS", "%s; disk_pct not reported (the origin predates MH-6)" % took
    if isinstance(pct, bool) or not isinstance(pct, (int, float)):
        return "FAIL", "disk_pct is %r, not a number" % (pct,)
    if pct >= CFG["disk_alert_pct"]:
        return "FAIL", "disk_pct %s is at or above the alert %s" % (pct, CFG["disk_alert_pct"])
    note = ""
    if pct == 0:
        note = " (0 is also what api/main.py _disk_used_pct returns when statvfs fails)"
    return "PASS", "%s; disk_pct %s below the alert %s%s" % (took, pct, CFG["disk_alert_pct"], note)


def probe_frontier(base):
    status, _, body, _ = fetch(base + "/api/data_frontier")
    if status != 200:
        return "FAIL", "HTTP %d from /api/data_frontier" % status
    data = _json(body)
    try:
        latest = datetime.date.fromisoformat(str(data["latest"]))
    except (TypeError, KeyError, ValueError):
        return "FAIL", "no usable 'latest' date in /api/data_frontier"
    age = (today() - latest).days
    if age > FRONTIER_MAX_AGE_DAYS:
        return "FAIL", "latest %s is %d days old (limit %d, estimated)" % (latest, age, FRONTIER_MAX_AGE_DAYS)
    return "PASS", "latest %s is %d days old (limit %d, estimated)" % (latest, age, FRONTIER_MAX_AGE_DAYS)


PAGE_MARKERS = (("/", 'id="root"'), ("/store/", "Courtesy of NASA/SDO"))


def probe_pages(base):
    problems = []
    for path, marker in PAGE_MARKERS:
        status, _, body, _ = fetch(base + path)
        if status != 200:
            problems.append("%s HTTP %d" % (path, status))
        elif marker not in body.decode("utf-8", "replace"):
            problems.append("%s lacks %r" % (path, marker))
    if problems:
        return "FAIL", "; ".join(problems)
    return "PASS", "/ and /store/ answer with their markers (the store carries the NASA/SDO credit)"


def probe_tls(base):
    host = urllib.parse.urlparse(base).hostname
    days = (tls_expiry(host) - now_utc()).total_seconds() / 86400.0
    if days < TLS_MIN_DAYS:
        return "FAIL", "certificate for %s expires in %d days (limit %d, estimated)" % (host, int(days), TLS_MIN_DAYS)
    return "PASS", "certificate for %s expires in %d days" % (host, int(days))


def probe_ttfb(base):
    status, seconds = first_byte_seconds(base + "/")
    if status != 200:
        return "FAIL", "HTTP %d from /" % status
    if seconds > TTFB_MAX_SECONDS:
        return "FAIL", "first byte of / took %.2f s (limit %.1f, estimated)" % (seconds, TTFB_MAX_SECONDS)
    return "PASS", "first byte of / in %.2f s" % seconds


_NOINDEX = re.compile(r'name="robots"[^>]*noindex', re.I)


def probe_noindex(base):
    dev = base == DEV
    paths = ["/", "/store/"] + (["/experience/"] if dev else [])
    wrong = []
    for path in paths:
        status, _, body, _ = fetch(base + path)
        if status != 200:
            wrong.append("%s HTTP %d" % (path, status))
            continue
        has = bool(_NOINDEX.search(body.decode("utf-8", "replace")))
        if has != dev:
            wrong.append("%s %s noindex" % (path, "lacks" if dev else "carries"))
    if wrong:
        return "FAIL", "; ".join(wrong)
    return "PASS", "noindex meta present on every dev page" if dev else "no noindex meta on prod"


def probe_build_skew(base):
    status, _, body, _ = fetch(base + "/build.json")
    if status == 404:
        return "SKIP", "/build.json is absent (the build identity has not shipped yet)"
    if status != 200:
        return "FAIL", "HTTP %d from /build.json" % status
    edge = (_json(body) or {}).get("sha")
    status, _, body, _ = fetch(base + "/api/build-info")
    origin = (_json(body) or {}).get("sha") if status == 200 else None
    if not edge or not origin:
        return "SKIP", "edge sha %s, origin sha %s: nothing to compare yet" % (bool(edge), bool(origin))
    if edge == origin:
        return "PASS", "edge and origin are both at %s" % edge[:8]
    return "FAIL", "edge is at %s but origin is at %s" % (edge[:8], origin[:8])


def probe_headers(base):
    """Security headers users receive on `base` (an edge host or a raw origin), via check_headers.py."""
    import os
    if os.path.dirname(os.path.abspath(__file__)) not in sys.path:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import check_headers  # same folder
    expected = check_headers.EXPECTED.get(base)
    if expected is None:
        return ("SKIP", f"no expected header table for {base}")
    # Requests go through this module's fetch(), so the tests' stubs apply and the
    # probe sends the same User-Agent as its siblings. Unlike the stand-alone
    # check_headers.py (where an unreachable host is SKIP), an unreachable host
    # here is a FAIL, as for every other probe: a blind probe must not read green.
    rows = check_headers.check_host(base, expected, fetch=lambda url, timeout=60.0: fetch(url, timeout)[1])
    bad = [f"{h}: {d}" for st, h, d in rows if st in ("FAIL", "SKIP")]
    if bad:
        return ("FAIL", "; ".join(bad))
    return ("PASS", f"{len(rows)} headers as expected")


def run_tier(tier):
    """[(status, name, detail)] for the tier's probes; an exception inside one is that probe's FAIL."""
    base = TIER_BASE[tier]
    rows = []
    for name in TIER_PROBES[tier]:
        try:
            status, detail = globals()[name](base)
        except Exception as e:
            status, detail = "FAIL", "%s: %s" % (type(e).__name__, e)
        rows.append((status, name, detail))
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tier", choices=sorted(TIER_PROBES), required=True)
    ap.add_argument("--disk-alert-pct", type=float, default=80.0)
    ap.add_argument("--require-disk-pct", action="store_true",
                    help="fail when /api/health reports no disk_pct (turn on once MH-6 is deployed)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    CFG["disk_alert_pct"] = args.disk_alert_pct
    CFG["require_disk_pct"] = args.require_disk_pct
    rows = run_tier(args.tier)
    if args.json:
        print(json.dumps([{"name": n, "status": s, "detail": d} for s, n, d in rows], indent=2))
    else:
        for s, n, d in rows:
            print("%s %s: %s" % (s, n, d))
    return 1 if any(s == "FAIL" for s, _, _ in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
