"""Warm the per-event Raw + RHEF MQ (1024²) + Thumb (256²) renders.

Companion to scripts/warm_vibe_jpg_thumbs.py — that script cached the
135 JPG thumbnails from Helioviewer; this one renders the FITS-derived
science PNGs locally with SunPy + sunkit-image, at two sizes per tier:

  - thumb 256²  — wavelength-tile previews when master tier is Raw/RHEF
  - mq    1024² — editor canvas preview before HQ render lands

For each of the 5 vibe cards × 3 top events × 9 AIA wavelengths = 135
combos, this writes 4 files (raw_thumb, raw_mq, rhef_thumb, rhef_mq) =
540 PNGs total. Each combo needs one FITS fetch (~30-60 s cold) +
matplotlib render → bottleneck is the FITS download. Wall clock on a
developer Mac: ~2-3 hours cold, ~30 min when SunPy's FITS cache is
warm from a prior run.

Run via:
    python3 api/scripts/warm_vibe_mq.py [--local URL] [--out DIR]

Defaults: --local http://localhost:8001, --out ./default_cache. The
local server is the source of HEK event lookups; the actual FITS
fetch + rendering happen via SunPy/matplotlib in this script's
process (NOT in the server's process — that's the whole point: keep
the heavy compute off the 2 GB Render box).

Extends `default_cache/vibe_manifest.json` in place — each per-
wavelength entry in `vibes[slug].events[i].wavelengths[wl]` gains
four new fields:
    {
      "jpg_thumb_url":  ...,            # existing
      "raw_thumb_url":  ".../raw_thumb.png",
      "raw_mq_url":     ".../raw_mq.png",
      "rhef_thumb_url": ".../rhef_thumb.png",
      "rhef_mq_url":    ".../rhef_mq.png",
    }
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

try:
    import requests
    import numpy as np
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from sunpy.net import Fido, attrs as a
    from sunpy.map import Map
    from sunpy.visualization import colormaps  # noqa — registers sdoaia* maps
    from astropy import units as u
    from sunkit_image import radial
    from datetime import datetime, timedelta
    from PIL import Image
except ImportError as e:
    print(f"Required dep missing: {e}\n"
          "This script needs the same env as the FastAPI server (sunpy, "
          "sunkit-image, matplotlib, Pillow, requests).", file=sys.stderr)
    sys.exit(2)


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

WAVELENGTHS = [94, 131, 171, 193, 211, 304, 335, 1600, 1700]

# Render sizes. Thumb feeds the 256²-circle wavelength tile; MQ feeds
# the editor canvas preview before the HQ pipeline finishes.
SIZE_THUMB = 256
SIZE_MQ = 1024


def _aia_cmap(wavelength: int):
    """Match the server's `_vibe_pick_cmap` so renders look consistent
    with the existing primary-vibe HQ tiles."""
    key = f"sdoaia{int(wavelength)}"
    try:
        import matplotlib.cm
        return matplotlib.cm.get_cmap(key)
    except Exception:
        return matplotlib.cm.get_cmap("magma")


def _percentile_normalize(data):
    """Same stretch the server uses (0.1, 99.9 percentile clip)."""
    finite = data[np.isfinite(data)]
    if not finite.size:
        return 0.0, 1.0
    lo, hi = np.percentile(finite, (0.1, 99.9))
    if hi <= lo:
        hi = lo + 1.0
    return float(lo), float(hi)


def _fetch_fits(date: str, time_utc: str, wavelength: int, max_attempts: int = 4):
    """Fetch ONE AIA FITS frame nearest the (date, time, wl) target.
    Reuses SunPy's on-disk cache so re-runs are fast.

    Retries on VSO socket timeouts (the dominant failure mode in the
    first overnight run — 158 of 297 combos failed with
    "Timeout on reading data from socket" during Fido.search, mid-run
    when Stanford's VSO endpoint was under load). Exponential backoff
    between attempts. ±60s window (was ±30s) so even slower-cadence
    UV bands (1600/1700 at 24 s) get at least one frame.
    """
    hh, mm = (int(x) for x in time_utc.split(":"))
    t = datetime.strptime(date, "%Y-%m-%d").replace(hour=hh, minute=mm)
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            res = Fido.search(
                a.Time(t - timedelta(seconds=60), t + timedelta(seconds=60)),
                a.Instrument("AIA"),
                a.Wavelength(wavelength * u.angstrom),
            )
            if not len(res) or not len(res[0]):
                # Empty result is NOT retried — it usually means there
                # really wasn't an AIA frame in that window (vs a
                # timeout, which would have raised an exception).
                return None
            files = Fido.fetch(res[0, 0])
            if not files:
                return None
            return Map(files[0])
        except Exception as e:
            last_err = e
            msg = str(e).lower()
            transient = ("timeout" in msg or "connection" in msg or
                         "temporarily" in msg or "socket" in msg or
                         "read of closed" in msg)
            if not transient or attempt >= max_attempts:
                # Re-raise so the outer try/except logs FAILED with the real reason.
                raise
            backoff = 2.0 ** (attempt - 1)  # 1, 2, 4, 8 sec
            print(f"    [retry {attempt}/{max_attempts}] {type(e).__name__}: {e} → wait {backoff}s",
                  flush=True)
            time.sleep(backoff)
    # If we somehow exited the loop without returning or raising:
    if last_err:
        raise last_err
    return None


def _render_png(data, cmap, out_path: Path, size_px: int):
    """Render a NumPy array to a square PNG at the given pixel size."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    lo, hi = _percentile_normalize(data)
    dpi = 100
    fig_inches = size_px / dpi
    fig = plt.figure(figsize=(fig_inches, fig_inches), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    ax.imshow(data, cmap=cmap, origin="lower", vmin=lo, vmax=hi,
              interpolation="nearest")
    fig.savefig(str(out_path), dpi=dpi, pad_inches=0, transparent=False)
    plt.close(fig)


def _render_one(smap, wavelength: int, out_dir: Path) -> dict[str, str]:
    """Write the four PNGs (raw thumb+mq, rhef thumb+mq) for one
    (date, time, wl) tuple."""
    cmap = _aia_cmap(wavelength)
    raw = smap.data.astype(float)

    raw_mq = out_dir / "raw_mq.png"
    raw_th = out_dir / "raw_thumb.png"
    _render_png(raw, cmap, raw_mq, SIZE_MQ)
    _render_png(raw, cmap, raw_th, SIZE_THUMB)

    # RHEF on the same array — sunkit_image.radial.rhef accepts ndarray.
    try:
        rhef_data = radial.rhef(smap).data.astype(float)
    except Exception as e:
        # Fall back to passing the ndarray directly (some sunkit-image
        # versions accept either).
        print(f"  RHEF on Map failed ({type(e).__name__}: {e}); array fallback", flush=True)
        rhef_data = radial.rhef(smap.data.astype(float))
    rhef_mq = out_dir / "rhef_mq.png"
    rhef_th = out_dir / "rhef_thumb.png"
    _render_png(rhef_data, cmap, rhef_mq, SIZE_MQ)
    _render_png(rhef_data, cmap, rhef_th, SIZE_THUMB)

    return {
        "raw_thumb": raw_th,
        "raw_mq": raw_mq,
        "rhef_thumb": rhef_th,
        "rhef_mq": rhef_mq,
    }


def _fetch_top_events(local_base: str, date: str) -> list[dict]:
    url = f"{local_base}/api/hek/best_time?date={date}"
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    events = (r.json() or {}).get("events") or []
    if not events:
        events = [{"rank": 1, "time_utc": "12:00", "fallback": True}]
    return events[:3]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", default="http://localhost:8001")
    parser.add_argument("--out", default="./default_cache")
    parser.add_argument("--skip-existing", action="store_true",
                        help="Skip combos where all 4 PNGs already exist.")
    parser.add_argument("--only", default="",
                        help="Comma-separated subset of vibe slugs (default: all 5).")
    args = parser.parse_args()

    local = args.local.rstrip("/")
    out_root = Path(args.out).resolve()
    manifest_path = out_root / "vibe_manifest.json"
    if not manifest_path.exists():
        print(f"ERROR: {manifest_path} doesn't exist — run warm_vibe_jpg_thumbs.py first "
              "so the per-event manifest entries are in place.", file=sys.stderr)
        sys.exit(2)

    manifest = json.loads(manifest_path.read_text())
    vibes = manifest.get("vibes") or {}

    only = set(s.strip() for s in args.only.split(",") if s.strip())
    selected_vibes = [v for v in _VIBE_GRID_TUPLES if not only or v["slug"] in only]
    print(f"warming {len(selected_vibes)} vibe(s): {[v['slug'] for v in selected_vibes]}")

    t0 = time.time()
    rendered = 0
    skipped = 0
    failed = 0

    for vibe in selected_vibes:
        slug = vibe["slug"]
        date = vibe["date"]
        slug_entry = vibes.get(slug) or {}
        events = slug_entry.get("events") or _fetch_top_events(local, date)

        for ev_idx, ev in enumerate(events):
            rank = ev.get("rank") or (ev_idx + 1)
            time_utc = ev.get("time_utc") or "12:00"
            wl_map = ev.setdefault("wavelengths", {})

            for wl in WAVELENGTHS:
                out_dir = out_root / "vibe" / slug / "events" / str(rank) / str(wl)
                expected = [
                    out_dir / "raw_thumb.png", out_dir / "raw_mq.png",
                    out_dir / "rhef_thumb.png", out_dir / "rhef_mq.png",
                ]
                if args.skip_existing and all(p.exists() and p.stat().st_size > 1000 for p in expected):
                    skipped += 1
                    print(f"  [skip cached] {slug} rank={rank} {time_utc} {wl}Å")
                    # Still ensure the manifest fields are present.
                    rel = f"vibe/{slug}/events/{rank}/{wl}"
                    wl_entry = wl_map.setdefault(str(wl), {})
                    wl_entry.setdefault("raw_thumb_url",  f"/asset/default/{rel}/raw_thumb.png")
                    wl_entry.setdefault("raw_mq_url",     f"/asset/default/{rel}/raw_mq.png")
                    wl_entry.setdefault("rhef_thumb_url", f"/asset/default/{rel}/rhef_thumb.png")
                    wl_entry.setdefault("rhef_mq_url",    f"/asset/default/{rel}/rhef_mq.png")
                    continue

                stamp = time.time()
                print(f"  [render]  {slug} rank={rank} {time_utc} {wl}Å …", flush=True)
                try:
                    smap = _fetch_fits(date, time_utc, wl)
                    if smap is None:
                        print(f"    no FITS available — skipping", flush=True)
                        failed += 1
                        continue
                    _render_one(smap, wl, out_dir)
                    rel = f"vibe/{slug}/events/{rank}/{wl}"
                    wl_entry = wl_map.setdefault(str(wl), {})
                    wl_entry["raw_thumb_url"]  = f"/asset/default/{rel}/raw_thumb.png"
                    wl_entry["raw_mq_url"]     = f"/asset/default/{rel}/raw_mq.png"
                    wl_entry["rhef_thumb_url"] = f"/asset/default/{rel}/rhef_thumb.png"
                    wl_entry["rhef_mq_url"]    = f"/asset/default/{rel}/rhef_mq.png"
                    rendered += 1
                    print(f"    done in {time.time()-stamp:.1f}s", flush=True)
                except Exception as e:
                    print(f"    FAILED: {type(e).__name__}: {e}", flush=True)
                    failed += 1
                # Incremental manifest write so a crash mid-warm
                # preserves what we already rendered.
                ev["wavelengths"] = wl_map
                slug_entry["events"] = events
                vibes[slug] = slug_entry
                manifest["vibes"] = vibes
                manifest["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                tmp = manifest_path.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(manifest, indent=2))
                os.replace(tmp, manifest_path)

    elapsed = time.time() - t0
    print(f"\n=== done in {elapsed/60:.1f} min ===")
    print(f"  rendered: {rendered}")
    print(f"  skipped:  {skipped}")
    print(f"  failed:   {failed}")
    print(f"  manifest: {manifest_path}")


if __name__ == "__main__":
    main()
