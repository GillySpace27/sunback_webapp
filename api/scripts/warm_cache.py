#!/usr/bin/env python3
"""
warm_cache.py — pre-seed the preview cache for a beta test.

The first fetch for a given (date, time, wavelength) hits VSO/SunPy +
Helioviewer cold and takes 90s–5min depending on the FITS state. Once
the resulting PNGs land on disk, repeat hits are essentially free. So
before opening the app to a test cohort, run this script against the
deployed instance to warm up the most-likely combinations. After it
finishes, the first 50 testers all hit cached responses.

Usage:
    # Default: hit the live deploy with a small popular grid
    python warm_cache.py

    # Local dev
    python warm_cache.py --base-url http://localhost:8000

    # Custom date range / wavelengths
    python warm_cache.py --days-back 7 14 21 --wavelengths 171 193 304

The script is intentionally sequential: the backend is single-threaded
on heavy renders (post-50166f3), and slamming it in parallel just
queues things up while showing nothing useful. Sequential gives clean
log output and matches the way real users will arrive.
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta

DEFAULT_BASE_URL = "https://solar-archive.onrender.com"
# Same wavelength set the UI exposes — these get hit most often.
DEFAULT_WAVELENGTHS = [94, 131, 171, 193, 211, 304, 335, 1600, 1700]
# Days back from "today" to seed. 7 / 14 / 21 covers the default
# date the UI lands on (today minus 7) plus two fall-backs.
DEFAULT_DAYS_BACK = [7, 14, 21]
# Single time slot per date — noon UTC matches the UI default.
DEFAULT_TIME = "12:00"
# Per-request timeout. Cold renders can take 5min so we set this high.
REQUEST_TIMEOUT_SECONDS = 600


def _post_json(url, payload, timeout):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def warm_one(base_url, date_str, time_str, wavelength):
    """POST /api/generate_preview and poll until ready or until we conclude
    no data is available. Returns a tuple (status, message)."""
    url = base_url.rstrip("/") + "/api/generate_preview"
    payload = {
        "date": date_str,
        "time": time_str,
        "wavelength": wavelength,
        "mission": "SDO",
    }
    started = time.time()
    # First call kicks off the render (or returns cached if warm).
    try:
        status, body = _post_json(url, payload, timeout=REQUEST_TIMEOUT_SECONDS)
    except urllib.error.HTTPError as e:
        return ("http_error", f"{e.code} {e.reason}")
    except urllib.error.URLError as e:
        return ("connect_error", str(e.reason))
    except Exception as e:
        return ("error", str(e))

    if body.get("preview_url"):
        return ("cached_or_done", f"ready in {time.time() - started:.1f}s")
    if body.get("error"):
        return ("no_data", body.get("error"))

    # Otherwise the backend is rendering in the background. Poll.
    poll_attempts = 0
    while time.time() - started < REQUEST_TIMEOUT_SECONDS:
        time.sleep(3.0)
        poll_attempts += 1
        try:
            status, body = _post_json(url, payload, timeout=REQUEST_TIMEOUT_SECONDS)
        except Exception as e:
            return ("poll_error", str(e))
        if body.get("preview_url"):
            return ("rendered", f"ready in {time.time() - started:.1f}s ({poll_attempts} polls)")
        if body.get("error"):
            return ("no_data", body.get("error"))
    return ("timeout", f"still pending after {REQUEST_TIMEOUT_SECONDS}s")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL,
                        help=f"Backend base URL (default: {DEFAULT_BASE_URL})")
    parser.add_argument("--days-back", type=int, nargs="+", default=DEFAULT_DAYS_BACK,
                        help=f"Days before today to seed (default: {DEFAULT_DAYS_BACK})")
    parser.add_argument("--wavelengths", type=int, nargs="+", default=DEFAULT_WAVELENGTHS,
                        help=f"AIA wavelengths to seed (default: {DEFAULT_WAVELENGTHS})")
    parser.add_argument("--time", default=DEFAULT_TIME,
                        help=f"UTC HH:MM to seed (default: {DEFAULT_TIME})")
    args = parser.parse_args()

    today = date.today()
    dates = [(today - timedelta(days=d)).strftime("%Y-%m-%d") for d in args.days_back]
    total = len(dates) * len(args.wavelengths)

    print(f"Warming cache against {args.base_url}")
    print(f"  dates:       {dates}")
    print(f"  time:        {args.time} UTC")
    print(f"  wavelengths: {args.wavelengths}")
    print(f"  total combos: {total}")
    print()

    successes = 0
    failures = 0
    no_data = 0
    started_all = time.time()
    for i, date_str in enumerate(dates):
        for j, wl in enumerate(args.wavelengths):
            n = i * len(args.wavelengths) + j + 1
            label = f"[{n:>2}/{total}] {date_str} @ {args.time} UTC · {wl} Å"
            sys.stdout.write(label + " ... ")
            sys.stdout.flush()
            status, message = warm_one(args.base_url, date_str, args.time, wl)
            if status in ("rendered", "cached_or_done"):
                successes += 1
                print(f"OK ({status}: {message})")
            elif status == "no_data":
                no_data += 1
                print(f"skipped ({message})")
            else:
                failures += 1
                print(f"FAIL ({status}: {message})")

    elapsed = time.time() - started_all
    print()
    print(f"Done in {elapsed/60:.1f} min — "
          f"{successes} cached, {no_data} skipped (no data), {failures} failed.")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
