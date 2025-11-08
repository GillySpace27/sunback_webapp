# sunback/webapp/api/main.py
# FastAPI backend for Solar Archive — date→FITS via SunPy→filtered PNG→(optional) Printful upload

from __future__ import annotations


import os


# Ensure output directory exists
OUTPUT_DIR = os.environ.get("SOLAR_ARCHIVE_OUTPUT_DIR", "/tmp/output")
os.makedirs(OUTPUT_DIR, exist_ok=True)
print(f"[startup] Using SOLAR_ARCHIVE_OUTPUT_DIR={OUTPUT_DIR}")


import sys

# Detect Render environment and set writable paths
if os.getenv("RENDER"):
    base_tmp = "/tmp/sunpy"
else:
    base_tmp = os.path.expanduser("~/.sunpy")

os.environ["SUNPY_CONFIGDIR"] = os.path.join(base_tmp, "config")
os.environ["SUNPY_DOWNLOADDIR"] = os.path.join(base_tmp, "data")
os.environ["REQUESTS_CA_BUNDLE"] = os.environ.get("REQUESTS_CA_BUNDLE", "/etc/ssl/cert.pem")
os.environ["SSL_CERT_FILE"] = os.environ.get("SSL_CERT_FILE", "/etc/ssl/cert.pem")
os.environ["VSO_URL"] = "http://vso.stanford.edu/cgi-bin/VSO_GETDATA.cgi"

os.makedirs(os.environ["SUNPY_DOWNLOADDIR"], exist_ok=True)

print(f"[startup] SunPy config_dir={os.environ['SUNPY_CONFIGDIR']}", flush=True)
print(f"[startup] SunPy download_dir={os.environ['SUNPY_DOWNLOADDIR']}", flush=True)
print(f"[startup] Using SSL_CERT_FILE={os.environ['SSL_CERT_FILE']}", flush=True)
print(f"[startup] Using VSO_URL={os.environ['VSO_URL']}", flush=True)


import io
import json
import hashlib
import time
import subprocess
from datetime import datetime, timedelta
from typing import Optional, Literal, Dict, Any
import numpy as np
import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse, FileResponse
from sse_starlette.sse import EventSourceResponse
import asyncio
from pydantic import BaseModel, Field
from sunpy.visualization import colormaps  # registers all SunPy maps like sdoaia171, sohoeit195, etc.
import matplotlib
matplotlib.use("Agg")
from astropy import units as u
import matplotlib.pyplot as plt
from sunkit_image import radial
rhef = radial.rhef
from sunpy.net import Fido, attrs as a
from sunpy.net import vso
from sunpy.map import Map
import warnings
warnings.filterwarnings("ignore", category=UserWarning, module="parfive.downloader")

# Synchronous fetch helper with clear log
def fetch_sync_safe(query):
    print("[fetch] Fido.fetch (sync, max_conn=10, no progress)", flush=True)
    from parfive import Downloader
    dl = Downloader(
        max_conn=10,
        progress=False,
        overwrite=False
    )
    return Fido.fetch(query, downloader=dl)



# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────
APP_NAME = "Solar Archive Backend"
OUTPUT_DIR = os.getenv("SOLAR_ARCHIVE_OUTPUT_DIR", os.path.join(base_tmp, "output"))
ASSET_BASE_URL = os.getenv("SOLAR_ARCHIVE_ASSET_BASE_URL", "")  # e.g., CDN base; else empty for local
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Printful
PRINTFUL_API_KEY = os.getenv("PRINTFUL_API_KEY", "")
PRINTFUL_BASE_URL = os.getenv("PRINTFUL_BASE_URL", "https://api.printful.com")

# Defaults
DEFAULT_AIA_WAVELENGTH = 211 * u.angstrom
DEFAULT_EIT_WAVELENGTH = 195 * u.angstrom
DEFAULT_DETECTOR_LASCO = "C2"  # or "C3"

# Mission thresholds (rough, practical)
SDO_EPOCH = datetime(2010, 5, 15)    # after which AIA is widely available
SOHO_EPOCH = datetime(1996, 1, 1)    # after which EIT/LASCO is available

# JSOC Email placeholder for JSOCClient (used for SDO/AIA direct fetches)
JSOC_EMAIL = os.getenv("JSOC_EMAIL", "chris.gilly@colorado.edu")

# ──────────────────────────────────────────────────────────────────────────────
# FastAPI app
# ──────────────────────────────────────────────────────────────────────────────
app = FastAPI(title=APP_NAME)


@app.get("/debug/vso")
def debug_vso():
    """
    Direct VSO connectivity test.
    Forces a fresh VSOClient connection and prints providers + results.
    """
    from sunpy.net.vso import VSOClient
    from astropy import units as u
    from sunpy.net import attrs as a

    print("[status] Initializing VSOClient...", flush=True)
    client = VSOClient()
    try:
        client.registry.load()
    except Exception as e:
        print(f"[debug_vso] Registry load exception: {e}", flush=True)

    try:
        qr = client.search(
            a.Time("2019-06-01", "2019-06-02"),
            a.Instrument("AIA"),
            a.Wavelength(171 * u.angstrom),
            a.Source("SDO")
        )
        n_results = len(qr) if hasattr(qr, "__len__") else 0
        print(f"[status] VSO search: {n_results} results.", flush=True)

        # Compatibility: SunPy >=5.x has no .responses
        if hasattr(qr, "responses"):
            providers = list({r.provider for r in qr.responses})
        elif hasattr(qr, "provider"):
            providers = list(set(qr.provider))
        else:
            providers = ["unknown"]

                # Build sample rows safely for modern SunPy (Astropy Table rows)
        sample_rows = []
        if n_results > 0:
            for i in range(min(3, n_results)):
                try:
                    row = qr[i]
                    # Try astropy.Table row conversion first
                    if hasattr(row, "as_void") or hasattr(row, "as_void_tuple"):
                        row_dict = {col: str(row[col]) for col in qr.colnames}
                    elif hasattr(row, "asdict"):
                        row_dict = {k: str(v) for k, v in row.asdict().items()}
                    else:
                        row_dict = dict(row)
                    sample_rows.append(row_dict)
                except Exception as err:
                    print(f"[status] Error serializing row {i}: {err}", flush=True)

        # Build summary lines
        summary_lines = []
        try:
            for row in sample_rows:
                wl = row.get("wavelength", "")
                t_start = row.get("time_start", row.get("start_time", ""))
                t_end = row.get("time_end", row.get("end_time", ""))
                provider = row.get("provider", "")
                line = f"{wl} Å — {t_start} to {t_end} — Provider: {provider}"
                summary_lines.append(line)
        except Exception as err:
            print(f"[status] Exception building summary: {err}", flush=True)
            summary_lines = []

        return {
            "num_results": int(n_results),
            "providers": [str(p) for p in providers],
            "sample_rows": sample_rows,
            "summary": summary_lines,
        }
    except Exception as e:
        print(f"[status] Exception during search: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"VSO search failed: {e}")
@app.get("/debug/env")


def debug_env():
    return {
        "sunpy_configdir": os.environ.get("SUNPY_CONFIGDIR"),
        "sunpy_downloaddir": os.environ.get("SUNPY_DOWNLOADDIR"),
        "ssl_cert_file": os.environ.get("SSL_CERT_FILE"),
        "requests_ca_bundle": os.environ.get("REQUESTS_CA_BUNDLE"),
        "cwd": os.getcwd(),
        "user": os.getenv("USER") or os.getenv("USERNAME"),
    }
# ──────────────────────────────────────────────────────────────────────────────
# Models
# ──────────────────────────────────────────────────────────────────────────────
class GenerateRequest(BaseModel):
    date: str = Field(..., description="YYYY-MM-DD (UTC) to render")
    mission: Optional[Literal["auto", "SDO", "SOHO-EIT", "SOHO-LASCO"]] = "auto"
    wavelength: Optional[int] = Field(None, description="Angstroms for AIA/EIT (e.g., 211 or 195)")
    detector: Optional[Literal["C2", "C3"]] = DEFAULT_DETECTOR_LASCO
    upload_to_printful: bool = False
    dry_run: bool = False
    annotate: bool = True
    png_dpi: int = 300
    png_size_inches: float = 10.0  # square figure size; 10in at 300dpi → 3000px
    # optional per-product metadata for Printful (kept generic)
    printful_purpose: Optional[str] = "poster"
    title: Optional[str] = None

# ──────────────────────────────────────────────────────────────────────────────
# Utility: pick mission by date
# ──────────────────────────────────────────────────────────────────────────────
def choose_mission(dt: datetime) -> str:
    if dt >= SDO_EPOCH:
        return "SDO"
    if dt >= SOHO_EPOCH:
        return "SOHO-EIT"
    return "SOHO-LASCO"

# ──────────────────────────────────────────────────────────────────────────────
# Fido fetch helpers
# ──────────────────────────────────────────────────────────────────────────────
def manual_aiaprep(smap):
    """
    Manual replacement for aiaprep using aiapy calibration routines.
    Performs:
      1) update_pointing with a retrieved pointing table (if available),
      2) register to common plate scale and north-up,
      3) exposure normalization via EXPTIME.
    Falls back gracefully if any step is unavailable.
    """
    # from sunpy.map import Map
    from astropy import units as u
    # aiapy calibrations
    try:
        from aiapy.calibrate import update_pointing, register
        try:
            from aiapy.calibrate import get_pointing  # preferred API
        except Exception:
            get_pointing = None
    except Exception as e:
        print(f"[fetch] [AIA] aiapy.calibrate unavailable ({e}); skipping manual prep.", flush=True)
        return smap
    # Try to obtain a pointing table in a version-agnostic way
    pointing_table = None
    if 'AIA' in str(smap.meta.get('instrume', smap.meta.get('instrument', ''))).upper():
        # Best-effort retrieval of pointing table
        if get_pointing is not None:
            try:
                # First try signature that accepts the Map directly
                pointing_table = get_pointing(smap)
            except TypeError:
                # Fallback to passing a time (or small range) if required by the installed aiapy
                try:
                    from sunpy.time import parse_time
                    t = getattr(smap, 'date', None)
                    if t is None:
                        t = parse_time(smap.meta.get('date-obs') or smap.meta.get('DATE-OBS'))
                    # Some versions accept a single time, others expect a range; try single time first
                    try:
                        pointing_table = get_pointing(t)
                    except Exception:
                        # Final fallback: small window around the observation time
                        from datetime import timedelta
                        t0 = t - timedelta(minutes=10)
                        t1 = t + timedelta(minutes=10)
                        pointing_table = get_pointing(t0, t1)
                except Exception as pt_err:
                    print(f"[fetch] [AIA] get_pointing fallback failed: {pt_err}", flush=True)
        else:
            # Manual pointing alignment fallback if get_pointing is unavailable
            try:
                from sunpy.coordinates import frames
                from sunpy.coordinates.ephemeris import get_body_heliographic_stonyhurst
                import astropy.units as u
                from astropy.coordinates import SkyCoord
                import numpy as np

                # Rough recentering on the solar disk using CRPIX and RSUN metadata
                meta = smap.meta.copy()
                rsun_obs = meta.get("rsun_obs")
                crpix1, crpix2 = meta.get("crpix1"), meta.get("crpix2")
                if rsun_obs and crpix1 and crpix2:
                    # Estimate offset from center
                    x_center, y_center = smap.data.shape[1] / 2, smap.data.shape[0] / 2
                    shift_x = x_center - crpix1
                    shift_y = y_center - crpix2
                    shifted_data = np.roll(smap.data, int(round(shift_y)), axis=0)
                    shifted_data = np.roll(shifted_data, int(round(shift_x)), axis=1)
                    meta["crpix1"] = x_center
                    meta["crpix2"] = y_center
                    smap = Map(shifted_data, meta)
                    # print("[fetch] [AIA] Performed rough manual recentering due to missing get_pointing().", flush=True)
            except Exception as manual_err:
                print(f"[fetch] [AIA] Manual recentering failed: {manual_err}", flush=True)
    # Apply pointing update if we obtained a table
    m = smap
    try:
        if pointing_table is not None:
            m = update_pointing(smap, pointing_table=pointing_table)
        else:
            m = smap
    except TypeError as te:
        print(f"[fetch] [AIA] update_pointing requires pointing_table on this aiapy version ({te}); skipping.", flush=True)
    except Exception as e:
        print(f"[fetch] [AIA] update_pointing failed: {e}; proceeding without.", flush=True)
    # Register (rotate to north-up, scale to 0.6 arcsec/pix, recenter)
    try:
        m = register(m)
    except Exception as reg_err:
        print(f"[fetch] [AIA] register failed: {reg_err}; continuing with unregistered map.", flush=True)
    # Exposure normalization
    try:
        if hasattr(m, "exposure_time") and m.exposure_time is not None:
            data_norm = m.data / m.exposure_time.to(u.s).value
            m = Map(data_norm, m.meta)
    except Exception as norm_err:
        print(f"[fetch] [AIA] Exposure normalization failed: {norm_err}", flush=True)
    return Map(m.data, m.meta)

def fido_fetch_map(dt: datetime, mission: str, wavelength: Optional[int], detector: Optional[str]) -> Map:
    """
    Retrieve a SunPy Map near the given date for the chosen mission.
    We search a small window around the date to find at least one file.
    For SDO/AIA, try JSOC first (with email), fallback to Fido if needed.
    """
    print(f"[fetch] mission={mission}, date={dt.date()}, wavelength={wavelength}, detector={detector}", flush=True)
    if mission == "SDO" and dt < SDO_EPOCH:
        print(f"[fetch] Date {dt.date()} before SDO; switching to SOHO-EIT.", flush=True)
        mission = "SOHO-EIT"
    start_time = time.time()

    # small search window to find nearest frame on that date
    t0 = dt
    t1 = dt + timedelta(minutes=2)

    # Caching for combined (summed) AIA data
    import numpy as _np
    combined_cache_file = None
    date_str = dt.strftime("%Y%m%d")
    if mission == "SDO":
        combined_cache_file = os.path.join(OUTPUT_DIR, f"temp_combined_{mission}_{date_str}.npz")
        if os.path.exists(combined_cache_file):
            print(f"[cache] Using cached combined map from {combined_cache_file}...", flush=True)
            with np.load(combined_cache_file, allow_pickle=True) as npz:
                combined_data = npz["data"]
                combined_meta = npz["meta"].item()
            combined_map = Map(combined_data, combined_meta)
            return combined_map

    if mission == "SDO":
        # Try JSOCClient first, with SunPy-version-agnostic attrs import
        try:
            from sunpy.net.jsoc.jsoc import JSOCClient
            from astropy import units as u
            wl = wavelength or int(DEFAULT_AIA_WAVELENGTH.value)
            try:
                from sunpy.net.jsoc import attrs as jsoc_attrs
                print("[fetch] [AIA] Using sunpy.net.jsoc.attrs (new SunPy) for JSOCClient search.", flush=True)
                attrset = "jsoc"
            except ImportError:
                from sunpy.net import attrs as a
                print("[fetch] [AIA] Using sunpy.net.attrs (legacy SunPy) for JSOCClient search.", flush=True)
                attrset = "legacy"
            jsoc = JSOCClient()
            jsoc._server = "https://jsoc.stanford.edu"
            # Search for AIA data near the given time
            if attrset == "jsoc":
                qr = jsoc.search(
                    jsoc_attrs.Time(t0, t0 + timedelta(minutes=2)),
                    jsoc_attrs.Series("aia.lev1_euv_12s"),
                    jsoc_attrs.Wavelength(wl * u.angstrom),
                    jsoc_attrs.Segment("image"),
                    jsoc_attrs.Notify(JSOC_EMAIL)
                )
            else:
                qr = jsoc.search(
                    a.Time(t0, t0 + timedelta(minutes=2)),
                    a.Instrument("AIA"),
                    a.Wavelength(wl * u.angstrom),
                    a.Series("lev1_euv_12s"),
                    a.Notify(JSOC_EMAIL)
                )
            if len(qr) == 0:
                print(f"[fetch] [AIA] No JSOC results in ±1min, retrying ±10min...", flush=True)
                if attrset == "jsoc":
                    qr = jsoc.search(
                        jsoc_attrs.Time(t0, t0 + timedelta(minutes=10)),
                        jsoc_attrs.Series("aia.lev1_euv_12s"),
                        jsoc_attrs.Wavelength(wl * u.angstrom),
                        jsoc_attrs.Segment("image"),
                        jsoc_attrs.Notify(JSOC_EMAIL)
                    )
                else:
                    qr = jsoc.search(
                        a.Time(t0, t0 + timedelta(minutes=10)),
                        a.Instrument("AIA"),
                        a.Wavelength(wl * u.angstrom),
                        a.Series("lev1_euv_12s"),
                        a.Notify(JSOC_EMAIL)
                    )
            if len(qr) == 0:
                print(f"[fetch] [AIA] No JSOC results in ±10min, falling back to Fido.", flush=True)
                raise Exception("No JSOC results")
            # Download (first up to 5)
            print(f"[fetch] [AIA] JSOCClient: {len(qr)} results...", flush=True)
            from parfive import Downloader
            dl = Downloader(max_conn=10, progress=True)
            target_dir = os.environ["SUNPY_DOWNLOADDIR"]
            existing_files = [os.path.join(target_dir, os.path.basename(str(r))) for r in qr if os.path.exists(os.path.join(target_dir, os.path.basename(str(r))))]
            if existing_files:
                print(f"[fetch] Skipping re-download of existing files: {existing_files}", flush=True)
                files = existing_files
            else:
                files = jsoc.fetch(qr, path=target_dir, progress=True, downloader=dl)
                # Rewrite any JSOC HTTP URLs to HTTPS for secure download
                files = [f.replace("http://jsoc.stanford.edu", "https://jsoc.stanford.edu") for f in files]
                print(f"[fetch] Rewrote JSOC URLs to HTTPS ({len(files)} files).", flush=True)
                if not files or len(files) == 0:
                    print(f"[fetch] [AIA] JSOCClient fetch returned no files, falling back to Fido.", flush=True)
                    raise Exception("No files from JSOCClient fetch")
            maps = []
            for f in files:
                try:
                    m = Map(f)
                    m_prep = manual_aiaprep(m)
                    maps.append(m_prep)
                except Exception as e:
                    print(f"[fetch] [AIA] manual_aiaprep failed for {f}: {e}, using raw map.", flush=True)
                    maps.append(Map(f))
            print(f"[fetch] Loaded {len(maps)} AIA frames via JSOCClient", flush=True)
            if not maps:
                raise HTTPException(status_code=502, detail="No AIA maps loaded from JSOCClient files.")
            try:
                combined_data = np.nansum([m.data for m in maps], axis=0)
                combined_meta = maps[0].meta.copy()
                combined_meta["history"] = combined_meta.get("history", "") + f" Combined {len(maps)} AIA frames via np.nansum"
                combined_map = Map(combined_data, combined_meta)
                # Save to cache
                if combined_cache_file is not None:
                    np.savez_compressed(combined_cache_file, data=combined_data, meta=combined_meta)
                    print(f"[cache] Saved combined map to {combined_cache_file}", flush=True)
                print(f"[fetch] Combined {len(maps)} AIA frames into a single summed map.", flush=True)
                return combined_map
            except Exception as combine_err:
                print(f"[fetch] Failed to combine AIA maps: {combine_err}; returning first map.", flush=True)
                return maps[0]
        except Exception as jsoc_exc:
            print(f"[fetch] [AIA] JSOCClient fetch failed: {jsoc_exc}; falling back to Fido.", flush=True)
        # Fido fallback for AIA
        from sunpy.net import Fido, attrs as a
        from astropy import units as u
        wl = wavelength or int(DEFAULT_AIA_WAVELENGTH.value)
        print(f"[fetch] [AIA] SDO/AIA Fido fallback wavelength {wl}", flush=True)
        # Query for AIA data ±5 minutes
        qr = Fido.search(
            a.Time(t0, dt + timedelta(minutes=2)),
            a.Instrument("AIA"),
            a.Wavelength(wl * u.angstrom)
        )
        # If no results, widen window to ±1 hour and retry
        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            print(f"[fetch] [AIA] No Fido results in ±5min, retrying with ±1hr...", flush=True)
            qr = Fido.search(
                a.Time(dt, dt + timedelta(minutes=4)),
                a.Instrument("AIA"),
                a.Wavelength(wl * u.angstrom)
            )
        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            print(f"[fetch] [AIA] No AIA data found in ±1hr, falling back to SOHO-EIT.", flush=True)
            return soho_eit_fallback(dt)
        # Fetch only the first 5 results
        print(f"[fetch] [AIA] {len(qr[0])} results found, fetching all...", flush=True)
        from parfive import Downloader
        dl = Downloader(max_conn=10, progress=True)
        target_dir = os.environ["SUNPY_DOWNLOADDIR"]
        existing_files = [os.path.join(target_dir, os.path.basename(str(f))) for f in qr[0] if os.path.exists(os.path.join(target_dir, os.path.basename(str(f))))]
        if existing_files:
            print(f"[fetch] Skipping re-download of existing files: {existing_files}", flush=True)
            files = existing_files
        else:
            files = Fido.fetch(qr, downloader=dl, path=target_dir)
        if not files or len(files) == 0:
            raise HTTPException(status_code=502, detail="No AIA files could be downloaded via Fido.")
        maps = []
        for f in files:
            try:
                m = Map(f)
                m_prep = manual_aiaprep(m)
                maps.append(m_prep)
            except Exception as e:
                print(f"[fetch] [AIA] manual_aiaprep failed for {f}: {e}, using raw map.", flush=True)
                maps.append(Map(f))
        print(f"[fetch] Loaded {len(maps)} AIA frames via Fido", flush=True)
        if not maps:
            raise HTTPException(status_code=502, detail="No AIA maps loaded from Fido files.")
        try:
            combined_data = np.nansum([m.data for m in maps], axis=0)
            combined_meta = maps[0].meta.copy()
            combined_meta["history"] = combined_meta.get("history", "") + f" Combined {len(maps)} AIA frames via np.nansum"
            combined_map = Map(combined_data, combined_meta)
            # Save to cache
            if combined_cache_file is not None:
                np.savez_compressed(combined_cache_file, data=combined_data, meta=combined_meta)
                print(f"[cache] Saved combined map to {combined_cache_file}", flush=True)
            print(f"[fetch] Combined {len(maps)} AIA frames into a single summed map.", flush=True)
            return combined_map
        except Exception as combine_err:
            print(f"[fetch] Failed to combine AIA maps: {combine_err}; returning first map.", flush=True)
            return maps[0]
    elif mission == "SOHO-EIT":
        wl = (wavelength or int(DEFAULT_EIT_WAVELENGTH.value)) * u.angstrom
        print(f"[fetch] SOHO-EIT wavelength {wl}", flush=True)
        qr = Fido.search(a.Time(t0, t1), a.Instrument("EIT"), a.Wavelength(wl))
    elif mission == "SOHO-LASCO":
        det = detector or DEFAULT_DETECTOR_LASCO
        print(f"[fetch] SOHO-LASCO detector {det}", flush=True)
        qr = Fido.search(a.Time(t0, t1), a.Instrument("LASCO"), a.Detector(det))
    else:
        raise HTTPException(status_code=400, detail=f"Unknown mission {mission}")

    if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
        print(f"[fetch] No data in initial window, widening search...", flush=True)
        t0b = dt - timedelta(days=1)
        t1b = dt + timedelta(days=2)
        if mission == "SOHO-EIT":
            wl = (wavelength or int(DEFAULT_EIT_WAVELENGTH.value)) * u.angstrom
            qr = Fido.search(a.Time(t0b, t1b), a.Instrument("EIT"), a.Wavelength(wl))
        else:
            det = detector or DEFAULT_DETECTOR_LASCO
            qr = Fido.search(a.Time(t0b, t1b), a.Instrument("LASCO"), a.Detector(det))
        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            raise HTTPException(status_code=404, detail=f"No data found for {mission} near {dt.date()}.")

    print(f"[fetch] {len(qr[0])} results, fetching first file...", flush=True)
    fetch_start = time.time()
    files = None
    max_attempts = 3
    last_exception = None
    for attempt in range(1, max_attempts + 1):
        try:
            print(f"[fetch] Attempt {attempt} to fetch...", flush=True)
            # Use Downloader with max_conn=10 and explicit path
            from parfive import Downloader
            dl = Downloader(max_conn=10, progress=False, overwrite=False)
            target_dir = os.environ["SUNPY_DOWNLOADDIR"]
            # Force all JSOC URLs to HTTPS before download (avoid Render port 80 blocks)
            if mission == "SDO":
                try:
                    if hasattr(qr, "response"):
                        for resp in qr.response:
                            if hasattr(resp, "url") and isinstance(resp.url, str):
                                resp.url = resp.url.replace("http://jsoc.stanford.edu", "https://jsoc.stanford.edu")
                    elif isinstance(qr, list):
                        qr = [r.replace("http://jsoc.stanford.edu", "https://jsoc.stanford.edu") for r in qr]
                    print(f"[fetch] Rewrote JSOC URLs to HTTPS before download ({len(qr)} entries).", flush=True)
                except Exception as pre_rewrite_err:
                    print(f"[fetch] Pre-download HTTPS rewrite failed: {pre_rewrite_err}", flush=True)
            files = Fido.fetch(qr[0, 0], downloader=dl, path=target_dir)
            if files and len(files) > 0:
                break
        except Exception as exc:
            last_exception = exc
            print(f"[fetch] Exception in fetch attempt {attempt}: {exc}", flush=True)
            if attempt < max_attempts:
                print(f"[fetch] Sleeping 5 seconds before retry...", flush=True)
                time.sleep(5)
    fetch_end = time.time()

    if not files or len(files) == 0:
        print(f"[fetch] No files after {max_attempts} attempts!", flush=True)
        if mission == "SDO":
            return soho_eit_fallback(dt)
        else:
            raise HTTPException(
                status_code=502,
                detail=f"No files could be downloaded for {mission} on {dt.date()} after {max_attempts} attempts."
            )
    print(f"[fetch] Downloaded file {files[0]} in {fetch_end - fetch_start:.2f}s", flush=True)
    return Map(files[0])

# Shared SOHO-EIT fallback for SDO failures
def soho_eit_fallback(dt: datetime) -> Map:
    print(f"[fetch] Fallback to SOHO-EIT 195Å", flush=True)
    fallback_wl = int(DEFAULT_EIT_WAVELENGTH.value)
    t0 = dt
    t1 = dt + timedelta(days=1)
    fallback_qr = Fido.search(a.Time(t0, t1), a.Instrument("EIT"), a.Wavelength(fallback_wl * u.angstrom))
    if len(fallback_qr) == 0 or all(len(resp) == 0 for resp in fallback_qr):
        print(f"[fetch] No fallback SOHO-EIT data in window, widening...", flush=True)
        t0b = dt - timedelta(days=1)
        t1b = dt + timedelta(days=2)
        fallback_qr = Fido.search(a.Time(t0b, t1b), a.Instrument("EIT"), a.Wavelength(fallback_wl * u.angstrom))
    fallback_files = None
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            print(f"[fetch] Fallback attempt {attempt}...", flush=True)
            from parfive import Downloader
            dl = Downloader(max_conn=10, progress=False, overwrite=False)
            fallback_files = Fido.fetch(fallback_qr[0, 0], downloader=dl, path=os.environ["SUNPY_DOWNLOADDIR"])
            if fallback_files and len(fallback_files) > 0:
                break
        except Exception as exc:
            print(f"[fetch] Exception in fallback attempt {attempt}: {exc}", flush=True)
            if attempt < max_attempts:
                print(f"[fetch] Sleeping 5 seconds before retry...", flush=True)
                time.sleep(5)
    if fallback_files and len(fallback_files) > 0:
        print(f"[fetch] Fallback downloaded file {fallback_files[0]}", flush=True)
        return Map(fallback_files[0])
    else:
        print(f"[fetch] Fallback failed, no files.", flush=True)
        raise HTTPException(
            status_code=502,
            detail=f"No files could be downloaded for SDO on {dt.date()} (fallback to SOHO-EIT also failed)."
        )

# ──────────────────────────────────────────────────────────────────────────────
# Image processing (plug your filter here)
# ──────────────────────────────────────────────────────────────────────────────
def default_filter(smap: Map) -> Map:
    import sys
    import contextlib

    # Local context manager to adapt tqdm/rhef carriage returns to newlines for streaming
    @contextlib.contextmanager
    def tqdm_stream_adapter():
        class CarriageReturnToNewline:
            def __init__(self, orig_stream):
                self.orig_stream = orig_stream
            def write(self, data):
                # Replace '\r' with '\n' so tqdm progress updates stream properly
                data = data.replace('\r', '\n')
                self.orig_stream.write(data)
                self.orig_stream.flush()
            def flush(self):
                self.orig_stream.flush()
            def isatty(self):
                return False

        orig_stdout, orig_stderr = sys.stdout, sys.stderr
        adapter = CarriageReturnToNewline(orig_stdout)
        sys.stdout = adapter
        sys.stderr = adapter
        try:
            yield
        finally:
            sys.stdout = orig_stdout
            sys.stderr = orig_stderr

    try:
        with tqdm_stream_adapter():
            block_size = 2
            from astropy.nddata import block_reduce
            import sunpy
            print("[render] Performing RHE...")
            header = smap.meta
            header['CRPIX1'] /= block_size
            header['CRPIX2'] /= block_size
            header['CDELT1'] *= block_size
            header['CDELT2'] *= block_size
            reduced_data = block_reduce(smap.data, block_size=block_size, func=np.nanmean)
            sunpy_map = sunpy.map.Map(reduced_data, header)
            # filtered_sample = rhef(sunpy_map, progress=True, method=rankdata_ignore_nan)
            filtered = rhef(sunpy_map, progress=True, vignette=1.51 * u.R_sun)
        return filtered
    except Exception as e:
        import traceback
        print("[render] RHEF filter failed with exception:", flush=True)
        traceback.print_exc()
        print(f"[render] RHEF filter failed: {e}. Using asinh stretch.", flush=True)
        arr = smap.data.astype(float)
        arr[~np.isfinite(arr)] = np.nan
        # Return a Map object for consistency
        from sunpy.map import Map as SunpyMap
        asinh_map = SunpyMap(np.arcsinh(arr), smap.meta)
        # Mark that fallback was used via a custom attribute
        asinh_map.meta["rhef_failed"] = True
        return asinh_map

def map_to_png(
    smap: Map,
    out_png: str,
    annotate: bool = True,
    dpi: int = 300,
    size_inches: float = 10.0,
) -> str:
    print(f"[render] Rendering to {out_png}", flush=True)
    start_time = time.time()
    # Determine colormap and meta info for both renders
    from sunpy.visualization.colormaps import color_tables as ct
    wl_meta = smap.meta.get('wavelnth') or smap.meta.get('WAVELNTH')
    inst = smap.meta.get("instrume") or smap.meta.get("instrument") or ""
    if "AIA" in inst.upper() and wl_meta in [94, 131, 171, 193, 211, 304, 335, 1600, 1700, 4500]:
        cmap = ct.aia_color_table(wl_meta * u.angstrom)
        cmap_name = f"aia_color_table({wl_meta})"
    elif "EIT" in inst.upper():
        cmap = plt.get_cmap("sohoeit195") if wl_meta == 195 else plt.get_cmap("gray")
        cmap_name = f"sohoeit{wl_meta}" if wl_meta else "gray"
    else:
        cmap = smap.plot_settings.get("cmap", plt.get_cmap("gray"))
        cmap_name = str(getattr(cmap, "name", "gray"))
    print(f"[render] Using colormap: {cmap_name}", flush=True)


    # Caching for filtered data
    filtered_cache_file = None
    # Try to determine instrument and date for cache name
    inst = smap.meta.get("instrume") or smap.meta.get("instrument") or ""
    wl_meta = smap.meta.get('wavelnth') or smap.meta.get('WAVELNTH')
    # Use date from meta if possible
    date_for_cache = None
    if hasattr(smap, "date") and getattr(smap, "date", None):
        try:
            date_for_cache = smap.date.strftime("%Y%m%d")
        except Exception:
            date_for_cache = None
    if not date_for_cache:
        # fallback: try to extract from meta
        date_obs = smap.meta.get("date-obs") or smap.meta.get("DATE-OBS")
        if date_obs:
            try:
                date_for_cache = str(date_obs).replace("-", "").replace(":", "").split("T")[0]
            except Exception:
                date_for_cache = "unknown"
        else:
            date_for_cache = "unknown"
    filtered_cache_file = os.path.join(OUTPUT_DIR, f"temp_filtered_{inst}_{date_for_cache}.npz")
    rhef_failed = False
    # Try to load from cache, but rerun filter if previous run failed (rhef_failed marker)
    if os.path.exists(filtered_cache_file):
        print(f"[cache] Using cached filtered data from {filtered_cache_file}...", flush=True)
        with np.load(filtered_cache_file, allow_pickle=True) as npz:
            data = npz["data"]
            rhef_failed = bool(npz.get("rhef_failed", False))
        if rhef_failed:
            print("[cache] Previous filter run failed (rhef_failed=True); rerunning filter...", flush=True)
            filtered_map = default_filter(smap)
            # If filtered_map is a Map, extract .data and check for fallback
            data = filtered_map.data if hasattr(filtered_map, "data") else filtered_map
            rhef_failed = bool(getattr(filtered_map, "meta", {}).get("rhef_failed", False))
            np.savez_compressed(filtered_cache_file, data=data, rhef_failed=rhef_failed)
            print(f"[cache] Saved filtered data to {filtered_cache_file}", flush=True)
    else:
        filtered_map = default_filter(smap)
        # If filtered_map is a Map, extract .data and check for fallback
        data = filtered_map.data if hasattr(filtered_map, "data") else filtered_map
        rhef_failed = bool(getattr(filtered_map, "meta", {}).get("rhef_failed", False))
        np.savez_compressed(filtered_cache_file, data=data, rhef_failed=rhef_failed)
        print(f"[cache] Saved filtered data to {filtered_cache_file}", flush=True)
    lo, hi = np.nanmin(data), np.nanmax(data)
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        lo, hi = 0.0, 1.0
    fig = plt.figure(figsize=(size_inches, size_inches), dpi=dpi)
    ax = plt.axes([0, 0, 1, 1])
    cmap.set_bad(color='black')
    ax.imshow(data, origin="lower", vmin=lo, vmax=hi, cmap=cmap)
    # ax.set_facecolor("black")
    ax.set_axis_off()
    if annotate:
        txt = []
        if "wavelnth" in smap.meta:
            txt.append(f"{smap.meta.get('wavelnth')} Å")
        inst_anno = smap.meta.get("instrume") or smap.meta.get("instrument")
        if inst_anno:
            txt.append(str(inst_anno).split("_")[0])
        date_str = smap.date.strftime("%Y-%m-%d %H:%M UTC") if hasattr(smap, "date") else ""
        if date_str:
            txt.append(date_str)
        footer = " • ".join(txt) if txt else "Solar Archive"
        ax.text(
            0.5, 0.02, footer,
            transform=ax.transAxes,
            ha="center", va="bottom",
            fontsize=10, color="white", alpha=0.85
        )
        courtesy = "NASA/SDO" if "AIA" in inst.upper() else "ESA/NASA SOHO"
        ax.text(
            0.5, 0.0, f"Image courtesy of {courtesy}",
            transform=ax.transAxes,
            ha="center", va="bottom",
            fontsize=7, color="white", alpha=0.65
        )
        # # Add annotation for post-filter
        # ax.text(
        #     0.01, 0.98, "Post-filter (RHEF)", transform=ax.transAxes,
        #     ha="left", va="top", fontsize=11, color="white", alpha=0.95, fontweight="bold",
        #     bbox=dict(facecolor="black", alpha=0.4, pad=2, edgecolor="none")
        # )
    print(f"[render] Saving postfilter image to {out_png}", flush=True)
    fig.savefig(out_png, bbox_inches="tight", pad_inches=0)
    plt.close(fig)
    end_time = time.time()
    print(f"[render] Finished in {end_time - start_time:.2f}s", flush=True)
    print(f"[render] Image saved to directory: {os.path.dirname(out_png)}", flush=True)
    return out_png

# ──────────────────────────────────────────────────────────────────────────────
# File / URL helpers
# ──────────────────────────────────────────────────────────────────────────────
def hashed_name(prefix: str, payload: Dict[str, Any]) -> str:
    h = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]
    return f"{prefix}_{h}.png"

def local_path_and_url(filename: str) -> Dict[str, str]:
    path = os.path.join(OUTPUT_DIR, filename)
    if ASSET_BASE_URL:
        url = ASSET_BASE_URL.rstrip("/") + "/" + filename
    else:
        # no CDN configured; expose a local file endpoint
        url = f"/asset/{filename}"
    return {"path": path, "url": url}

# ──────────────────────────────────────────────────────────────────────────────
# Printful API (upload only; you can add mockups/orders later)
# ──────────────────────────────────────────────────────────────────────────────
def printful_upload(image_path: str, title: Optional[str], purpose: Optional[str]) -> Dict[str, Any]:
    print(f"[upload] Printful: {image_path}, title={title}, purpose={purpose}", flush=True)
    start_time = time.time()
    if not PRINTFUL_API_KEY:
        raise HTTPException(status_code=400, detail="PRINTFUL_API_KEY not configured.")
    headers = {"Authorization": f"Bearer {PRINTFUL_API_KEY}"}
    with open(image_path, "rb") as f:
        files = {"file": (os.path.basename(image_path), f, "image/png")}
        data = {}
        if title:
            data["filename"] = title
        if purpose:
            data["purpose"] = purpose
        r = requests.post(f"{PRINTFUL_BASE_URL}/files", headers=headers, files=files, data=data, timeout=60)
    if r.status_code >= 300:
        raise HTTPException(status_code=r.status_code, detail=f"Printful upload failed: {r.text}")
    end_time = time.time()
    print(f"[upload] Printful upload completed in {end_time - start_time:.2f}s", flush=True)
    return r.json()

# ──────────────────────────────────────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────────────────────────────────────
@app.get("/status")
def status():
    return {"ok": True, "app": APP_NAME}

@app.get("/asset/{filename}")
def get_local_asset(filename: str):
    # Only works when ASSET_BASE_URL is empty (local dev)
    fp = os.path.join(OUTPUT_DIR, filename)
    if not os.path.exists(fp):
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(fp, media_type="image/png")

@app.post("/generate")
async def generate(req: GenerateRequest):
    print(f"[generate] Received request: {req}", flush=True)
    try:
        dt = datetime.strptime(req.date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")

    mission = req.mission if req.mission != "auto" else choose_mission(dt)
    print(f"[generate] Using mission: {mission}", flush=True)
    # wavelength only matters for AIA/EIT; detector for LASCO
    wl = req.wavelength
    det = req.detector

    # New naming scheme: {instrument}_{wavelength}A_{YYYY-MM-DD}.png if wavelength is known, else omit wavelength
    instrument_for_name = None
    if mission == "SDO":
        instrument_for_name = "AIA"
    elif mission == "SOHO-EIT":
        instrument_for_name = "EIT"
    elif mission == "SOHO-LASCO":
        instrument_for_name = "LASCO"
    else:
        instrument_for_name = mission
    # Compose filename with wavelength if provided
    if wl is not None:
        filename = f"{instrument_for_name}_{wl}A_{req.date}.png"
    else:
        filename = f"{instrument_for_name}_{req.date}.png"
    paths = local_path_and_url(filename)

    # Only use cached file if dry_run is True, else always regenerate
    if req.dry_run and os.path.exists(paths["path"]):
        print(f"[generate] Cached: {paths['path']}", flush=True)
        resp: Dict[str, Any] = {
            "mission": mission,
            "date": req.date,
            "png_local_path": paths["path"],
            "png_url": paths["url"],
            "note": "cached render",
        }
        if req.upload_to_printful:
            print(f"[upload] Printful: uploading cached file...", flush=True)
            pf = printful_upload(paths["path"], req.title or f"Sun on {req.date}", req.printful_purpose)
            resp["printful"] = pf
            # Extract Printful direct image URL if present
            pf_url = None
            try:
                pf_url = pf.get("result", {}).get("url")
            except Exception:
                pf_url = None
            if not pf_url:
                # Try alternate key or structure just in case
                pf_url = pf.get("url") if isinstance(pf, dict) else None
            if pf_url:
                resp["printful_url"] = pf_url
        out_png = paths["path"]
        final_png_to_open = out_png
        return_json = resp
        goto_final_open = True
    else:
        goto_final_open = False

    # Fetch → Map → Render
    fetch_start = time.time()
    result = fido_fetch_map(dt, mission, wl, det)
    smap = result[0] if isinstance(result, list) and len(result) > 0 else result

    out_png = os.path.join(OUTPUT_DIR, f"{mission}_{wl or ''}_{req.date}.png")
    print(out_png, flush=True)

    # offload blocking render
    import asyncio
    import concurrent.futures
    loop = asyncio.get_event_loop()
    render_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    await loop.run_in_executor(
        render_executor,
        lambda: map_to_png(smap, out_png, annotate=req.annotate, dpi=req.png_dpi, size_inches=req.png_size_inches)
    )

    print(f"[render] PNG saved: {out_png}", flush=True)
    print("[generate] Completed successfully.", flush=True)

    fetch_end = time.time()
    print(f"[fetch] Data fetch took {fetch_end - fetch_start:.2f}s", flush=True)

    instrument_meta = smap.meta.get("instrume") or smap.meta.get("instrument") or instrument_for_name
    wl_meta = smap.meta.get("wavelnth")
    date_str_for_name = req.date
    if hasattr(smap, "date") and getattr(smap, "date", None):
        try:
            date_str_for_name = smap.date.strftime("%Y-%m-%d")
        except Exception:
            pass
    if wl_meta is not None:
        new_filename = f"{instrument_meta}_{wl_meta}A_{date_str_for_name}.png"
    else:
        new_filename = f"{instrument_meta}_{date_str_for_name}.png"
    new_paths = local_path_and_url(new_filename)
    # Only use cached file if dry_run is True, else always regenerate
    if not goto_final_open and req.dry_run and os.path.exists(new_paths["path"]):
        print(f"[generate] Cached: {new_paths['path']} (post-fetch)", flush=True)
        resp: Dict[str, Any] = {
            "mission": mission,
            "date": req.date,
            "meta": {
                "observing_date": getattr(getattr(smap, "date", None), "isot", None),
                "instrument": instrument_meta,
                "detector": smap.meta.get("detector"),
                "wavelength": smap.meta.get("wavelnth"),
            },
            "png_local_path": new_paths["path"],
            "png_url": new_paths["url"],
            "note": "cached render (post-fetch)",
            "attribution": "Image courtesy of NASA/SDO (AIA) or ESA/NASA SOHO (EIT/LASCO). Not affiliated; no endorsement implied.",
        }
        if req.upload_to_printful:
            print(f"[upload] Printful: uploading cached file...", flush=True)
            pf = printful_upload(new_paths["path"], req.title or f"Sun on {req.date}", req.printful_purpose)
            resp["printful"] = pf
            # Extract Printful direct image URL if present
            pf_url = None
            try:
                pf_url = pf.get("result", {}).get("url")
            except Exception:
                pf_url = None
            if not pf_url:
                pf_url = pf.get("url") if isinstance(pf, dict) else None
            if pf_url:
                resp["printful_url"] = pf_url
        out_png = new_paths["path"]
        final_png_to_open = out_png
        return_json = resp
        goto_final_open = True

    if not goto_final_open:
        render_start = time.time()
        out_png = map_to_png(
            smap, out_png=new_paths["path"], annotate=req.annotate,
            dpi=req.png_dpi, size_inches=req.png_size_inches
        )
        render_end = time.time()
        print(f"[render] Image rendering took {render_end - render_start:.2f}s", flush=True)

        resp: Dict[str, Any] = {
            "mission": mission,
            "date": req.date,
            "meta": {
                "observing_date": getattr(getattr(smap, "date", None), "isot", None),
                "instrument": instrument_meta,
                "detector": smap.meta.get("detector"),
                "wavelength": smap.meta.get("wavelnth"),
            },
            "png_local_path": out_png,
            "png_url": new_paths["url"],
            "attribution": "Image courtesy of NASA/SDO (AIA) or ESA/NASA SOHO (EIT/LASCO). Not affiliated; no endorsement implied.",
        }

        if req.upload_to_printful:
            print(f"[upload] Printful: uploading generated image...", flush=True)
            upload_start = time.time()
            pf = printful_upload(out_png, req.title or f"Sun on {req.date}", req.printful_purpose)
            upload_end = time.time()
            print(f"[upload] Printful upload took {upload_end - upload_start:.2f}s", flush=True)
            resp["printful"] = pf
            # Extract Printful direct image URL if present
            pf_url = None
            try:
                pf_url = pf.get("result", {}).get("url")
            except Exception:
                pf_url = None
            if not pf_url:
                pf_url = pf.get("url") if isinstance(pf, dict) else None
            if pf_url:
                resp["printful_url"] = pf_url

        final_png_to_open = out_png
        return_json = resp
        goto_final_open = True

    # Unified image open at end (if not using ASSET_BASE_URL)
    if goto_final_open and not ASSET_BASE_URL:
        try:
            print(f"[generate] Opening final image: {final_png_to_open}", flush=True)
            if os.name == "posix":
                opener = "open" if sys.platform == "darwin" else "xdg-open"
                subprocess.run([opener, final_png_to_open])
        except Exception as e:
            print(f"[generate] Failed to open image: {e}", flush=True)
    if goto_final_open:
        return JSONResponse(return_json)

@app.post("/generate-stream")
async def generate_stream(req: GenerateRequest):
    import sys
    import asyncio
    import threading

    class StreamToClient:
        """
        File-like object to capture sys.stdout and send to an asyncio.Queue.
        """
        def __init__(self, queue: asyncio.Queue, loop):
            self.queue = queue
            self.loop = loop
            self._buffer = ""
            self._lock = threading.Lock()

        def write(self, data):
            # Buffer lines until newline
            with self._lock:
                self._buffer += data
                while "\n" in self._buffer:
                    line, self._buffer = self._buffer.split("\n", 1)
                    # Schedule put in the event loop thread-safely
                    asyncio.run_coroutine_threadsafe(self.queue.put(line), self.loop)

        def flush(self):
            # On flush, send any remaining buffer as a line
            with self._lock:
                if self._buffer:
                    asyncio.run_coroutine_threadsafe(self.queue.put(self._buffer), self.loop)
                    self._buffer = ""

    async def event_generator():
        queue = asyncio.Queue()
        loop = asyncio.get_event_loop()
        orig_stdout = sys.stdout
        sys_stdout_redirected = StreamToClient(queue, loop)
        sys.stdout = sys_stdout_redirected
        drain_task = None
        try:
            # Coroutine to drain queue and yield SSE messages as soon as they are available
            async def drain_queue():
                while True:
                    msg = await queue.get()
                    # SSE format: {msg}
                    yield f"{msg}"
                    queue.task_done()

            # Start background draining of the queue
            drain_iter = drain_queue()
            # Print initial message (will go to queue)
            print(f"[generate] Received request: {req}", flush=True)

            try:
                dt = datetime.strptime(req.date, "%Y-%m-%d")
            except ValueError:
                print("Error: date must be YYYY-MM-DD", flush=True)
                # Drain the queue and yield as SSE
                async for sse_msg in drain_iter:
                    yield sse_msg
                # End event
                yield f"File saved"
                return

            mission = req.mission if req.mission != "auto" else choose_mission(dt)
            print(f"[generate] Using mission: {mission}", flush=True)
            wl = req.wavelength
            det = req.detector
            print(f"[fetch] mission={mission}, date={dt.date()}, wavelength={wl}, detector={det}", flush=True)

            import concurrent.futures
            print("[fetch] Starting data fetch...", flush=True)
            executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
            fut = loop.run_in_executor(executor, lambda: fido_fetch_map(dt, mission, wl, det))

            # Start draining the queue in the background while waiting for the blocking fetch
            async def sse_drain_while_future(fut):
                # Continue yielding lines from the queue as soon as they are printed
                while not fut.done():
                    try:
                        msg = await asyncio.wait_for(queue.get(), timeout=0.2)
                        yield f"{msg}"
                        queue.task_done()
                    except asyncio.TimeoutError:
                        await asyncio.sleep(0.1)
                # Drain any remaining messages after completion
                while not queue.empty():
                    msg = await queue.get()
                    yield f"{msg}"
                    queue.task_done()

            # Stream all print output during fetch
            async for sse_msg in sse_drain_while_future(fut):
                yield sse_msg

            try:
                result = await fut
            except Exception as err:
                print(f"[error] {str(err)}", flush=True)
                # Drain the queue and yield as SSE
                async for sse_msg in drain_queue():
                    yield sse_msg
                yield "event: end\ndone"
                return
            print("[fetch] Data fetch complete", flush=True)
            smap = result[0] if isinstance(result, list) and len(result) > 0 else result
            out_png = os.path.join(os.path.dirname(OUTPUT_DIR), f"{mission}_{wl or ''}_{req.date}.png")
            map_to_png(smap, out_png, annotate=req.annotate, dpi=req.png_dpi, size_inches=req.png_size_inches)
            print(f"[render] PNG saved: {out_png}", flush=True)
            print("[generate] Completed successfully.", flush=True)
        except Exception as e:
            print(f"[error] {str(e)}", flush=True)
        finally:
            # Restore sys.stdout
            sys.stdout = orig_stdout
        # Drain any remaining messages and send final event
        while not queue.empty():
            msg = await queue.get()
            yield f"{msg}"
            queue.task_done()
        # yield ""
        yield f"File saved to {out_png}"


    return EventSourceResponse(event_generator())