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


def _fetch_fits(date: str, time_utc: str, wavelength: int, max_attempts: int = 5):
    """Fetch ONE AIA FITS frame nearest the (date, time, wl) target.
    Reuses SunPy's on-disk cache so re-runs are fast.

    Retries on TWO transient failure modes observed in practice:
      1. Socket timeouts (Fido.search raises) — Stanford VSO under load.
      2. Empty result sets (Fido.search returns 0 rows) — VSO's silent
         throttle when multiple queries arrive from the same IP
         quickly. Direct sequential queries to the SAME tuple return
         10+ frames; parallel workers got empty responses. Treating
         empty as transient + backing off lets the throttle clear.

    Real "no data" days (rare for AIA, which has been continuous since
    2010) will exhaust the retry budget and return None — that's the
    right outcome.
    """
    hh, mm = (int(x) for x in time_utc.split(":"))
    t = datetime.strptime(date, "%Y-%m-%d").replace(hour=hh, minute=mm)
    # Widened to ±2 min so slower-cadence UV bands (1600/1700 at 24s)
    # and slightly off-peak times still hit at least one frame.
    window = timedelta(seconds=120)
    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            res = Fido.search(
                a.Time(t - window, t + window),
                a.Instrument("AIA"),
                a.Wavelength(wavelength * u.angstrom),
            )
            if not len(res) or not len(res[0]):
                # Empty result — treat as transient throttle. Sleep
                # progressively longer before retrying.
                if attempt >= max_attempts:
                    return None
                backoff = 3.0 + (attempt * 2.0)  # 5, 7, 9, 11 s
                print(f"    [empty retry {attempt}/{max_attempts}] {date} {time_utc} {wavelength}Å → wait {backoff}s",
                      flush=True)
                time.sleep(backoff)
                continue
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
                raise
            backoff = 2.0 ** (attempt - 1)  # 1, 2, 4, 8, 16 s
            print(f"    [retry {attempt}/{max_attempts}] {type(e).__name__}: {e} → wait {backoff}s",
                  flush=True)
            time.sleep(backoff)
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


# ── Worker entry point (must be module-level for multiprocessing pickling) ──
def _render_combo_worker(task: dict) -> dict:
    """Render one (slug, rank, wl) combo. Returns a result dict the
    coordinator uses to update the manifest. Each worker is its own
    process with its own SunPy / matplotlib state; no shared mutable
    state.

    task keys: slug, date, rank, time_utc, wl, out_root_str, skip_existing
    Returns:   slug, rank, wl, status (ok/skipped/no_fits/failed), msg,
               wall_seconds, urls (when ok or skipped)
    """
    slug = task["slug"]
    date = task["date"]
    rank = task["rank"]
    time_utc = task["time_utc"]
    wl = task["wl"]
    out_root = Path(task["out_root_str"])
    skip_existing = task.get("skip_existing", False)
    out_dir = out_root / "vibe" / slug / "events" / str(rank) / str(wl)
    rel = f"vibe/{slug}/events/{rank}/{wl}"
    urls = {
        "raw_thumb_url":  f"/asset/default/{rel}/raw_thumb.png",
        "raw_mq_url":     f"/asset/default/{rel}/raw_mq.png",
        "rhef_thumb_url": f"/asset/default/{rel}/rhef_thumb.png",
        "rhef_mq_url":    f"/asset/default/{rel}/rhef_mq.png",
    }
    expected = [out_dir / Path(u).name for u in
                ("raw_thumb.png", "raw_mq.png", "rhef_thumb.png", "rhef_mq.png")]
    if skip_existing and all(p.exists() and p.stat().st_size > 1000 for p in expected):
        return {"slug": slug, "rank": rank, "wl": wl, "status": "skipped",
                "msg": "", "wall_seconds": 0.0, "urls": urls}

    t0 = time.time()
    try:
        smap = _fetch_fits(date, time_utc, wl)
        if smap is None:
            return {"slug": slug, "rank": rank, "wl": wl, "status": "no_fits",
                    "msg": "no FITS in window", "wall_seconds": time.time() - t0,
                    "urls": None}
        _render_one(smap, wl, out_dir)
        return {"slug": slug, "rank": rank, "wl": wl, "status": "ok",
                "msg": "", "wall_seconds": time.time() - t0, "urls": urls}
    except Exception as e:
        return {"slug": slug, "rank": rank, "wl": wl, "status": "failed",
                "msg": f"{type(e).__name__}: {e}",
                "wall_seconds": time.time() - t0, "urls": None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", default="http://localhost:8001")
    parser.add_argument("--out", default="./default_cache")
    parser.add_argument("--skip-existing", action="store_true",
                        help="Skip combos where all 4 PNGs already exist.")
    parser.add_argument("--only", default="",
                        help="Comma-separated subset of vibe slugs (default: all).")
    parser.add_argument("--workers", type=int, default=1,
                        help="Parallel worker processes (default 1). Each holds "
                             "~600 MB while rendering; 8 workers ≈ 5 GB resident. "
                             "VSO tolerates ~8 parallel fetches comfortably; higher "
                             "risks per-IP rate-limiting. The retry-on-timeout logic "
                             "absorbs occasional throttling either way.")
    parser.add_argument("--manifest-flush-every", type=int, default=4,
                        help="Flush the manifest to disk every N completed tasks "
                             "(default 4). Lower = more disk churn but smaller loss "
                             "window on crash.")
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
    print(f"warming {len(selected_vibes)} vibe(s) with {args.workers} worker(s): "
          f"{[v['slug'] for v in selected_vibes]}")

    # Build the full task list. Each task is one (slug, rank, wl) combo
    # that the worker will check + maybe-render. Worker decides whether
    # to skip based on existing files (so the orchestrator stays dumb).
    tasks = []
    for vibe in selected_vibes:
        slug = vibe["slug"]
        date = vibe["date"]
        slug_entry = vibes.get(slug) or {}
        events = slug_entry.get("events") or _fetch_top_events(local, date)
        slug_entry["events"] = events
        vibes[slug] = slug_entry
        for ev_idx, ev in enumerate(events):
            rank = ev.get("rank") or (ev_idx + 1)
            time_utc = ev.get("time_utc") or "12:00"
            for wl in WAVELENGTHS:
                tasks.append({
                    "slug": slug, "date": date, "rank": rank,
                    "time_utc": time_utc, "wl": wl,
                    "out_root_str": str(out_root),
                    "skip_existing": bool(args.skip_existing),
                })
    print(f"task queue: {len(tasks)} combos")

    t0 = time.time()
    rendered = skipped = failed = no_fits = 0
    pending_writes = 0

    def _apply_result(r: dict):
        nonlocal pending_writes
        slug = r["slug"]
        rank = r["rank"]
        wl = r["wl"]
        status = r["status"]
        msg = r["msg"]
        wall = r["wall_seconds"]
        urls = r["urls"]
        tag = f"{slug} rank={rank} {wl}Å"
        if status == "ok":
            print(f"  [ok    ] {tag:50s} {wall:5.1f}s")
        elif status == "skipped":
            print(f"  [cached] {tag}")
        elif status == "no_fits":
            print(f"  [empty ] {tag} — no FITS in window")
        else:
            print(f"  [FAIL  ] {tag} — {msg}")
        # Update manifest in-memory.
        if urls:
            slug_entry = vibes.setdefault(slug, {})
            events = slug_entry.setdefault("events", [])
            ev = next((e for e in events if (e.get("rank") or 1) == rank), None)
            if ev is not None:
                wl_map = ev.setdefault("wavelengths", {})
                wl_entry = wl_map.setdefault(str(wl), {})
                wl_entry.update(urls)
                pending_writes += 1

    def _flush_manifest():
        manifest["vibes"] = vibes
        manifest["generated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        tmp = manifest_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(manifest, indent=2))
        os.replace(tmp, manifest_path)

    if args.workers <= 1:
        # Serial path — same behaviour as the original script, useful
        # for debugging without the multiprocessing layer.
        for task in tasks:
            r = _render_combo_worker(task)
            _apply_result(r)
            if r["status"] == "ok": rendered += 1
            elif r["status"] == "skipped": skipped += 1
            elif r["status"] == "no_fits": no_fits += 1
            else: failed += 1
            if pending_writes >= args.manifest_flush_every:
                _flush_manifest()
                pending_writes = 0
    else:
        # Parallel path — multiprocessing.Pool, results come back as
        # each task finishes (unordered). The coordinator (this process)
        # owns the manifest and writes it every N completions so a kill
        # mid-run loses at most N tasks of progress.
        import multiprocessing as mp
        # Use 'spawn' (Python 3.8+ default on macOS anyway): a fork()-
        # safe re-import of sunpy/matplotlib in each worker.
        ctx = mp.get_context("spawn")
        with ctx.Pool(processes=args.workers) as pool:
            for r in pool.imap_unordered(_render_combo_worker, tasks):
                _apply_result(r)
                if r["status"] == "ok": rendered += 1
                elif r["status"] == "skipped": skipped += 1
                elif r["status"] == "no_fits": no_fits += 1
                else: failed += 1
                if pending_writes >= args.manifest_flush_every:
                    _flush_manifest()
                    pending_writes = 0

    _flush_manifest()  # final flush

    elapsed = time.time() - t0
    print(f"\n=== done in {elapsed/60:.1f} min ===")
    print(f"  rendered: {rendered}")
    print(f"  skipped:  {skipped}")
    print(f"  no_fits:  {no_fits}")
    print(f"  failed:   {failed}")
    print(f"  manifest: {manifest_path}")


if __name__ == "__main__":
    main()
