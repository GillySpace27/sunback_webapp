"""Warm the per-vibe HQ JPG (1024²) for the master-toggle "JPG" tier.

Existing tiers per vibe (at the slug top level of vibe_manifest.json):
    raw_full_url   — HQ Raw  (4096²)  — exists for all 11 after HQ warm
    rhef_full_url  — HQ RHEF (4096²)  — exists for all 11 after HQ warm
    raw_thumb_url  — 256² Raw thumb
    rhef_thumb_url — 256² RHEF thumb

This script adds:
    jpg_hq_url     — HQ JPG  (1024²)  — Helioviewer takeScreenshot at the
                                        vibe's primary (date, time, wl)

1024² (not 4096²) per the user's call — JPG is for at-a-glance viewing
in the vibe card; the editor preview canvas is ~600 px on screen so
1024² has headroom for retina without ballooning bundle size (each
JPG ~80-200 KB vs ~3 MB at 4096²).

Cached at default_cache/vibe/<slug>/jpg_hq.png. Run after the JPG
thumb warm has populated vibe_manifest.json's per-event structure.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlencode

try:
    import requests
except ImportError:
    print("requests not installed.", file=sys.stderr)
    sys.exit(2)


# Mirrors api/main.py:_VIBE_GRID_TUPLES so the script is standalone.
_VIBE_GRID_TUPLES = [
    {"slug": "ar2192",                     "date": "2014-10-24", "wavelength": 193,  "time": "12:00"},
    {"slug": "x93_flare",                  "date": "2017-09-06", "wavelength": 211,  "time": "12:02"},
    {"slug": "mothers_day_storm",          "date": "2024-05-10", "wavelength": 193,  "time": "17:00"},
    {"slug": "monster_prominence",         "date": "2012-08-31", "wavelength": 304,  "time": "20:00"},
    {"slug": "limb_x82_flare",             "date": "2017-09-10", "wavelength": 211,  "time": "16:06"},
    {"slug": "pre_x93_powderkeg",          "date": "2017-09-04", "wavelength": 94,   "time": "12:00"},
    {"slug": "post_flare_arcade",          "date": "2012-07-19", "wavelength": 131,  "time": "06:00"},
    {"slug": "great_sympathetic_eruption", "date": "2010-08-01", "wavelength": 171,  "time": "02:00"},
    {"slug": "ar13664_emergence",          "date": "2024-05-08", "wavelength": 335,  "time": "12:00"},
    {"slug": "x16_flare_ribbons",          "date": "2014-09-10", "wavelength": 1600, "time": "17:45"},
    {"slug": "ar2192_photosphere",         "date": "2014-10-24", "wavelength": 1700, "time": "12:00"},
]

SIZE_HQ = 1024


def _fetch_hq_jpg(local_base: str, date: str, time_utc: str, wavelength: int, out_path: Path):
    """Fetch ONE Helioviewer screenshot at 1024² via the local proxy."""
    iso = f"{date}T{time_utc}:00Z"
    qs = urlencode({
        "date": iso,
        "wavelength": wavelength,
        # image_scale ≈ 12 arcsec/px for 256² covers the full disk; for
        # 1024² we want a smaller scale to fit the same disk at 4× zoom.
        # Helioviewer's takeScreenshot accepts arbitrary scales; the
        # `size` query our proxy supports clips/letterboxes the output.
        "image_scale": 3,
        "size": SIZE_HQ,
    })
    url = f"{local_base}/api/helioviewer_thumb?{qs}"
    try:
        r = requests.get(url, timeout=90)
        if r.status_code != 200:
            return (False, r.status_code, 0)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(r.content)
        return (True, 200, len(r.content))
    except Exception as e:
        print(f"  error: {type(e).__name__}: {e}", file=sys.stderr)
        return (False, 0, 0)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", default="http://localhost:8001")
    parser.add_argument("--out", default="./default_cache")
    parser.add_argument("--throttle-ms", type=int, default=300,
                        help="Sleep N ms between fetches (default 300).")
    parser.add_argument("--skip-existing", action="store_true",
                        help="Skip vibes whose jpg_hq.png is already on disk.")
    args = parser.parse_args()

    local = args.local.rstrip("/")
    out_root = Path(args.out).resolve()
    manifest_path = out_root / "vibe_manifest.json"
    if not manifest_path.exists():
        print(f"ERROR: {manifest_path} doesn't exist.", file=sys.stderr)
        sys.exit(2)

    manifest = json.loads(manifest_path.read_text())
    vibes = manifest.setdefault("vibes", {})

    t0 = time.time()
    ok = skip = fail = 0
    total_bytes = 0
    for v in _VIBE_GRID_TUPLES:
        slug = v["slug"]
        date = v["date"]
        time_utc = v["time"]
        wl = v["wavelength"]
        rel = f"vibe/{slug}/jpg_hq.png"
        out_path = out_root / rel
        if args.skip_existing and out_path.exists() and out_path.stat().st_size > 1000:
            print(f"  [skip] {slug} ({date} {time_utc} {wl}Å)")
            slug_entry = vibes.setdefault(slug, {})
            slug_entry.setdefault("jpg_hq_url", f"/asset/default/{rel}")
            skip += 1
            continue
        print(f"  [fetch] {slug} ({date} {time_utc} {wl}Å) → {SIZE_HQ}² JPG …", flush=True)
        success, status, nbytes = _fetch_hq_jpg(local, date, time_utc, wl, out_path)
        if success:
            ok += 1
            total_bytes += nbytes
            slug_entry = vibes.setdefault(slug, {})
            slug_entry["jpg_hq_url"] = f"/asset/default/{rel}"
            print(f"    {nbytes//1024} KB")
        else:
            fail += 1
            print(f"    FAIL (status={status})")
        time.sleep(args.throttle_ms / 1000.0)

    manifest["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp = manifest_path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(manifest, indent=2))
    os.replace(tmp, manifest_path)

    elapsed = time.time() - t0
    print(f"\n=== done in {elapsed:.1f}s ===")
    print(f"  ok:    {ok}")
    print(f"  skip:  {skip}")
    print(f"  fail:  {fail}")
    print(f"  bytes: {total_bytes/1024:.0f} KB")
    print(f"  manifest: {manifest_path}")


if __name__ == "__main__":
    main()
