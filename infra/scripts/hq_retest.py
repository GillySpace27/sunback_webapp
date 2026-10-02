#!/usr/bin/env python3
"""Timed HQ render on the DEV origin, recorded for status.py's hq_4gb milestone.

status.py only reads state. This script makes the dev machine do real work: it
wakes it, fetches AIA data from NASA and holds a 4096 x 4096 RHEF render in
memory (fly.dev.toml sets memory = "4gb"). Run it once, off hours, with Gilly's
yes. It renders on dev only and refuses every other host.

Why 12:04 and not the default 12:00: the fixed landing default (AR 2192,
2014-10-24, 193 A, noon UTC) is restored from the persistent default cache
(api/main.py _hq_out_name, do_generate_sync), so a cache hit proves nothing
about memory. 12:04 is the same date and channel under a different filename
through the same render path. A run whose answer says cached is recorded but
flagged and does not turn hq_4gb green.

Peak memory is not exposed by /api/health. Read the memory graph for
myheliograph-api-dev in the Fly dashboard during the run and pass --peak-mb, or
leave it out and the milestone says peak memory UNCHECKED.

    python3 infra/scripts/hq_retest.py --dry-run     print the request, send nothing
    python3 infra/scripts/hq_retest.py               the real run

Exit: 0 rendered, 1 failed, 3 cache hit (not a render), 64 refused or bad argument.
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

DEV_BASES = ("https://dev.myheliograph.com",
             "https://myheliograph-router-dev.gilly-22d.workers.dev")
DEV_ORIGIN = "https://dev.myheliograph.com"   # dev's ALLOWED_ORIGINS value (DEPLOY.md step 2)
HQ_FILE = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        "..", "..", ".launch-hq.json"))


def http_json(method, url, payload=None, timeout=60):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Content-Type": "application/json", "Origin": DEV_ORIGIN})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.load(resp)


def content_length(base, path):
    """Size of a served file from its Content-Length header, without downloading it."""
    try:
        with urllib.request.urlopen(base.rstrip("/") + path, timeout=30) as resp:
            value = resp.headers.get("Content-Length")
        return int(value) if value else None
    except Exception:
        return None


def _http_detail(err):
    try:
        return str(json.loads(err.read().decode("utf-8", "replace")).get("detail", ""))[:160]
    except Exception:
        return ""


def build_payload(date, time_of_day, wavelength, integrate):
    return {"date": date, "time": time_of_day, "wavelength": wavelength, "mission": "SDO",
            "detector": "AIA", "format": "rhef", "integrate": integrate}


def run_retest(base, payload, timeout, poll, peak_mb, http_fn, clock, sleep_fn, head_fn, now_fn):
    """Run one render and return its record. Never raises for a network or HTTP problem."""
    rec = {"base": base, "started_at": now_fn(), "date": payload["date"], "time": payload["time"],
           "wavelength": payload["wavelength"], "integrate": payload["integrate"],
           "ok": False, "cached": False, "task_id": None, "image_url": None, "bytes": None,
           "elapsed_s": None, "peak_mb": peak_mb, "error": None}
    t0 = clock()
    try:
        _, body = http_fn("POST", base + "/api/generate", payload)
        rec["task_id"] = body.get("task_id")
        if not rec["task_id"]:
            rec["error"] = "no task_id in the response"
            return rec
        while True:
            _, state = http_fn("GET", base + "/api/status/" + rec["task_id"])
            status = state.get("status")
            if status == "completed":
                break
            if status in ("failed", "unknown"):
                rec["error"] = "task %s: %s" % (status, str(state.get("message", ""))[:160])
                return rec
            if clock() - t0 > timeout:
                rec["error"] = "timeout after %d s, still %s" % (timeout, status)
                return rec
            sleep_fn(poll)
    except urllib.error.HTTPError as e:
        rec["error"] = "HTTP %d: %s" % (e.code, _http_detail(e))
        return rec
    except Exception as e:
        rec["error"] = type(e).__name__
        return rec
    rec["elapsed_s"] = round(clock() - t0, 1)
    message = str(state.get("message", "")).lower()
    rec["cached"] = "cached" in message or "reused" in message
    rec["image_url"] = state.get("image_url")
    size = head_fn(base, rec["image_url"]) if rec["image_url"] else None
    if size is None:
        rec["error"] = "the master file is not reachable at %s" % rec["image_url"]
        return rec
    rec["bytes"] = size
    rec["ok"] = True
    return rec


def append_run(path, rec):
    """Append one run to {"runs": [...]}. A file that is not that shape raises and is left alone."""
    data = {"runs": []}
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
        if not isinstance(data, dict) or not isinstance(data.get("runs"), list):
            raise ValueError("%s is not {\"runs\": [...]}" % path)
    data["runs"].append(rec)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def main(argv=None, http_fn=http_json, clock=time.monotonic, sleep_fn=time.sleep,
         head_fn=content_length, hq_file=None, now_fn=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default=DEV_BASES[0], help="a dev host only")
    ap.add_argument("--date", default="2014-10-24", help="YYYY-MM-DD (default: the landing default)")
    ap.add_argument("--time", dest="time_of_day", default="12:04", help="HH:MM UTC, not 12:00")
    ap.add_argument("--wavelength", type=int, default=193)
    ap.add_argument("--integrate", action="store_true",
                    help="the multi-frame print render used at checkout (heavier)")
    ap.add_argument("--timeout", type=float, default=900.0, help="seconds (the code comments say 1-3 minutes)")
    ap.add_argument("--poll", type=float, default=5.0)
    ap.add_argument("--peak-mb", type=float, default=None, help="read by Gilly from the Fly memory graph")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    base = args.base.rstrip("/")
    if base not in DEV_BASES:
        print("REFUSING: %s is not a dev host. This script renders on dev only (%s)."
              % (base, ", ".join(DEV_BASES)), file=sys.stderr)
        return 64
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", args.time_of_day):
        print("REFUSING: --date must be YYYY-MM-DD and --time HH:MM.", file=sys.stderr)
        return 64
    payload = build_payload(args.date, args.time_of_day, args.wavelength, args.integrate)
    if args.dry_run:
        print("dry run: nothing sent. A real run would POST %s/api/generate with:" % base)
        print(json.dumps(payload, indent=2))
        return 0
    now_fn = now_fn or (lambda: datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
    print("hq_retest: rendering on %s (wakes the dev machine, fetches NASA data) ..." % base)
    rec = run_retest(base, payload, args.timeout, args.poll, args.peak_mb,
                     http_fn, clock, sleep_fn, head_fn, now_fn)
    append_run(hq_file or HQ_FILE, rec)
    if not rec["ok"]:
        print("hq_retest: FAILED: %s" % rec["error"])
        return 1
    if rec["cached"]:
        print("hq_retest: cache hit, not a render (%s). Pick another --time." % rec["image_url"])
        return 3
    mem = "peak memory %g MB" % rec["peak_mb"] if rec["peak_mb"] is not None else "peak memory not recorded (UNCHECKED)"
    print("hq_retest: rendered in %.0f s, master %d bytes at %s; %s"
          % (rec["elapsed_s"], rec["bytes"], rec["image_url"], mem))
    return 0


if __name__ == "__main__":
    sys.exit(main())
