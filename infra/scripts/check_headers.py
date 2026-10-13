#!/usr/bin/env python3
"""Check the security headers users actually receive (MH-10), stdlib only.

    python3 infra/scripts/check_headers.py                 every host in EXPECTED
    python3 infra/scripts/check_headers.py --host <url>    one host (use the workers.dev host for dev from NWRA's network)

For each edge host the check fetches /api/health (served through the Worker,
so the headers come from secure() in infra/worker/src/index.js) and /store/
(a Static Assets page, so the headers come from infra/worker/_headers). For
each raw *.fly.dev origin it fetches /api/health (headers come from
SecurityHeadersMiddleware in api/main.py). A requested value that ends in "*"
matches by prefix. Requests are plain GETs of public pages; nothing is sent
that a browser would not send. Exit 1 on any FAIL; an unreachable host is SKIP.
"""
import argparse
import sys
import urllib.error
import urllib.request

PROD = "https://myheliograph.com"
DEV = "https://dev.myheliograph.com"
PROD_ORIGIN = "https://myheliograph-api.fly.dev"
DEV_ORIGIN = "https://myheliograph-api-dev.fly.dev"
DEV_WORKERS = "https://myheliograph-router-dev.gilly-22d.workers.dev"

_EDGE = {
    "Strict-Transport-Security": "max-age=86400",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'self'",
}
_ORIGIN = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; *",
}

# The values in effect today. Task 8 of MH-10 (the HSTS ramp) changes the two
# Strict-Transport-Security entries together with the files that set them;
# test_check_headers.py fails if the table and the files disagree.
EXPECTED = {
    PROD: dict(_EDGE),
    DEV: dict(_EDGE, **{"X-Robots-Tag": "noindex, nofollow"}),
    PROD_ORIGIN: dict(_ORIGIN),
    DEV_ORIGIN: dict(_ORIGIN),
}

# The Static Assets page checked on edge hosts (headers come from _headers, which
# does not set X-Robots-Tag; dev is kept out of the index by a meta tag there).
STATIC_PATH = "/store/"


def fetch_headers(url, timeout=45):
    """Response headers of a GET, lower-cased keys. A 404 still carries them."""
    req = urllib.request.Request(url, headers={"User-Agent": "myheliograph-check-headers/1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return {k.lower(): v for k, v in r.getheaders()}
    except urllib.error.HTTPError as ex:
        return {k.lower(): v for k, v in ex.headers.items()}


def _matches(want, got):
    if want.endswith("*"):
        return got.startswith(want[:-1])
    return got == want


def check_host(base_url, expected, path="/api/health", fetch=None):
    """Return [(status, header, detail), ...]; status is PASS, FAIL or SKIP."""
    fetch = fetch or fetch_headers
    try:
        got = fetch(base_url.rstrip("/") + path)
    except Exception as ex:  # noqa: BLE001 - an unreachable host is reported, not raised
        return [("SKIP", "(request)", f"{type(ex).__name__}: {ex}")]
    rows = []
    for header, want in expected.items():
        have = got.get(header.lower())
        if have is None:
            rows.append(("FAIL", header, f"missing; expected {want!r}"))
        elif _matches(want, have):
            rows.append(("PASS", header, have))
        else:
            rows.append(("FAIL", header, f"got {have!r}; expected {want!r}"))
    return rows


def run(hosts, fetch=None):
    out = []
    for base in hosts:
        exp = EXPECTED[base]
        out.append((base, "/api/health", check_host(base, exp, "/api/health", fetch)))
        if base in (PROD, DEV):
            static_exp = {k: v for k, v in exp.items() if k != "X-Robots-Tag"}
            out.append((base, STATIC_PATH, check_host(base, static_exp, STATIC_PATH, fetch)))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", help="one host URL; the workers.dev dev host is treated as the dev edge")
    args = ap.parse_args(argv)
    if args.host:
        base = args.host.rstrip("/")
        base = DEV if base == DEV_WORKERS else base
        if base not in EXPECTED:
            print(f"check_headers: no expected table for {base}; known: {', '.join(EXPECTED)}", file=sys.stderr)
            return 64
        hosts = [base]
    else:
        hosts = list(EXPECTED)
    failed = False
    for base, path, rows in run(hosts):
        for status, header, detail in rows:
            print(f"{status:<4} {base}{path} {header}: {detail}")
            failed = failed or status == "FAIL"
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
