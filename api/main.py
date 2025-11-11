import uuid

# Registry to track background tasks for /generate
task_registry: dict = {}
from urllib.parse import urlencode, quote_plus
import os, sys
os.environ["PYTHONUNBUFFERED"] = "1"
try:
    sys.stdout.reconfigure(write_through=True)
    sys.stderr.reconfigure(write_through=True)
except Exception:
    pass
import io
import os
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
from fastapi import Body
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
import asyncio

# sunback/webapp/api/main.py
# FastAPI backend for Solar Archive — date→FITS via SunPy→filtered PNG→(optional) Printful upload

class PreviewRequest(BaseModel):
    date: str
    wavelength: int
    mission: str | None = "SDO"
    annotate: bool | None = False

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

#
# Set SOLAR_ARCHIVE_ASSET_BASE_URL based on environment, removing trailing slashes for consistency.
if not os.getenv("SOLAR_ARCHIVE_ASSET_BASE_URL"):
    if os.getenv("RENDER"):
        url = "https://solar-archive.onrender.com/asset"
        url = url.rstrip("/")
        os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = url
        print(f"[startup] Using default public asset base URL for Render: {url}", flush=True)
    else:
        url = "http://127.0.0.1:8000/asset"
        url = url.rstrip("/")
        os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = url
        print(f"[startup] Using local asset base URL: {url}", flush=True)

os.makedirs(os.environ["SUNPY_DOWNLOADDIR"], exist_ok=True)

print(f"[startup] SunPy config_dir={os.environ['SUNPY_CONFIGDIR']}", flush=True)
print(f"[startup] SunPy download_dir={os.environ['SUNPY_DOWNLOADDIR']}", flush=True)
print(f"[startup] Using SSL_CERT_FILE={os.environ['SSL_CERT_FILE']}", flush=True)
print(f"[startup] Using VSO_URL={os.environ['VSO_URL']}", flush=True)



# Synchronous fetch helper with clear log
def fetch_sync_safe(query):
    log_to_queue("[fetch] Fido.fetch (sync, max_conn=10, no progress)")
    from parfive import Downloader
    dl = Downloader(
        max_conn=12,
        progress=True,
        overwrite=False
    )
    return Fido.fetch(query, downloader=dl)


# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────
APP_NAME = "Solar Archive Backend"
OUTPUT_DIR = os.getenv("SOLAR_ARCHIVE_OUTPUT_DIR", base_tmp)

if os.getenv("RENDER"):
    os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = "https://solar-archive.onrender.com/"
else:
    os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = "http://127.0.0.1:8000/asset/"

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

from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import sys
import threading

app = FastAPI(title=APP_NAME)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "*",
        "https://solar-archive.myshopify.com",
        "https://*.myshopify.com",
        "https://shop.app",
        "https://solar-archive.onrender.com",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://127.0.0.1:3000",
        "http://localhost:3000",
    ],
    allow_origin_regex=r"https://[a-zA-Z0-9-]+\.myshopify\.com",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# Serve /api/test_frontend.html and other frontend assets
# app.mount("/api", StaticFiles(directory="/Users/cgilbert/vscode/sunback/webapp/api"), name="api")

from pathlib import Path
app_dir = Path(__file__).parent
app.mount("/api", StaticFiles(directory=app_dir, html=True), name="api")



import logging
log_queue: asyncio.Queue[str] = asyncio.Queue()

def log_to_queue(msg: str):
    """Add message to both the console and the live streaming log."""
    try:
        log_queue.put_nowait(msg)
    except Exception:
        pass
    print(msg, flush=True)
    sys.stdout.flush()


# ⬇️ Add this block immediately after log_to_queue()
class QueueLogHandler(logging.Handler):
    def emit(self, record):
        try:
            msg = self.format(record)
            log_to_queue(msg)
        except Exception:
            pass

root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO)
root_logger.addHandler(QueueLogHandler())
# Mirror log messages to stdout and propagate to parent handlers
root_logger.propagate = True
stream_handler = logging.StreamHandler()
root_logger.addHandler(stream_handler)

# --- Live mirroring of stdout/stderr to SSE log queue ---
def stream_stdout_to_queue(stream, prefix="[stdout]"):
    while True:
        try:
            line = stream.readline()
            if not line:
                break
            if line.strip():
                log_to_queue(f"{prefix} {line.strip()}")
        except Exception:
            break

def start_stream_mirroring():
    try:
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass
    threading.Thread(target=stream_stdout_to_queue, args=(sys.stdout, "[stdout]"), daemon=True).start()
    threading.Thread(target=stream_stdout_to_queue, args=(sys.stderr, "[stderr]"), daemon=True).start()

start_stream_mirroring()




@app.get("/logs/stream")
async def stream_logs(request: Request):
    import asyncio
    async def event_generator():
        # Disable buffering where possible
        yield ":\n\n"  # send a comment frame to start connection immediately
        while True:
            if await request.is_disconnected():
                break
            try:
                msg = log_queue.get_nowait()
            except asyncio.QueueEmpty:
                yield ": keep-alive\n\n"
                await asyncio.sleep(1)
                continue
            # Each message is its own SSE event
            yield f"data: {msg}\n\n"
            sys.stdout.flush()
            sys.stderr.flush()
            # Explicit flush via tiny async sleep — ensures event is written immediately
            await asyncio.sleep(0.01)
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disables nginx/gunicorn buffering if present
            "Connection": "keep-alive"
        }
    )


import shutil
@app.post("/clear_cache")
async def clear_cache():
    try:
        shutil.rmtree("/tmp/output", ignore_errors=True)
        os.makedirs("/tmp/output", exist_ok=True)
        sunpy_cache = os.path.expanduser("~/.sunpy/data")
        shutil.rmtree(sunpy_cache, ignore_errors=True)
        os.makedirs(sunpy_cache, exist_ok=True)
        log_to_queue("[cache] Cleared /tmp/output and ~/.sunpy/data caches.")
        return {"status": "success", "message": "Cache cleared successfully."}
    except Exception as e:
        log_to_queue(f"[cache] Error clearing cache: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to clear cache: {e}")


# ──────────────────────────────────────────────────────────────────────────────
# Upload to Printful endpoint
# ──────────────────────────────────────────────────────────────────────────────
@app.post("/upload_to_printful")
async def upload_to_printful(request: Request):
    """
    Upload a generated image to Printful's file library.
    Receives JSON body with keys 'image_path' and optional 'title'.
    """
    try:
        payload = await request.json()
        image_path = payload.get("image_path")
        title = payload.get("title", os.path.basename(image_path) if image_path else "Solar Archive Image")
        # Accept relative paths under /tmp/output for safety
        if not image_path:
            log_to_queue(f"[upload] No image_path provided in request.")
            raise HTTPException(status_code=400, detail="image_path is required")
        # If image_path is not absolute, prepend /tmp/output
        if not os.path.isabs(image_path):
            image_path = os.path.join("/tmp/output", image_path)
        if not os.path.exists(image_path):
            log_to_queue(f"[upload] File not found: {image_path}")
            raise HTTPException(status_code=400, detail=f"File not found: {image_path}")
        if not PRINTFUL_API_KEY:
            log_to_queue("[upload] PRINTFUL_API_KEY is missing.")
            raise HTTPException(status_code=500, detail="Missing PRINTFUL_API_KEY in environment")
        log_to_queue(f"[upload] Uploading {image_path} to Printful...")
        with open(image_path, "rb") as f:
            files = {"file": (os.path.basename(image_path), f, "image/png")}
            data = {"purpose": "default", "filename": title}
            headers = {"Authorization": f"Bearer {PRINTFUL_API_KEY}"}
            response = requests.post(f"{PRINTFUL_BASE_URL}/files", headers=headers, files=files, data=data)
        if response.status_code >= 400:
            log_to_queue(f"[upload] Printful upload failed: {response.status_code} {response.text}")
            raise HTTPException(status_code=response.status_code, detail=response.text)
        result = response.json()
        file_id = result.get("result", {}).get("id")
        file_url = result.get("result", {}).get("url")
        log_to_queue(f"[upload] Printful upload successful: file_id={file_id}, url={file_url}")
        return JSONResponse({"status": "success", "file_id": file_id, "file_url": file_url, "raw": result})
    except Exception as e:
        log_to_queue(f"[upload] Exception during upload_to_printful: {e}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")


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
            const submitBtn = form.querySelector('button[type="submit"]');
            const previewSection = document.getElementById('preview-section');
            const previewImg = document.getElementById('preview-img');
            const previewMeta = document.getElementById('preview-meta');
            const shopifyBtn = document.getElementById('shopify-btn');
            let lastImageUrl = "";
            let lastMeta = "";
            form.addEventListener('submit', handleGenerate, { once: true });
            async function handleGenerate(e) {
                e.preventDefault();
                submitBtn.disabled = true;
                submitBtn.textContent = 'Generating...';
                const date = document.getElementById('date').value;
                if (!date) {
                    alert("Please select a date.");
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Generate Preview';
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
                        mission: "SDO",
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
                        let dateMatch = responseText.match(/<div><b>Date:<\\/b>\\s*([^<]+)<\\/div>/i);
                        let wlMatch = responseText.match(/<div><b>Wavelength:<\\/b>\\s*([^<]+) Å<\\/div>/i);
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
                submitBtn.disabled = false;
                submitBtn.textContent = 'Generate Preview';
            }
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
    mission: Optional[Literal["SDO", "SOHO-EIT", "SOHO-LASCO"]] = "SDO"
    wavelength: Optional[int] = Field(None, description="Angstroms for AIA/EIT (e.g., 211 or 195)")
    detector: Optional[Literal["AIA", "C2", "C3"]] = "AIA"
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
        log_to_queue(f"[fetch] [AIA] aiapy.calibrate unavailable ({e}); skipping manual prep.")
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
                    log_to_queue(f"[fetch] [AIA] get_pointing fallback failed: {pt_err}")
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
                log_to_queue(f"[fetch] [AIA] Manual recentering failed: {manual_err}")
    # Apply pointing update if we obtained a table
    m = smap
    try:
        if pointing_table is not None:
            m = update_pointing(smap, pointing_table=pointing_table)
        else:
            m = smap
    except TypeError as te:
        log_to_queue(f"[fetch] [AIA] update_pointing requires pointing_table on this aiapy version ({te}); skipping.")
    except Exception as e:
        log_to_queue(f"[fetch] [AIA] update_pointing failed: {e}; proceeding without.")
    # Register (rotate to north-up, scale to 0.6 arcsec/pix, recenter)
    try:
        m = register(m)
    except Exception as reg_err:
        log_to_queue(f"[fetch] [AIA] register failed: {reg_err}; continuing with unregistered map.")
    # Exposure normalization
    try:
        if hasattr(m, "exposure_time") and m.exposure_time is not None:
            data_norm = m.data / m.exposure_time.to(u.s).value
            m = Map(data_norm, m.meta)
    except Exception as norm_err:
        log_to_queue(f"[fetch] [AIA] Exposure normalization failed: {norm_err}")
    return Map(m.data, m.meta)

@app.get("/debug/list_output")
async def list_output():
    from pathlib import Path
    root = Path(OUTPUT_DIR)
    files = sorted([str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()])
    return {"output_dir": OUTPUT_DIR, "files": files}


def aiaprep_new(smap):
    """
    Equivalent to aia_prep via aiapy: updates pointing, aligns to common plate scale,
    and north-up registers the map.

    Parameters
    ----------
    smap : sunpy.map.Map
        Input level-1 (or earlier) AIA map.

    Returns
    -------
    sunpy.map.Map
        Calibrated/registered map (level-1.5 equivalent).
    """
    from aiapy.calibrate.utils import get_pointing_table
    from aiapy.calibrate import update_pointing, register
    import astropy.units as u

    # Determine a time window to fetch pointing table: ±12h around observation time (as per docs example)
    obs_time = smap.date
    t0 = obs_time - 12 * u.hour
    t1 = obs_time + 12 * u.hour

    # Fetch pointing table
    pointing_table = get_pointing_table("JSOC", time_range=(t0, t1))

    # Update pointing metadata
    try:
        smap_updated = update_pointing(smap, pointing_table=pointing_table)
    except Exception as e:
        # Fallback: if update_pointing fails, log and use original map
        log_to_queue(f"[fetch][warn] update_pointing failed: {e}")
        smap_updated = smap

    # Register (rescale, derotate, north-up) to common grid
    try:
        smap_registered = register(smap_updated)
    except Exception as e:
        log_to_queue(f"[fetch][warn] register failed: {e}; returning unregistered map")
        smap_registered = smap_updated

    # Normalize exposure time if available
    try:
        exptime = smap_registered.meta.get("exptime")
        if exptime is not None:
            norm_data = smap_registered.data.astype(float) / float(exptime)
            from sunpy.map import Map as SunpyMap
            smap_registered = SunpyMap(norm_data, smap_registered.meta)
    except Exception as e:
        log_to_queue(f"[fetch][warn] exposure normalization failed: {e}")

    return smap_registered



def fido_fetch_map(dt: datetime, mission: str, wavelength: Optional[int], detector: Optional[str]) -> Map:
    """
    Retrieve a SunPy Map near the given date for the chosen mission.
    We search a small window around the date to find at least one file.
    For SDO/AIA, try JSOC first (with email), fallback to Fido if needed.
    """
    log_to_queue(f"[fetch] mission={mission}, date={dt.date()}, wavelength={wavelength}, detector={detector}")
    # Normalize wavelength and detector for cache keys
    wl_used = None
    det_used = (detector or DEFAULT_DETECTOR_LASCO)
    if mission == "SDO":
        wl_used = int(wavelength or int(DEFAULT_AIA_WAVELENGTH.value))
    elif mission == "SOHO-EIT":
        wl_used = int(wavelength or int(DEFAULT_EIT_WAVELENGTH.value))
    if mission == "SDO" and dt < SDO_EPOCH:
        print(f"[fetch] Date {dt.date()} before SDO; switching to SOHO-EIT.", flush=True)
        mission = "SOHO-EIT"
    start_time = time.time()

    # small search window to find nearest frame on that date
    t0 = dt
    t1 = dt + timedelta(minutes=2)

    # Caching for combined (summed) AIA data
    # import numpy as _np
    import numpy as np
    combined_cache_file = None
    date_str = dt.strftime("%Y%m%d")
    if mission == "SDO":
        combined_cache_file = os.path.join(OUTPUT_DIR, f"temp_combined_{mission}_{wl_used}_{date_str}.npz")
        # Optional: warn if legacy cache exists but new cache does not
        legacy_ccf = os.path.join(OUTPUT_DIR, f"temp_combined_{mission}_{date_str}.npz")
        if os.path.exists(legacy_ccf) and not os.path.exists(combined_cache_file):
            log_to_queue(f"[cache][warn] Found legacy combined cache without wavelength: {legacy_ccf}. It will be ignored.")
        if os.path.exists(combined_cache_file):
            log_to_queue(f"[cache] Loaded combined cache for {mission} {wl_used}Å on {date_str}")
            with np.load(combined_cache_file, allow_pickle=True) as npz:
                combined_data = npz["data"]
                combined_meta = npz["meta"].item()
            combined_map = Map(combined_data, combined_meta)
            log_to_queue(f"[fetch] Returning combined map ({combined_meta['n_frames']} frames).")
            return combined_map

    if mission == "SDO":
        # Always fetch full-res 4K AIA data from JSOC, never fall back to synoptic or low-res products
        from sunpy.net import Fido, attrs as a
        import astropy.units as u
        wl = wavelength or int(DEFAULT_AIA_WAVELENGTH.value)
        notify = "chris.gilly@colorado.edu"
        log_to_queue(f"[fetch] Requested JSOC series: aia.lev1_euv_12s ({wl}Å)")
        qr = Fido.search(
            a.Time(dt - timedelta(minutes=1), dt + timedelta(minutes=1)),
            a.jsoc.Series("aia.lev1_euv_12s"),
            a.jsoc.Segment("image"),
            a.jsoc.Wavelength(wl * u.angstrom),
            a.jsoc.Notify(notify)
        )
        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            log_to_queue(f"[fetch] [AIA] No JSOC aia.lev1_euv_12s results in ±1min, retrying ±10min...")
            qr = Fido.search(
                a.Time(dt - timedelta(minutes=10), dt + timedelta(minutes=10)),
                a.jsoc.Series("aia.lev1_euv_12s"),
                a.jsoc.Segment("image"),
                a.jsoc.Wavelength(wl * u.angstrom),
                a.jsoc.Notify(notify)
            )
        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            log_to_queue(f"[fetch] [AIA] No JSOC aia.lev1_euv_12s results in ±10min. No fallback available.")
            raise HTTPException(status_code=502, detail="No JSOC aia.lev1_euv_12s data available for this date.")
        log_to_queue(f"[fetch] [AIA] JSOC aia.lev1_euv_12s: {len(qr[0])} results...")
        from parfive import Downloader
        dl = Downloader(max_conn=15, progress=True)
        target_dir = os.environ["SUNPY_DOWNLOADDIR"]
        # Always call Fido.fetch; downloader will skip already-downloaded files but return the full list
        files = Fido.fetch(qr, downloader=dl, path=target_dir)
        try:
            files = list(map(str, files))
        except Exception:
            files = list(files) if isinstance(files, (list, tuple)) else [str(files)]
        log_to_queue(f"[fetch] Retrieved {len(files)} AIA frames from JSOC (existing files were skipped by the downloader if present).")
        if not files or len(files) == 0:
            log_to_queue(f"[fetch] [AIA] JSOC fetch returned no files.")
            raise HTTPException(status_code=502, detail="No files from JSOC aia.lev1_euv_12s fetch.")
        # Improved: Combine all AIA frames into a single time-integrated, exposure-weighted mean intensity map,
        # ensuring co-alignment in time and WCS, with detailed progress logging and SNR diagnostics.
        if isinstance(files, (list, tuple)) and len(files) > 1:
            import numpy as np
            maps = []
            for i, f in enumerate(files):
                m = Map(f)
                log_to_queue(f"[fetch][progress] Prepping {i+1}/{len(files)}")
                try:
                    m_prep = None
                    try:
                        m_prep = aiaprep_new(m)
                    except Exception as e:
                        log_to_queue(f"[fetch][warn] aiapy prep failed for {os.path.basename(f)}: {e}")
                        m_prep = m
                    maps.append(m_prep)
                except Exception as e:
                    log_to_queue(f"[fetch][warn] aiaprep failed for {os.path.basename(f)}: {e}")
                    maps.append(m)
            # Optionally: check WCS alignment (simple check)
            ref_wcs = maps[0].wcs if hasattr(maps[0], "wcs") else None
            for i, m in enumerate(maps):
                if ref_wcs is not None and hasattr(m, "wcs"):
                    if m.data.shape != maps[0].data.shape:
                        log_to_queue(f"[fetch][warn] Frame {i+1} shape {m.data.shape} != ref {maps[0].data.shape}")
            exptimes = np.array([float(m.meta.get("exptime", 1.0)) for m in maps])
            log_to_queue("[fetch][progress] Exposure-weighted combination")
            data_stack = np.stack([m.data for m in maps])
            weighted_sum = np.nansum(data_stack * exptimes[:, None, None], axis=0)
            sum_exp = np.nansum(exptimes)
            combined_data = weighted_sum / sum_exp

            # SNR diagnostics on a central patch
            try:
                h, w = maps[0].data.shape
                x0, x1 = int(w // 2 - 128), int(w // 2 + 128)
                y0, y1 = int(h // 2 - 128), int(h // 2 + 128)
                sigma_single = float(np.nanstd(maps[0].data[y0:y1, x0:x1] / max(exptimes[0], 1e-6)))
                sigma_comb = float(np.nanstd(combined_data[y0:y1, x0:x1]))
                snr_gain = (sigma_single / sigma_comb) if sigma_comb > 0 else float("nan")
                log_to_queue(f"[fetch][snr] Central patch σ_single/σ_combined = {sigma_single:.3g}/{sigma_comb:.3g} → gain ≈ {snr_gain:.2f}× (expected ~{np.sqrt(len(maps)):.2f}×)")
            except Exception as snr_err:
                log_to_queue(f"[fetch][snr][warn] Unable to compute SNR diagnostics: {snr_err}")

            combined_meta = maps[0].meta.copy()
            combined_meta["n_frames"] = len(maps)
            combined_meta["t_start"] = str(maps[0].date)
            combined_meta["t_end"] = str(maps[-1].date)
            combined_map = Map(combined_data, combined_meta)
            log_to_queue(f"[fetch] Combined {len(maps)} frames with exposure weighting over {combined_meta['t_start']} → {combined_meta['t_end']}")
            log_to_queue("[fetch][progress] Integration complete")

            date_str = dt.strftime("%Y%m%d")
            # Use a wavelength key that matches the cache-read key
            try:
                from astropy import units as _u
                wl_key = int((wavelength or int(DEFAULT_AIA_WAVELENGTH.value)))
            except Exception:
                wl_key = int(DEFAULT_AIA_WAVELENGTH.value)
            combined_cache_file = os.path.join(OUTPUT_DIR, f"temp_combined_{mission}_{wl_key}_{date_str}.npz")
            np.savez_compressed(combined_cache_file, data=combined_data, meta=combined_meta)
            log_to_queue(f"[cache] Saved combined map to {combined_cache_file}")
            del maps
            import gc
            gc.collect()
            log_to_queue(f"[fetch] Returning combined map ({combined_meta['n_frames']} frames).")
            return combined_map
        else:
            single_map = Map(files[0])
            log_to_queue(f"[fetch] Returning combined map (1 frames).")
            return single_map
    elif mission == "SOHO-EIT":
        wl = (wavelength or int(DEFAULT_EIT_WAVELENGTH.value)) * u.angstrom
        log_to_queue(f"[fetch] SOHO-EIT wavelength {wl}")
        qr = Fido.search(a.Time(t0, t1), a.Instrument("EIT"), a.Wavelength(wl))
    elif mission == "SOHO-LASCO":
        det = detector or DEFAULT_DETECTOR_LASCO
        log_to_queue(f"[fetch] SOHO-LASCO detector {det}")
        qr = Fido.search(a.Time(t0, t1), a.Instrument("LASCO"), a.Detector(det))
    else:
        raise HTTPException(status_code=400, detail=f"Unknown mission {mission}")

    if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
        log_to_queue(f"[fetch] No data in initial window, widening search...")
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

    log_to_queue(f"[fetch] {len(qr[0])} results, fetching first file...")
    fetch_start = time.time()
    files = None
    max_attempts = 3
    last_exception = None
    for attempt in range(1, max_attempts + 1):
        try:
            log_to_queue(f"[fetch] Attempt {attempt} to fetch...")
            from parfive import Downloader
            dl = Downloader(max_conn=10, progress=False, overwrite=False)
            target_dir = os.environ["SUNPY_DOWNLOADDIR"]
            files = Fido.fetch(qr[0, 0], downloader=dl, path=target_dir)
            if files and len(files) > 0:
                break
        except Exception as exc:
            last_exception = exc
            log_to_queue(f"[fetch] Exception in fetch attempt {attempt}: {exc}")
            if attempt < max_attempts:
                log_to_queue(f"[fetch] Sleeping 5 seconds before retry...")
                time.sleep(5)
    fetch_end = time.time()

    if not files or len(files) == 0:
        print(f"[fetch] No files after {max_attempts} attempts!", flush=True)
        raise HTTPException(
            status_code=502,
            detail=f"No files could be downloaded for {mission} on {dt.date()} after {max_attempts} attempts."
        )
    log_to_queue(f"[fetch] Downloaded file {files[0]} in {fetch_end - fetch_start:.2f}s")

    import gc
    from astropy.nddata import block_reduce

    # ✅ Keep only the first successfully downloaded file
    if isinstance(files, (list, tuple)) and len(files) > 1:
        log_to_queue(f"[fetch] Reducing to first file to conserve memory.")
        files = [files[0]]

    # ✅ Load and downsample the image early to reduce memory usage
    try:
        m = Map(files[0])
        log_to_queue(f"[fetch] Downsampling data to reduce memory footprint...")
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
        log_to_queue(f"[fetch] Memory-safe downsample failed: {err}, returning raw map.")
        return Map(files[0])


# Shared SOHO-EIT fallback for SDO failures
def soho_eit_fallback(dt: datetime) -> Map:
    log_to_queue(f"[fetch] Fallback to SOHO-EIT 195Å")
    fallback_wl = int(DEFAULT_EIT_WAVELENGTH.value)
    t0 = dt
    t1 = dt + timedelta(days=1)
    fallback_qr = Fido.search(a.Time(t0, t1), a.Instrument("EIT"), a.Wavelength(fallback_wl * u.angstrom))
    if len(fallback_qr) == 0 or all(len(resp) == 0 for resp in fallback_qr):
        log_to_queue(f"[fetch] No fallback SOHO-EIT data in window, widening...")
        t0b = dt - timedelta(days=1)
        t1b = dt + timedelta(days=2)
        fallback_qr = Fido.search(a.Time(t0b, t1b), a.Instrument("EIT"), a.Wavelength(fallback_wl * u.angstrom))
    fallback_files = None
    max_attempts = 3
    for attempt in range(1, max_attempts + 1):
        try:
            log_to_queue(f"[fetch] Fallback attempt {attempt}...")
            from parfive import Downloader
            dl = Downloader(max_conn=10, progress=False, overwrite=False)
            fallback_files = Fido.fetch(fallback_qr[0, 0], downloader=dl, path=os.environ["SUNPY_DOWNLOADDIR"])
            if fallback_files and len(fallback_files) > 0:
                break
        except Exception as exc:
            log_to_queue(f"[fetch] Exception in fallback attempt {attempt}: {exc}")
            if attempt < max_attempts:
                log_to_queue(f"[fetch] Sleeping 5 seconds before retry...")
                time.sleep(5)
    if fallback_files and len(fallback_files) > 0:
        log_to_queue(f"[fetch] Fallback downloaded file {fallback_files[0]}")
        return Map(fallback_files[0])
    else:
        log_to_queue(f"[fetch] Fallback failed, no files.")
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
            log_to_queue("[render] Performing RHE...")
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
        log_to_queue("[render] RHEF filter failed with exception:")
        traceback.print_exc()
        log_to_queue(f"[render] RHEF filter failed: {e}. Using asinh stretch.")
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
    log_to_queue(f"[render] Rendering to {out_png}")
    start_time = time.time()
    # Determine colormap and meta info for both renders
    from sunpy.visualization.colormaps import color_tables as ct
    wl_meta = smap.meta.get('wavelnth') or smap.meta.get('WAVELNTH')
    inst = smap.meta.get("instrume") or smap.meta.get("instrument") or ""
    # Dynamically determine wavelength value for colormap
    wl_value = wl_meta
    if wl_value is None:
        wl_value = 211
    try:
        wl_value_int = int(wl_value)
    except Exception:
        wl_value_int = 211
    if "AIA" in inst.upper() and wl_value_int in [94, 131, 171, 193, 211, 304, 335, 1600, 1700, 4500]:
        cmap = ct.aia_color_table(wl_value_int * u.angstrom)
        cmap_name = f"aia_color_table({wl_value_int})"
        log_to_queue(f"[render] Using dynamic wavelength colormap: {cmap_name}")
    elif "EIT" in inst.upper():
        cmap = plt.get_cmap("sohoeit195") if wl_value_int == 195 else plt.get_cmap("gray")
        cmap_name = f"sohoeit{wl_value_int}" if wl_value_int else "gray"
        log_to_queue(f"[render] Using dynamic wavelength colormap: {cmap_name}")
    else:
        cmap = smap.plot_settings.get("cmap", plt.get_cmap("gray"))
        cmap_name = str(getattr(cmap, "name", "gray"))
        log_to_queue(f"[render] Using colormap: {cmap_name}")


    # Caching for filtered data
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
    # Also normalize wavelength and detector for cache key
    try:
        wl_value_int = int(wl_meta) if wl_meta else None
    except Exception:
        wl_value_int = None
    det_meta = (smap.meta.get('detector') or smap.meta.get('DETECTOR') or '').strip()
    # Cache key includes instrument + wavelength (and detector if available) + date
    cache_key_parts = [str(inst).upper()]
    if wl_value_int:
        cache_key_parts.append(str(wl_value_int))
    if det_meta:
        cache_key_parts.append(det_meta.upper())
    cache_key = "_".join(cache_key_parts)
    filtered_cache_file = os.path.join(OUTPUT_DIR, f"temp_filtered_{cache_key}_{date_for_cache}.npz")
    log_to_queue(f"[cache] Filter cache file: {filtered_cache_file}")
    rhef_failed = False
    # Try to load from cache, but rerun filter if previous run failed (rhef_failed marker)
    if os.path.exists(filtered_cache_file):
        log_to_queue(f"[cache] Using cached filtered data from {filtered_cache_file}...")
        with np.load(filtered_cache_file, allow_pickle=True) as npz:
            data = npz["data"]
            rhef_failed = bool(npz.get("rhef_failed", False))
        if rhef_failed:
            log_to_queue("[cache] Previous filter run failed (rhef_failed=True); rerunning filter...")
            filtered_map = default_filter(smap)
            # If filtered_map is a Map, extract .data and check for fallback
            data = filtered_map.data if hasattr(filtered_map, "data") else filtered_map
            rhef_failed = bool(getattr(filtered_map, "meta", {}).get("rhef_failed", False))
            np.savez_compressed(filtered_cache_file, data=data, rhef_failed=rhef_failed)
            log_to_queue(f"[cache] Saved filtered data to {filtered_cache_file}")
    else:
        filtered_map = default_filter(smap)
        # If filtered_map is a Map, extract .data and check for fallback
        data = filtered_map.data if hasattr(filtered_map, "data") else filtered_map
        if dolog:
            data = np.log10(data)
        rhef_failed = bool(getattr(filtered_map, "meta", {}).get("rhef_failed", False))
        np.savez_compressed(filtered_cache_file, data=data, rhef_failed=rhef_failed)
        log_to_queue(f"[cache] Saved filtered data to {filtered_cache_file}")
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
    log_to_queue(f"[render] Saving postfilter image to {out_png}")
    fig.savefig(out_png, bbox_inches="tight", pad_inches=0)
    plt.close(fig)
    del data, fig
    import gc
    gc.collect()
    end_time = time.time()
    log_to_queue(f"[render] Finished in {end_time - start_time:.2f}s")
    log_to_queue(f"[render] Image saved to directory: {os.path.dirname(out_png)}")
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
    log_to_queue(f"[upload] Printful: {image_path}, title={title}, purpose={purpose}")
    start_time = time.time()
    # if not PRINTFUL_API_KEY:
    PRINTFUL_API_KEY = os.environ.get("PRINTFUL_API_KEY", None)
    if not PRINTFUL_API_KEY:
        raise HTTPException(status_code=400, detail="PRINTFUL_API_KEY not configured.")
    # Normalize purpose to allowed Printful options
    allowed_purposes = {"default", "preview", "mockup"}
    normalized_purpose = purpose if purpose in allowed_purposes else "default"
    file_size = os.path.getsize(image_path)
    log_to_queue(f"[upload][debug] Preparing upload ({file_size/1024/1024:.2f} MB)...")

    # Compose the file_url for Printful API
    asset_base = os.getenv("SOLAR_ARCHIVE_ASSET_BASE_URL", "http://127.0.0.1:8000")
    # Ensure a single trailing slash and append /asset/ if not already present
    if not asset_base.rstrip("/").endswith("asset"):
        asset_base = asset_base.rstrip("/") + "/asset/"
    else:
        asset_base = asset_base.rstrip("/") + "/"
    file_url = f"{asset_base}{os.path.basename(image_path)}"
    log_to_queue(f"[upload][debug] Using asset_base={asset_base}")
    log_to_queue(f"[upload][debug] Final file_url={file_url}")
    # Use correct JSON keys for Printful upload
    json_data = {
        "url": file_url,
        "filename": title,
        "type": normalized_purpose
    }
    log_to_queue("[upload][debug] Using JSON upload (url/type/filename)")
    headers = {
        "Authorization": f"Bearer {PRINTFUL_API_KEY}",
        "Content-Type": "application/json"
    }
    log_to_queue(f"[upload][debug] Uploading via JSON url={file_url}")
    log_to_queue(f"[upload][debug] Full upload URL = {PRINTFUL_BASE_URL}/files")
    log_to_queue(f"[upload][debug] Using PRINTFUL_BASE_URL={PRINTFUL_BASE_URL}")
    r = requests.post(
        f"{PRINTFUL_BASE_URL}/files",
        headers=headers,
        json=json_data,
        timeout=90
    )
    end_time = time.time()
    log_to_queue(f"[upload] Printful upload completed in {end_time - start_time:.2f}s")
    try:
        result = r.json()
    except ValueError:
        result = json.loads(r.text)
    log_to_queue(str(result))
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
    log_to_queue(f"[printful][order] Using external_id={safe_external_id}")
    log_to_queue(f"[printful][order] Creating manual order for file_id={file_id}, title={title}")
    r = requests.post(f"{PRINTFUL_BASE_URL}/orders", headers=headers, json=payload)
    log_to_queue(f"[printful][order] {PRINTFUL_BASE_URL}/orders")
    try:
        result = r.json()
    except Exception:
        result = {"error": r.text}
    if r.status_code >= 300:
        log_to_queue(f"[printful][order][error] Order creation failed: {r.status_code} {r.text}")
        raise HTTPException(status_code=r.status_code, detail=f"Order creation failed: {r.text}")
    order_id = result.get("result", {}).get("id") or result.get("id")
    log_to_queue(f"[printful][order] Order created with ID: {order_id}")
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
    Quickly fetch a single FITS file for a mission/date/wavelength, downsampled for preview.
    Used for instant Shopify preview thumbnails.
    """
    from sunpy.net import Fido, attrs as a
    from astropy import units as u
    from sunpy.map import Map
    from astropy.nddata import block_reduce
    from datetime import datetime, timedelta
    import numpy as np
    import os

    dt = datetime.strptime(date_str, "%Y-%m-%d")
    t0 = dt
    t1 = dt + timedelta(seconds=12)

    # Use a very narrow search window for speed
    if mission.upper() == "SDO":
        wl = wavelength * u.angstrom
        log_to_queue(f"[preview] Quicklook fetch for SDO/AIA {wl}")
        qr = Fido.search(a.Time(t0, t1), a.Instrument("AIA"), a.Wavelength(wl))
    elif mission.upper() == "SOHO-EIT":
        wl = wavelength * u.angstrom
        log_to_queue(f"[preview] Quicklook fetch for SOHO/EIT {wl}")
        qr = Fido.search(a.Time(t0, t1), a.Instrument("EIT"), a.Wavelength(wl))
    elif mission.upper() == "SOHO-LASCO":
        log_to_queue(f"[preview] Quicklook fetch for SOHO/LASCO")
        qr = Fido.search(a.Time(t0, t1), a.Instrument("LASCO"))
    else:
        raise HTTPException(status_code=400, detail=f"Unknown mission: {mission}")

    if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
        raise HTTPException(status_code=404, detail=f"No quicklook data found for {mission} {date_str}")

    # Fetch only one file for speed
    files = Fido.fetch(qr[0, 0], progress=True)
    if not files or len(files) == 0:
        raise HTTPException(status_code=502, detail="Quicklook fetch failed")

    log_to_queue(f"[preview] Quicklook file: {files[0]}")

    # Downsample the FITS for preview (halve resolution in each axis, i.e., factor 8)
    try:
        m = Map(files[0])
        log_to_queue(f"[preview] Reducing FITS preview resolution by 4x for speed...")
        reduced_data = block_reduce(m.data.astype(np.float32), (4,4), func=np.nanmean)
        header = m.fits_header.copy()
        header['CRPIX1'] = header.get('CRPIX1', 0) / 4
        header['CRPIX2'] = header.get('CRPIX2', 0) / 4
        header['CDELT1'] = header.get('CDELT1', 1) * 4
        header['CDELT2'] = header.get('CDELT2', 1) * 4
        smap_small = Map(reduced_data, header)
        # Save to temp file for preview pipeline
        out_dir = "/tmp/output"
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(
            out_dir,
            f"preview_reduced_{mission}_{wavelength}_{date_str}.fits"
        )
        smap_small.save(out_path, filetype='fits', overwrite=True)
        log_to_queue(f"[preview] Reduced FITS saved to {out_path}")
        return out_path
    except Exception as e:
        log_to_queue(f"[preview] FITS reduction failed: {e}, returning original file")
        return files[0]


# ──────────────────────────────────────────────────────────────────────────────
# Helioviewer JPEG2000 Preview Helper
# ──────────────────────────────────────────────────────────────────────────────



@app.post("/shopify/preview")
async def shopify_preview(req: PreviewRequest):
    date_str = req.date
    wavelength = int(req.wavelength or int(DEFAULT_AIA_WAVELENGTH.value))
    # choose mission automatically if not provided
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    mission = (req.mission or choose_mission(dt)).upper()
    log_to_queue(f"[preview] Using JSOC/Fido quicklook for {mission} {wavelength}Å on {date_str}")
    try:
        # 1) Fetch a quicklook FITS via Fido/JSOC
        fits_path = fetch_quicklook_fits(mission, date_str, wavelength)
        # 2) Build a SunPy Map, with light prep for AIA
        smap = Map(fits_path)
        try:
            if "AIA" in (smap.meta.get("instrume","") + smap.meta.get("instrument","")).upper():
                smap = manual_aiaprep(smap)
        except Exception as e:
            log_to_queue(f"[preview] manual_aiaprep failed: {e}; proceeding without.")
        # 3) Render a small preview PNG
        fname = f"preview_{mission}_{wavelength}_{dt.strftime('%Y-%m-%d')}.png".replace(' ', '_').replace('/', '-')
        out_png = os.path.join(OUTPUT_DIR, fname)
        map_to_png(smap, out_png, annotate=False, dpi=150, size_inches=6.0, dolog=False)
        # 4) Build asset URL
        base = ASSET_BASE_URL.rstrip('/')
        if not base.endswith('asset'):
            preview_url = f"{base}/asset/{os.path.basename(out_png)}"
        else:
            preview_url = f"{base}/{os.path.basename(out_png)}"
        log_to_queue(f"[preview] Using JSOC/Fido preview path: {out_png}")
        return {"preview_url": preview_url}
    except HTTPException:
        raise
    except Exception as e:
        log_to_queue(f"[preview] Error creating preview: {e}")
        raise HTTPException(status_code=500, detail=f"Preview failed: {e}")

# ──────────────────────────────────────────────────────────────────────────────
# HQ PNG Generation Endpoint
# ──────────────────────────────────────────────────────────────────────────────


# Background HQ render function for /generate
async def run_hq_render(task_id, req: GenerateRequest):
    date_str = req.date
    wavelength = int(req.wavelength or int(DEFAULT_AIA_WAVELENGTH.value))
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        mission = (req.mission or choose_mission(dt)).upper()
        log_to_queue(f"[generate][task:{task_id}] Starting HQ render for {mission} {wavelength}Å on {date_str}")
        task_registry[task_id] = {"status": "fetching", "progress": "Fetching FITS data", "result": None}
        # Fetch full-resolution FITS from JSOC/Fido
        smap = await asyncio.to_thread(fido_fetch_map, dt, mission, wavelength, req.detector)
        task_registry[task_id] = {"status": "filtering", "progress": "Applying filter", "result": None}
        # Apply the full-quality RHEF filter (no downsampling)
        filtered = await asyncio.to_thread(default_filter, smap)
        log_to_queue(f"[generate][task:{task_id}] Using native resolution: {filtered.data.shape}")
        # Output file path
        fname = f"hq_{mission}_{wavelength}_{dt.strftime('%Y-%m-%d')}.png".replace(' ', '_').replace('/', '-')
        out_png = os.path.join(OUTPUT_DIR, fname)
        task_registry[task_id] = {"status": "rendering", "progress": "Rendering PNG", "result": None}
        # Save HQ PNG at full 4K equivalent resolution (13.6 inches * 300 dpi ≈ 4080 px)
        await asyncio.to_thread(
            map_to_png,
            filtered,
            out_png,
            req.annotate,
            300,
            13.6,
            False
        )
        base = ASSET_BASE_URL.rstrip('/')
        if not base.endswith('asset'):
            png_url = f"{base}/asset/{os.path.basename(out_png)}"
        else:
            png_url = f"{base}/{os.path.basename(out_png)}"
        log_to_queue(f"[generate][task:{task_id}] HQ proof generated at full resolution: {out_png}")
        log_to_queue(f"[generate][task:{task_id}] HQ proof generated at full resolution: {png_url}")
        task_registry[task_id] = {
            "status": "done",
            "progress": "Completed",
            "result": {"png_url": png_url},
        }
    except Exception as e:
        import traceback
        log_to_queue(f"[generate][task:{task_id}] Error: {e}")
        traceback.print_exc()
        task_registry[task_id] = {
            "status": "error",
            "progress": "Failed",
            "result": {"error": str(e)},
        }


# Robust /generate endpoint for polling tasks
@app.post("/generate")
async def generate(req: GenerateRequest):
    # Generate a unique task ID
    task_id = str(uuid.uuid4())
    # Register initial state
    task_registry[task_id] = {"state": "queued", "progress": "Queued for processing", "result": None}
    # Launch background render
    asyncio.create_task(run_hq_render(task_id, req))
    return {"task_id": task_id, "state": "queued"}

# Polling endpoint for task status/result
@app.get("/status/{task_id}")
async def get_task_status(task_id: str):
    """Return the current state of a given HQ render task."""
    task = task_registry.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Not Found")
    # Normalize output fields for frontend consistency
    state = task.get("status") or task.get("state", "unknown")
    progress = task.get("progress", "")
    result = task.get("result", {})
    png_url = None
    if isinstance(result, dict):
        png_url = result.get("png_url")
    return {
        "task_id": task_id,
        "state": state,
        "progress": progress,
        "png_url": png_url
    }

# @app.head("/")
# async def head_root():
#     return Response(status_code=200)