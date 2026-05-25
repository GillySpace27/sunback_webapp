"""Warm the per-event JPG thumbnails for each vibe-grid card.

For each of the 5 static vibe cards, this script:
  1. Queries the local /api/hek/best_time route for the top-3 HEK events
     on that date.
  2. For each event (rank 1..3) and each of the 9 AIA wavelengths, fetches
     a 256² Helioviewer JPG thumbnail via /api/helioviewer_thumb.
  3. Writes the thumbnails to
        default_cache/vibe/<slug>/events/<rank>/<wavelength>/jpg_thumb.png
  4. Extends the existing default_cache/vibe_manifest.json with a new
     "events" array per vibe (each entry: rank, time, event metadata,
     and a wavelengths map keyed by wl).

Run via:
    python3 api/scripts/warm_vibe_jpg_thumbs.py [--local URL] [--out DIR]

Defaults match the local dev-server setup: --local http://localhost:8001,
--out ./default_cache.

Total: 5 × 3 × 9 = 135 thumb fetches. Each is a 256² Helioviewer PNG
(typically 50-100 KB). On a warm machine: ~5-10 minutes wall clock.
The script honours the local server's rate limiter (3 req/s on a cold
deploy, 6 req/s after the round-3 bump).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

# Reuse the project's requests dependency.
try:
    import requests
except ImportError:
    print("requests not installed in this env. Install with: pip install requests", file=sys.stderr)
    sys.exit(2)


# Hardcoded mirror of api/main.py:_VIBE_GRID_TUPLES so we don't need
# to import a server module. Keep in sync if the tuple list changes.
_VIBE_GRID_TUPLES = [
    {"slug": "ar2192",                     "date": "2014-10-24"},
    {"slug": "x93_flare",                  "date": "2017-09-06"},
    {"slug": "mothers_day_storm",          "date": "2024-05-10"},
    {"slug": "monster_prominence",         "date": "2012-08-31"},
    {"slug": "limb_x82_flare",             "date": "2017-09-10"},
    # Round-6 additions for full wavelength coverage:
    {"slug": "pre_x93_powderkeg",          "date": "2017-09-04"},
    {"slug": "post_flare_arcade",          "date": "2012-07-19"},
    {"slug": "great_sympathetic_eruption", "date": "2010-08-01"},
    {"slug": "ar13664_emergence",          "date": "2024-05-08"},
    {"slug": "x16_flare_ribbons",          "date": "2014-09-10"},
    {"slug": "ar2192_photosphere",         "date": "2014-10-24"},
]

# 9 AIA wavelengths the wavelength-grid presents to users.
WAVELENGTHS = [94, 131, 171, 193, 211, 304, 335, 1600, 1700]


def _fetch_top_events(local_base: str, date: str) -> list[dict]:
    """Call /api/hek/best_time and return the top-3 events list."""
    url = f"{local_base}/api/hek/best_time?date={date}"
    print(f"[hek] {date} → {url}")
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    data = r.json()
    events = (data or {}).get("events") or []
    if not events:
        print(f"[hek] {date} returned no events — using a single noon fallback")
        events = [{
            "rank": 1, "rank_label": "Noon UTC",
            "time_utc": "12:00", "peak_time_iso": f"{date}T12:00:00",
            "event_type": "Quiet day", "event_code": None,
            "fallback": True,
        }]
    return events[:3]


def _fetch_thumb(local_base: str, date: str, time_utc: str, wavelength: int,
                 out_path: Path, size: int = 256) -> tuple[bool, int]:
    """Fetch a single Helioviewer JPG thumb via the local proxy."""
    iso = f"{date}T{time_utc}:00Z"
    qs = urlencode({
        "date": iso,
        "wavelength": wavelength,
        "image_scale": 12,
        "size": size,
    })
    url = f"{local_base}/api/helioviewer_thumb?{qs}"
    try:
        r = requests.get(url, timeout=60)
        if r.status_code != 200:
            return (False, r.status_code)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(r.content)
        return (True, len(r.content))
    except Exception as e:
        print(f"  [error] {url}: {type(e).__name__}: {e}", file=sys.stderr)
        return (False, 0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", default="http://localhost:8001",
                        help="Local API base for HEK + Helioviewer proxy.")
    parser.add_argument("--out", default="./default_cache",
                        help="Cache root (mirrors the server's DEFAULT_CACHE_DIR).")
    parser.add_argument("--throttle-ms", type=int, default=200,
                        help="Sleep N ms between thumb fetches (default 200 = 5 req/s).")
    args = parser.parse_args()

    local = args.local.rstrip("/")
    out_root = Path(args.out).resolve()
    vibe_dir = out_root / "vibe"
    manifest_path = out_root / "vibe_manifest.json"

    # Load existing manifest (preserves the raw_full_url + rhef_full_url
    # entries from the earlier HQ warm).
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text())
        except Exception:
            existing = {}
    else:
        existing = {}
    vibes = (existing.get("vibes") or {})

    t0 = time.time()
    total_thumbs = 0
    total_bytes = 0
    failures = []

    for vibe in _VIBE_GRID_TUPLES:
        slug = vibe["slug"]
        date = vibe["date"]
        print(f"\n=== {slug} ({date}) ===")
        events = _fetch_top_events(local, date)

        # Preserve any existing fields for this slug (full_url, etc.).
        slug_entry = vibes.get(slug, {})
        slug_entry["date"] = date
        slug_entry.setdefault("ok", True)
        event_entries = []

        for ev in events:
            rank = ev.get("rank", 1)
            time_utc = ev.get("time_utc") or "12:00"
            time_dir = time_utc.replace(":", "_")  # 12:24 → 12_24
            event_block = {
                "rank": rank,
                "rank_label": ev.get("rank_label"),
                "time_utc": time_utc,
                "peak_time_iso": ev.get("peak_time_iso"),
                "event_type": ev.get("event_type"),
                "event_code": ev.get("event_code"),
                "goes_class": ev.get("goes_class"),
                "intensity_label": ev.get("intensity_label"),
                "fallback": bool(ev.get("fallback")),
                "wavelengths": {},
            }
            for wl in WAVELENGTHS:
                rel = f"vibe/{slug}/events/{rank}/{wl}/jpg_thumb.png"
                out_path = out_root / rel
                ok, n = _fetch_thumb(local, date, time_utc, wl, out_path)
                if ok:
                    total_thumbs += 1
                    total_bytes += n
                    event_block["wavelengths"][str(wl)] = {
                        "jpg_thumb_url": f"/asset/default/{rel}",
                    }
                    print(f"  rank={rank} {time_utc} {wl}Å  → {n//1024} KB")
                else:
                    failures.append((slug, rank, time_utc, wl, n))
                    print(f"  rank={rank} {time_utc} {wl}Å  → FAIL ({n})")
                time.sleep(args.throttle_ms / 1000.0)
            event_entries.append(event_block)

        slug_entry["events"] = event_entries
        vibes[slug] = slug_entry

    # Write the updated manifest atomically.
    out_payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "vibes": vibes,
    }
    tmp = manifest_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(out_payload, indent=2))
    os.replace(tmp, manifest_path)

    elapsed = time.time() - t0
    print(f"\n=== done in {elapsed:.1f}s ===")
    print(f"  thumbs written: {total_thumbs}")
    print(f"  total bytes:    {total_bytes/1024/1024:.1f} MB")
    print(f"  failures:       {len(failures)}")
    if failures:
        for f in failures[:10]:
            print(f"    - {f}")
        if len(failures) > 10:
            print(f"    ... and {len(failures)-10} more")
    print(f"\nmanifest: {manifest_path}")
    print(f"upload to prod with: api/scripts/warm_and_upload_vibe.sh "
          f"(or curl --data-binary @bundle.tar.gz the upload_vibe_bundle endpoint)")


if __name__ == "__main__":
    main()
