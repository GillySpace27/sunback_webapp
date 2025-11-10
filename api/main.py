from __future__ import annotations
from urllib.parse import urlencode, quote_plus
import io
import json
import hashlib
import time
import subprocess
from datetime import datetime, timedelta
from typing import Optional, Literal, Dict, Any
import numpy as np
import requests
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
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
import os
# sunback/webapp/api/main.py
# FastAPI backend for Solar Archive — date→FITS via SunPy→filtered PNG→(optional) Printful upload


# ──────────────────────────────────────────────────────────────────────────────
# Ensure SSL_CERT_FILE is set using certifi as a fallback if not already set or path missing
# This should run before any SunPy config or network code.
import certifi
if (
    "SSL_CERT_FILE" not in os.environ
    or not os.path.exists(os.environ["SSL_CERT_FILE"])
):
    os.environ["SSL_CERT_FILE"] = certifi.where()
    print(f"[startup] Set SSL_CERT_FILE to certifi.where(): {os.environ['SSL_CERT_FILE']}", flush=True)
# Always force SSL to use certifi's CA bundle globally
import ssl
ssl._create_default_https_context = ssl._create_default_https_context



# Use /tmp/output as the root for all temp/config/download dirs, regardless of environment
base_tmp = "/tmp/output"
os.environ["SUNPY_CONFIGDIR"] = os.path.join(base_tmp, "config")
os.environ["SUNPY_DOWNLOADDIR"] = os.path.join(base_tmp, "data")
# os.environ["REQUESTS_CA_BUNDLE"] = os.environ.get("REQUESTS_CA_BUNDLE", "/etc/ssl/cert.pem")
# os.environ["SSL_CERT_FILE"] = os.environ.get("SSL_CERT_FILE", "/etc/ssl/cert.pem")
os.environ["VSO_URL"] = "http://vso.stanford.edu/cgi-bin/VSO_GETDATA.cgi"
os.environ["JSOC_BASEURL"] = "https://jsoc.stanford.edu"
os.environ["JSOC_URL"] = "https://jsoc.stanford.edu"
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()
os.environ["SSL_CERT_FILE"] = certifi.where()

# Set SOLAR_ARCHIVE_ASSET_BASE_URL if missing, based on environment
if not os.getenv("SOLAR_ARCHIVE_ASSET_BASE_URL"):
    if os.getenv("RENDER"):
        os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = "https://solar-archive.onrender.com"
        print("[startup] Using default public asset base URL for Render: https://solar-archive.onrender.com", flush=True)
    else:
        os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = "http://127.0.0.1:8000/asset/"
        print("[startup] Using local asset base URL: http://127.0.0.1:8000/asset/", flush=True)

os.makedirs(os.environ["SUNPY_DOWNLOADDIR"], exist_ok=True)

print(f"[startup] SunPy config_dir={os.environ['SUNPY_CONFIGDIR']}", flush=True)
print(f"[startup] SunPy download_dir={os.environ['SUNPY_DOWNLOADDIR']}", flush=True)
print(f"[startup] Using SSL_CERT_FILE={os.environ['SSL_CERT_FILE']}", flush=True)
print(f"[startup] Using VSO_URL={os.environ['VSO_URL']}", flush=True)



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
OUTPUT_DIR = os.getenv("SOLAR_ARCHIVE_OUTPUT_DIR", base_tmp)
ASSET_BASE_URL = os.getenv("SOLAR_ARCHIVE_ASSET_BASE_URL", "")  # e.g., CDN base; else empty for local
print(f"{ASSET_BASE_URL = }")
print(f"{OUTPUT_DIR = }")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Printful
PRINTFUL_API_KEY = os.getenv("PRINTFUL_API_KEY", None)
PRINTFUL_BASE_URL = os.getenv("PRINTFUL_BASE_URL", "https://api.printful.com")
print(f"{PRINTFUL_API_KEY = }")


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

from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://solar-archive.myshopify.com",
        "https://0b1wyw-tz.myshopify.com",
        "https://admin.shopify.com",
        "https://solar-archive.onrender.com",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────────────────────────────────────
# Shopify Launch & Redirect Endpoints
# ──────────────────────────────────────────────────────────────────────────────

@app.get("/shopify/launch", response_class=HTMLResponse)
async def shopify_launch():
    """
    Serve a dynamic HTML page for Shopify users to choose a date, generate a solar image,
    preview it, and open it in the Shopify store.
    """
    html = """
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Solar Archive — Shopify Launch</title>
        <style>
            body {
                background: #181820;
                color: #f0f0f0;
                min-height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                font-family: 'Segoe UI', 'Arial', sans-serif;
                margin: 0;
            }
            .container {
                background: #23232e;
                border-radius: 16px;
                padding: 32px 24px 24px 24px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                display: flex;
                flex-direction: column;
                align-items: center;
                max-width: 95vw;
            }
            img {
                max-width: 80vw;
                max-height: 60vh;
                border-radius: 10px;
                box-shadow: 0 2px 16px rgba(0,0,0,0.4);
                margin-bottom: 1.5em;
                background: #000;
            }
            .meta {
                margin-top: 1em;
                margin-bottom: 1em;
                font-size: 1.1em;
                color: #bdbde7;
            }
            .action-btn {
                background: #6a6aff;
                color: #fff;
                padding: 0.7em 1.4em;
                border: none;
                border-radius: 8px;
                font-size: 1.1em;
                font-weight: 500;
                cursor: pointer;
                margin-bottom: 1em;
                text-decoration: none;
                transition: background 0.2s;
                box-shadow: 0 2px 10px rgba(0,0,0,0.15);
            }
            .action-btn:hover {
                background: #3a3ae7;
            }
            .footer {
                margin-top: 2em;
                font-size: 0.95em;
                color: #888;
            }
            #preview-section {
                display: none;
                flex-direction: column;
                align-items: center;
                margin-top: 2em;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>Solar Archive for Shopify</h2>
            <form id="genform">
                <label for="date">Choose a date:</label>
                <input type="date" id="date" name="date" required>
                <button type="submit" class="action-btn">Generate Solar Image</button>
            </form>
            <div id="preview-section">
                <h3>Image Preview</h3>
                <img id="preview-img" src="" alt="Solar image preview">
                <div class="meta" id="preview-meta"></div>
                <button id="shopify-btn" class="action-btn">Open in Shopify Store</button>
            </div>
            <div class="footer">
                Images courtesy of NASA/SDO or ESA/NASA SOHO. Not affiliated; no endorsement implied.
            </div>
        </div>
        <script>
            const form = document.getElementById('genform');
            const previewSection = document.getElementById('preview-section');
            const previewImg = document.getElementById('preview-img');
            const previewMeta = document.getElementById('preview-meta');
            const shopifyBtn = document.getElementById('shopify-btn');
            let lastImageUrl = "";
            let lastMeta = "";
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const date = document.getElementById('date').value;
                if (!date) {
                    alert("Please select a date.");
                    return;
                }
                previewSection.style.display = "none";
                previewImg.src = "";
                previewMeta.textContent = "";
                lastImageUrl = "";
                lastMeta = "";
                shopifyBtn.disabled = true;
                shopifyBtn.textContent = "Open in Shopify Store";
                // Call /generate endpoint (POST for more reliable parsing)
                try {
                    const payload = {
                        date: date,
                        mission: "auto",
                        dry_run: true,
                        annotate: true
                    };
                    const res = await fetch('/generate', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(payload)
                    });
                    let responseText = await res.text();
                    // Try to parse JSON, fallback to HTML
                    let data = null;
                    try {
                        data = JSON.parse(responseText);
                    } catch {
                        // Not JSON, try to extract image URL from HTML
                        let imgMatch = responseText.match(/<img[^>]+src="([^"]+)"/i);
                        let dateMatch = responseText.match(/<div><b>Date:<\/b>\s*([^<]+)<\/div>/i);
                        let wlMatch = responseText.match(/<div><b>Wavelength:<\/b>\s*([^<]+) Å<\/div>/i);
                        if (imgMatch) {
                            lastImageUrl = imgMatch[1];
                        }
                        if (dateMatch || wlMatch) {
                            lastMeta = "";
                            if (dateMatch) lastMeta += "Date: " + dateMatch[1] + " ";
                            if (wlMatch) lastMeta += "Wavelength: " + wlMatch[1] + " Å";
                        }
                        data = null;
                    }
                    if (data && data.png_url) {
                        lastImageUrl = data.png_url;
                        lastMeta = `Date: ${data.date || date} Wavelength: ${data.meta && data.meta.wavelength ? data.meta.wavelength : ""} Å`;
                    }
                    if (lastImageUrl) {
                        previewImg.src = lastImageUrl;
                        previewMeta.textContent = lastMeta;
                        previewSection.style.display = "flex";
                        shopifyBtn.disabled = false;
                    } else {
                        alert("Could not generate image. Please try again.");
                    }
                } catch (err) {
                    alert("Error generating image: " + err);
                }
            });
            shopifyBtn.addEventListener('click', () => {
                if (!lastImageUrl) {
                    alert("No image to send to Shopify.");
                    return;
                }
                // Redirect to /redirect_to_shopify with image_url param
                const params = new URLSearchParams({ image_url: lastImageUrl });
                window.location.href = "/redirect_to_shopify?" + params.toString();
            });
        </script>
    </body>
    </html>
    """
    return HTMLResponse(content=html)


@app.get("/redirect_to_shopify")
async def redirect_to_shopify(request: Request):
    """
    Redirects the user to the Shopify store app page with the image_url as a query parameter.
    """
    image_url = request.query_params.get("image_url")
    if not image_url:
        raise HTTPException(status_code=400, detail="image_url parameter is required")
    # Construct Shopify app URL
    base_url = "https://solar-archive.myshopify.com"
    # Use /apps/solar-render?image_url={encoded_image_url}
    encoded_image_url = quote_plus(image_url)
    shopify_url = f"{base_url}/apps/solar-render?image_url={encoded_image_url}"
    print(f"[shopify][redirect] Constructed Shopify URL: {shopify_url}", flush=True)
    print(f"[shopify][redirect] Redirecting user to Shopify store...", flush=True)
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url=shopify_url, status_code=302)







@app.get("/", response_class=HTMLResponse)
async def root():
    return """
    <html>
        <head><title>Solar Archive</title></head>
        <body style="font-family:sans-serif; text-align:center; margin-top:5em;">
            <h1>☀️ Solar Archive is running!</h1>
            <p>Visit the <a href="/docs">API documentation</a> for available endpoints.</p>
        </body>
    </html>
    """

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
    printful_purpose: Optional[str] = "default"
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

@app.get("/debug/list_output")
async def list_output():
    from pathlib import Path
    root = Path(OUTPUT_DIR)
    files = sorted([str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()])
    return {"output_dir": OUTPUT_DIR, "files": files}


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
            # If some downloads failed, files may be shorter than qr
            if not files or len(files) == 0:
                print(f"[fetch] [AIA] JSOCClient fetch returned no files, falling back to Fido.", flush=True)
                raise Exception("No files from JSOCClient fetch")
            if len(files) < len(qr):
                print(f"[fetch] Warning: Only {len(files)} out of {len(qr)} JSOC files were downloaded successfully. Proceeding with available files.", flush=True)
                print(f"[fetch] Proceeding with {len(files)} successfully downloaded files (skipped failed).", flush=True)
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
                # In-place accumulation of AIA maps using float32 arrays
                shape = maps[0].data.shape
                combined_data = np.zeros(shape, dtype=np.float32)
                for m in maps:
                    combined_data += np.nan_to_num(m.data.astype(np.float32))
                combined_meta = maps[0].meta.copy()
                combined_meta["history"] = combined_meta.get("history", "") + f" Combined {len(maps)} AIA frames via in-place accumulation"
                combined_map = Map(combined_data, combined_meta)
                # Save to cache
                if combined_cache_file is not None:
                    np.savez_compressed(combined_cache_file, data=combined_data, meta=combined_meta)
                    print(f"[cache] Saved combined map to {combined_cache_file}", flush=True)
                # Free memory
                # del maps, combined_meta
                import gc
                gc.collect()
                try:
                    print(f"[fetch] Combined {len(maps)} AIA frames into a single summed map.", flush=True)
                except:
                    pass
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
        # If some downloads failed, files may be shorter than qr[0]
        if not files or len(files) == 0:
            raise HTTPException(status_code=502, detail="No AIA files could be downloaded via Fido.")
        if len(files) < len(qr[0]):
            print(f"[fetch] Warning: Only {len(files)} out of {len(qr[0])} AIA files were downloaded successfully. Proceeding with available files.", flush=True)
            print(f"[fetch] Proceeding with {len(files)} successfully downloaded files (skipped failed).", flush=True)
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
            # In-place accumulation of AIA maps using float32 arrays
            shape = maps[0].data.shape
            combined_data = np.zeros(shape, dtype=np.float32)
            for m in maps:
                combined_data += np.nan_to_num(m.data.astype(np.float32))
            combined_meta = maps[0].meta.copy()
            combined_meta["history"] = combined_meta.get("history", "") + f" Combined {len(maps)} AIA frames via in-place accumulation"
            combined_map = Map(combined_data, combined_meta)
            # Save to cache
            if combined_cache_file is not None:
                np.savez_compressed(combined_cache_file, data=combined_data, meta=combined_meta)
                print(f"[cache] Saved combined map to {combined_cache_file}", flush=True)
            # Free memory
            print(f"[fetch] Combined {len(maps)} AIA frames into a single summed map.", flush=True)
            del maps, combined_meta
            import gc
            gc.collect()
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

    import gc
    from astropy.nddata import block_reduce

    # ✅ Keep only the first successfully downloaded file
    if isinstance(files, (list, tuple)) and len(files) > 1:
        print(f"[fetch] Reducing to first file to conserve memory.", flush=True)
        files = [files[0]]

    # ✅ Load and downsample the image early to reduce memory usage
    try:
        m = Map(files[0])
        print(f"[fetch] Downsampling data to reduce memory footprint...", flush=True)
        data_small = block_reduce(m.data.astype(np.float32), (4, 4), func=np.nanmean)
        header = m.fits_header
        header['CRPIX1'] /= 4
        header['CRPIX2'] /= 4
        header['CDELT1'] *= 4
        header['CDELT2'] *= 4
        smap_small = Map(data_small, header)
        del m
        import gc
        gc.collect()
        return smap_small
    except Exception as err:
        print(f"[fetch] Memory-safe downsample failed: {err}, returning raw map.", flush=True)
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
            block_size = 4
            from astropy.nddata import block_reduce
            import sunpy
            print("[render] Performing RHE...")
            header = smap.meta
            header['CRPIX1'] /= block_size
            header['CRPIX2'] /= block_size
            header['CDELT1'] *= block_size
            header['CDELT2'] *= block_size
            reduced_data = block_reduce(smap.data.astype(np.float32), block_size=block_size, func=np.nanmean)
            sunpy_map = sunpy.map.Map(reduced_data, header)
            # filtered_sample = rhef(sunpy_map, progress=True, method=rankdata_ignore_nan)
            filtered = rhef(sunpy_map, progress=False, vignette=1.51 * u.R_sun)
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
    dolog: bool = False,
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
        if dolog:
            data = np.log10(data)
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
    del data, fig
    import gc
    gc.collect()
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
        sep = "/" if "asset" in ASSET_BASE_URL else "/asset/"
        url = ASSET_BASE_URL.rstrip("/") + sep + filename
    else:
        # no CDN configured; expose a local file endpoint
        url = f"/asset/{filename}"
    print(f"{url = }")
    return {"path": path, "url": url}

# ──────────────────────────────────────────────────────────────────────────────
# Printful API (upload only; you can add mockups/orders later)
# ──────────────────────────────────────────────────────────────────────────────
def printful_upload(image_path: str, title: Optional[str], purpose: Optional[str]) -> Dict[str, Any]:
    print(f"[upload] Printful: {image_path}, title={title}, purpose={purpose}", flush=True)
    start_time = time.time()
    # if not PRINTFUL_API_KEY:
    PRINTFUL_API_KEY = os.environ.get("PRINTFUL_API_KEY", None)
    if not PRINTFUL_API_KEY:
        raise HTTPException(status_code=400, detail="PRINTFUL_API_KEY not configured.")
    # Normalize purpose to allowed Printful options
    allowed_purposes = {"default", "preview", "mockup"}
    normalized_purpose = purpose if purpose in allowed_purposes else "default"
    file_size = os.path.getsize(image_path)
    print(f"[upload][debug] Preparing upload ({file_size/1024/1024:.2f} MB)...", flush=True)

    # Compose the file_url for Printful API
    asset_base = os.getenv("SOLAR_ARCHIVE_ASSET_BASE_URL", "http://127.0.0.1:8000")
    # Ensure a single trailing slash and append /asset/ if not already present
    if not asset_base.rstrip("/").endswith("asset"):
        asset_base = asset_base.rstrip("/") + "/asset/"
    else:
        asset_base = asset_base.rstrip("/") + "/"
    file_url = f"{asset_base}{os.path.basename(image_path)}"
    print(f"[upload][debug] Using asset_base={asset_base}")
    print(f"[upload][debug] Final file_url={file_url}")
    # Use correct JSON keys for Printful upload
    json_data = {
        "url": file_url,
        "filename": title,
        "type": normalized_purpose
    }
    print("[upload][debug] Using JSON upload (url/type/filename)", flush=True)
    headers = {
        "Authorization": f"Bearer {PRINTFUL_API_KEY}",
        "Content-Type": "application/json"
    }
    print(f"[upload][debug] Uploading via JSON url={file_url}", flush=True)
    print(f"[upload][debug] Full upload URL = {PRINTFUL_BASE_URL}/files", flush=True)
    print(f"[upload][debug] Using PRINTFUL_BASE_URL={PRINTFUL_BASE_URL}", flush=True)
    r = requests.post(
        f"{PRINTFUL_BASE_URL}/files",
        headers=headers,
        json=json_data,
        timeout=90
    )
    end_time = time.time()
    print(f"[upload] Printful upload completed in {end_time - start_time:.2f}s", flush=True)
    try:
        result = r.json()
    except ValueError:
        result = json.loads(r.text)
    print(result, flush=True)
    return result

# Helper to create a Printful manual order from an uploaded printfile
def printful_create_order(file_id: int, title: str, recipient_info: Optional[dict] = None):
    """
    Create a one-off Printful manual order using the uploaded printfile.
    recipient_info: dict with keys like name, address1, city, country_code, zip, email.
    If not provided, uses dummy defaults.
    """

    PRINTFUL_API_KEY = os.environ.get("PRINTFUL_API_KEY", None)
    # print("PRINTFUL_API_KEY", flush=True)
    if not PRINTFUL_API_KEY:
        raise HTTPException(status_code=400, detail="PRINTFUL_API_KEY not configured.")
    headers = {"Authorization": f"Bearer {PRINTFUL_API_KEY}", "Content-Type": "application/json"}
    # Minimal recipient data for Printful orders
    default_recipient = {
        "name": "Solar Archive Test",
        "address1": "123 Example St",
        "city": "Boulder",
        "state_code": "CO",
        "country_code": "US",
        "zip": "80301",
        "email": "test@example.com"
    }
    recipient = recipient_info if recipient_info else default_recipient
    # 12x18 poster variant (4011); you can adjust this as needed
    items = [{
        "variant_id": 4011,
        "quantity": 1,
        "files": [{"id": file_id}],
        "name": title or "Solar Archive Poster"
    }]
    # Compose a safe, API-compliant external_id: short, alphanumeric, no dashes, max 32 chars
    safe_external_id = f"SA{int(time.time())}{file_id}"[:32]
    payload = {
        "recipient": recipient,
        "items": items,
        "external_id": safe_external_id,
    }
    print(f"[printful][order] Using external_id={safe_external_id}", flush=True)
    print(f"[printful][order] Creating manual order for file_id={file_id}, title={title}", flush=True)
    r = requests.post(f"{PRINTFUL_BASE_URL}/orders", headers=headers, json=payload)
    print(f"[printful][order] {PRINTFUL_BASE_URL}/orders")
    try:
        result = r.json()
    except Exception:
        result = {"error": r.text}
    if r.status_code >= 300:
        print(f"[printful][order][error] Order creation failed: {r.status_code} {r.text}", flush=True)
        raise HTTPException(status_code=r.status_code, detail=f"Order creation failed: {r.text}")
    order_id = result.get("result", {}).get("id") or result.get("id")
    print(f"[printful][order] Order created with ID: {order_id}", flush=True)
    return result

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

def fetch_quicklook_fits(mission: str, date_str: str, wavelength: int):
    """
    Quickly fetch a single FITS file for a mission/date/wavelength without preprocessing or filtering.
    Used for instant Shopify preview thumbnails.
    """
    from sunpy.net import Fido, attrs as a
    from astropy import units as u
    from sunpy.map import Map
    from datetime import datetime, timedelta

    dt = datetime.strptime(date_str, "%Y-%m-%d")
    t0 = dt
    t1 = dt + timedelta(seconds=12)

    # Use a very narrow search window for speed
    if mission.upper() == "SDO":
        wl = wavelength * u.angstrom
        print(f"[preview] Quicklook fetch for SDO/AIA {wl}", flush=True)
        qr = Fido.search(a.Time(t0, t1), a.Instrument("AIA"), a.Wavelength(wl))
    elif mission.upper() == "SOHO-EIT":
        wl = wavelength * u.angstrom
        print(f"[preview] Quicklook fetch for SOHO/EIT {wl}", flush=True)
        qr = Fido.search(a.Time(t0, t1), a.Instrument("EIT"), a.Wavelength(wl))
    elif mission.upper() == "SOHO-LASCO":
        print(f"[preview] Quicklook fetch for SOHO/LASCO", flush=True)
        qr = Fido.search(a.Time(t0, t1), a.Instrument("LASCO"))
    else:
        raise HTTPException(status_code=400, detail=f"Unknown mission: {mission}")

    if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
        raise HTTPException(status_code=404, detail=f"No quicklook data found for {mission} {date_str}")

    # Fetch only one file for speed
    files = Fido.fetch(qr[0, 0], progress=False)
    if not files or len(files) == 0:
        raise HTTPException(status_code=502, detail="Quicklook fetch failed")

    print(f"[preview] Quicklook file: {files[0]}", flush=True)
    return files[0]


@app.post("/shopify/preview")
async def shopify_preview(req: Request):
    params = await req.json()
    date_str = params.get("date")
    wavelength = params.get("wavelength", 171)
    mission = params.get("mission", "SDO")

    from sunpy.map import Map
    import matplotlib.pyplot as plt
    import numpy as np
    import os

    fits_path = fetch_quicklook_fits(mission, date_str, wavelength)
    smap = Map(fits_path)

    # Apply simple log10 scaling only
    data = np.log10(np.clip(smap.data, 1, None))
    out_png = os.path.join(OUTPUT_DIR, f"preview_{mission}_{wavelength}_{date_str}.png")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    plt.figure(figsize=(6, 6))
    plt.imshow(data, origin="lower", cmap="sdoaia{}".format(wavelength))
    plt.axis("off")
    plt.tight_layout(pad=0)
    plt.savefig(out_png, dpi=150, bbox_inches="tight", pad_inches=0)
    plt.close()

    preview_url = f"{ASSET_BASE_URL}preview_{mission}_{wavelength}_{date_str}.png"
    return {"preview_url": preview_url}


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
            pf_url = None
            try:
                pf_url = pf.get("result", {}).get("url")
            except Exception:
                pf_url = None
            if not pf_url:
                pf_url = pf.get("url") if isinstance(pf, dict) else None
            if pf_url:
                resp["printful_url"] = pf_url
            # Create Printful order after upload
            try:
                file_id = pf.get("result", {}).get("id")
                if file_id:
                    order = printful_create_order(file_id, req.title or f"Sun on {req.date}", None)
                    resp["printful_order"] = order
            except Exception as e:
                print(f"[upload] Printful order creation failed: {e}", flush=True)
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
            pf_url = None
            try:
                pf_url = pf.get("result", {}).get("url")
            except Exception:
                pf_url = None
            if not pf_url:
                pf_url = pf.get("url") if isinstance(pf, dict) else None
            if pf_url:
                resp["printful_url"] = pf_url
            # Create Printful order after upload
            try:
                file_id = pf.get("result", {}).get("id")
                if file_id:
                    order = printful_create_order(file_id, req.title or f"Sun on {req.date}", None)
                    resp["printful_order"] = order
            except Exception as e:
                print(f"[upload] Printful order creation failed: {e}", flush=True)
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
            pf_url = None
            try:
                pf_url = pf.get("result", {}).get("url")
            except Exception:
                pf_url = None
            if not pf_url:
                pf_url = pf.get("url") if isinstance(pf, dict) else None
            if pf_url:
                resp["printful_url"] = pf_url
            # Create Printful order after upload
            try:
                file_id = pf.get("result", {}).get("id")
                if file_id:
                    order = printful_create_order(file_id, req.title or f"Sun on {req.date}", None)
                    resp["printful_order"] = order
            except Exception as e:
                print(f"[upload] Printful order creation failed: {e}", flush=True)

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
        # Build HTML preview page
        html_content = f"""
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Solar Archive — {return_json.get("mission", "")} {return_json.get("meta", {}).get("wavelength", "")}Å</title>
            <style>
                body {{
                    background: #181820;
                    color: #f0f0f0;
                    min-height: 100vh;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    font-family: 'Segoe UI', 'Arial', sans-serif;
                    margin: 0;
                }}
                .container {{
                    background: #23232e;
                    border-radius: 16px;
                    padding: 32px 24px 24px 24px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    max-width: 95vw;
                }}
                img {{
                    max-width: 80vw;
                    max-height: 60vh;
                    border-radius: 10px;
                    box-shadow: 0 2px 16px rgba(0,0,0,0.4);
                    margin-bottom: 1.5em;
                    background: #000;
                }}
                .meta {{
                    margin-top: 1em;
                    margin-bottom: 1em;
                    font-size: 1.1em;
                    color: #bdbde7;
                }}
                .download-btn {{
                    background: #6a6aff;
                    color: #fff;
                    padding: 0.7em 1.4em;
                    border: none;
                    border-radius: 8px;
                    font-size: 1.1em;
                    font-weight: 500;
                    cursor: pointer;
                    margin-bottom: 1em;
                    text-decoration: none;
                    transition: background 0.2s;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.15);
                }}
                .download-btn:hover {{
                    background: #3a3ae7;
                }}
                .footer {{
                    margin-top: 2em;
                    font-size: 0.95em;
                    color: #888;
                }}
            </style>
        </head>
        <body>
            <div class="container">
                <h2>Solar Archive Preview</h2>
                <img src="{return_json.get("png_url", "")}" alt="Solar image preview">
                <a class="download-btn" href="{return_json.get("png_url", "")}" download>Download PNG</a>
                <div class="meta">
                    <div><b>Mission:</b> {return_json.get("mission", "")}</div>
                    <div><b>Wavelength:</b> {return_json.get("meta", {}).get("wavelength", "")} Å</div>
                    <div><b>Date:</b> {return_json.get("date", "")}</div>
                </div>
                <div class="footer">
                    {return_json.get("attribution", "")}
                </div>
            </div>
        </body>
        </html>
        """
        return HTMLResponse(content=html_content)

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


# ──────────────────────────────────────────────────────────────────────────────
# Shopify async job infrastructure
# ──────────────────────────────────────────────────────────────────────────────
import uuid
import threading
from fastapi import Request

# Shared jobs dictionary at module level
from datetime import datetime, timedelta
SHOPIFY_JOBS = {}

# Helper: append timestamped log to job's logs list and print
def append_job_log(job_id, message):
    ts = datetime.utcnow().strftime("%H:%M:%S")
    line = f"[{ts}] {message}"
    print(line, flush=True)
    job = SHOPIFY_JOBS.get(job_id)
    if job is not None and "logs" in job:
        job["logs"].append(line)

def process_shopify_job(job_id, body):
    """
    Background worker for Shopify job.
    """
    append_job_log(job_id, f"[shopify_generate:{job_id}] Processing job...")
    try:
        req = GenerateRequest(**body)
        try:
            dt = datetime.strptime(req.date, "%Y-%m-%d")
        except ValueError:
            append_job_log(job_id, "Invalid date format; expecting YYYY-MM-DD")
            raise Exception("date must be YYYY-MM-DD")
        mission = req.mission if req.mission != "auto" else choose_mission(dt)
        wl = req.wavelength
        det = req.detector
        append_job_log(job_id, f"Fetching map for mission={mission}, date={dt.date()}, wavelength={wl}, detector={det}")
        try:
            smap = fido_fetch_map(dt, mission, wl, det)
            append_job_log(job_id, f"Fetched map for {mission} {wl} {dt.date()}")
        except Exception as e:
            append_job_log(job_id, f"Error during fetch: {e}")
            raise
        if isinstance(smap, list) and len(smap) > 0:
            smap = smap[0]
        out_png = os.path.join(OUTPUT_DIR, f"{mission}_{wl or ''}_{req.date}.png")
        append_job_log(job_id, f"Rendering PNG to {out_png}")
        try:
            map_to_png(smap, out_png, annotate=req.annotate, dpi=req.png_dpi, size_inches=req.png_size_inches)
            append_job_log(job_id, f"Rendered PNG to {out_png}")
        except Exception as e:
            append_job_log(job_id, f"Error during render: {e}")
            raise
        new_paths = local_path_and_url(os.path.basename(out_png))
        SHOPIFY_JOBS[job_id].update({
            "status": "completed",
            "png_url": new_paths["url"],
            "message": "Render complete"
        })
        append_job_log(job_id, f"Job completed: {new_paths['url']}")
    except Exception as e:
        SHOPIFY_JOBS[job_id].update({
            "status": "error",
            "message": str(e),
            "png_url": None
        })
        append_job_log(job_id, f"Job failed: {e}")


@app.post("/shopify/generate")
async def shopify_generate(request: Request):
    """
    Shopify-friendly JSON endpoint for custom solar prints.
    Now non-blocking: spawns a background thread for generation and returns job_id.
    """
    print(f"[shopify_generate] Job accepted", flush=True)
    params = dict(request.query_params)
    if "signature" in params:
        print(f"[shopify_generate] Proxy signature received for shop={params.get('shop')}", flush=True)

    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {e}")

    # Generate a unique short job_id
    job_id = uuid.uuid4().hex[:8]
    # Save initial job state with logs
    SHOPIFY_JOBS[job_id] = {
        "status": "queued",
        "started_at": datetime.utcnow().isoformat(),
        "message": "Generation pending",
        "png_url": None,
        "logs": []
    }
    append_job_log(job_id, "Job queued and accepted")
    # Start background thread for processing
    thread = threading.Thread(target=process_shopify_job, args=(job_id, body), daemon=True)
    thread.start()
    # Immediately return job id and status endpoint
    return JSONResponse({
        "job_id": job_id,
        "status": "queued",
        "check_url": f"/shopify/status/{job_id}"
    })


@app.get("/shopify/status/{job_id}")
def shopify_job_status(job_id: str):
    job = SHOPIFY_JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    logs = job.get("logs", [])
    job_status = dict(job)
    job_status["logs_tail"] = logs[-10:] if len(logs) > 10 else logs
    return job_status

# Endpoint to get full job logs
@app.get("/shopify/log/{job_id}")
def shopify_job_log(job_id: str):
    job = SHOPIFY_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "logs": job.get("logs", [])}

# Endpoint to cleanup jobs older than 24 hours
@app.post("/shopify/cleanup")
def shopify_cleanup():
    cutoff = datetime.utcnow() - timedelta(hours=24)
    removed = []
    for job_id, job in list(SHOPIFY_JOBS.items()):
        try:
            start = datetime.fromisoformat(job.get("started_at"))
            if start < cutoff:
                del SHOPIFY_JOBS[job_id]
                removed.append(job_id)
        except Exception:
            continue
    return {"removed": removed, "remaining": list(SHOPIFY_JOBS.keys())}


# Debug endpoint: list registered routes
@app.get("/debug/routes")
def debug_routes():
    routes = [r.path for r in app.routes]
    print(f"[debug] Registered routes: {routes}", flush=True)
    return {"routes": routes}


# ──────────────────────────────────────────────────────────────────────────────
# Shopify proxy endpoints for Shopify Embedded App
# ──────────────────────────────────────────────────────────────────────────────

@app.post("/apps/solar-render")
async def proxy_solar_render(request: Request):
    try:
        body = await request.json()
        print("[proxy] /apps/solar-render received", body, flush=True)
        # directly call the existing /shopify/generate handler logic
        response = await app.router.routes_dict["/shopify/generate"].endpoint(body)
        print("[proxy] /apps/solar-render completed", flush=True)
        return response
    except Exception as e:
        print("[proxy] Error in /apps/solar-render:", e, flush=True)
        return JSONResponse(status_code=500, content={"error": str(e)})

@app.post("/apps/solar-preview")
async def proxy_solar_preview(request: Request):
    """
    Shopify proxy endpoint that invokes the real /shopify/preview handler directly.
    Always returns valid JSON.
    """
    try:
        body = await request.json()
        print("[proxy] /apps/solar-preview received", body, flush=True)
        result = await shopify_preview(request)

        # Handle different response types gracefully
        if isinstance(result, JSONResponse):
            print("[proxy] Returning JSONResponse directly", flush=True)
            return result
        elif isinstance(result, dict):
            print("[proxy] Returning dict as JSON", flush=True)
            return JSONResponse(content=result)
        elif hasattr(result, "body_iterator"):
            # Convert StreamingResponse body to text safely
            data = b"".join([chunk async for chunk in result.body_iterator])
            text = data.decode(errors="ignore").strip()
            if text.startswith("{") and text.endswith("}"):
                try:
                    parsed = json.loads(text)
                    return JSONResponse(content=parsed)
                except Exception:
                    pass
            print("[proxy] Returning fallback JSON wrapper", flush=True)
            return JSONResponse(content={"message": "Preview generated", "raw_response": text[:200]})
        else:
            print("[proxy] Unknown response type; wrapping", flush=True)
            return JSONResponse(content={"message": "Preview completed"})
    except Exception as e:
        print("[proxy] Error in /apps/solar-preview:", e, flush=True)
        import traceback; traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/generate-ui", response_class=HTMLResponse)
async def generate_ui():
    return """
    <html>
      <head><title>Solar Archive Generator</title></head>
      <body style="font-family:sans-serif; text-align:center; margin-top:5em;">
        <h2>Generate a Solar Image</h2>
        <form id="genform">
          <label>Date:</label>
          <input type="date" id="date" required>
          <button type="submit">Generate</button>
        </form>
        <div id="output"></div>

        <script>
          const form = document.getElementById('genform');
          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const date = document.getElementById('date').value;
            const res = await fetch(`/generate?date=${date}`);
            const data = await res.json();
            document.getElementById('output').innerHTML = `
              <h3>Result:</h3>
              <img src="${data.image_url}" width="400"><br>
              <button onclick="sendToPrintful('${data.image_url}')">Use in Printful</button>`;
          });

          async function sendToPrintful(url) {
            const res = await fetch('/upload_to_printful', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({image_url: url})
            });
            const result = await res.json();
            alert(result.status || JSON.stringify(result));
          }
        </script>
      </body>
    </html>
    """

# ──────────────────────────────────────────────────────────────────────────────
# New endpoint: /upload_to_printful
# ──────────────────────────────────────────────────────────────────────────────
from fastapi import Body
from pydantic import BaseModel

class UploadToPrintfulRequest(BaseModel):
    image_url: str

@app.post("/upload_to_printful")
async def upload_to_printful(request: UploadToPrintfulRequest):
    """
    Upload an image from a given URL to Printful using the /files API.
    """
    print("[upload_to_printful] Starting upload", flush=True)
    PRINTFUL_API_KEY = os.environ.get("PRINTFUL_API_KEY", None)
    PRINTFUL_BASE_URL = os.environ.get("PRINTFUL_BASE_URL", "https://api.printful.com")
    if not PRINTFUL_API_KEY:
        print("[upload_to_printful] PRINTFUL_API_KEY not set", flush=True)
        raise HTTPException(status_code=400, detail="PRINTFUL_API_KEY not configured.")
    image_url = request.image_url
    if not image_url or not isinstance(image_url, str):
        print("[upload_to_printful] image_url missing or invalid", flush=True)
        raise HTTPException(status_code=400, detail="image_url is required")
    # Compose Printful upload payload
    payload = {
        "url": image_url,
        # Optionally, filename/type could be set, but we leave them None for generic upload
    }
    headers = {
        "Authorization": f"Bearer {PRINTFUL_API_KEY}",
        "Content-Type": "application/json"
    }
    print(f"[upload_to_printful] Uploading image_url={image_url} to {PRINTFUL_BASE_URL}/files", flush=True)
    try:
        r = requests.post(
            f"{PRINTFUL_BASE_URL}/files",
            headers=headers,
            json=payload,
            timeout=60
        )
        print(f"[upload_to_printful] Printful response code: {r.status_code}", flush=True)
        try:
            resp_json = r.json()
        except Exception:
            resp_json = {"error": r.text}
        # Extract id and url if available
        result = resp_json.get("result", {})
        response = {
            "printful_response": resp_json,
            "id": result.get("id"),
            "url": result.get("url"),
            "status": "success" if r.status_code < 300 else "error"
        }
        print(f"[upload_to_printful] Completed", flush=True)
        return response
    except Exception as e:
        print(f"[upload_to_printful] Exception: {e}", flush=True)
        raise HTTPException(status_code=500, detail=f"Failed to upload to Printful: {e}")