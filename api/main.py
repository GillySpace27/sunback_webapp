import ssl
import aiohttp
import certifi
from parfive import Downloader
import os

def _is_nasa_url(url: str) -> bool:
    return any(host in url for host in ("nascom.nasa.gov", "sdo.nascom.nasa.gov", "sdo5.nascom.nasa.gov"))

def get_downloader():
    """Return a Downloader with NASA SSL context applied via aiohttp connector."""
    ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE", certifi.where()))
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    connector = aiohttp.TCPConnector(ssl=ctx)
    return Downloader(max_conn=11, progress=True, connector=connector)

# Registry to track background tasks for /generate
task_registry: dict = {}
from urllib.parse import urlencode, quote_plus
import sys
from dotenv import load_dotenv
# Load environment variables from ../.env (backend startup)
load_dotenv(os.path.join(os.path.dirname(__file__), "../.env"))
os.environ["PYTHONUNBUFFERED"] = "1"
try:
    sys.stdout.reconfigure(write_through=True)
    sys.stderr.reconfigure(write_through=True)
except Exception:
    pass
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
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse, RedirectResponse
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
from fastapi import Body
from fastapi.responses import StreamingResponse
from tqdm import tqdm

# sunback/webapp/api/main.py
# FastAPI backend for Solar Archive — date→FITS via SunPy→filtered PNG→(optional) Printful upload

class PreviewRequest(BaseModel):
    date: str
    wavelength: int
    mission: str | None = "SDO"
    annotate: bool | None = False


# Global CORS headers for asset endpoints etc.
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
}

# SSL/certifi/NASA CA bundle setup — standalone chain, no in-place certifi patching
import certifi
import ssl
import tempfile

def ensure_nasa_cert():
    """
    Attempt to fetch and save the NASA intermediate certificate(s) as PEM files in ./certs.
    Does NOT append to certifi's bundle.
    """
    import ssl, socket
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend

    host = "sdo7.nascom.nasa.gov"
    port = 443
    try:
        ctx = ssl._create_unverified_context()
        conn = ctx.wrap_socket(socket.socket(socket.AF_INET), server_hostname=host)
        conn.settimeout(10)
        conn.connect((host, port))
        der_cert = conn.getpeercert(True)
        pem = ssl.DER_cert_to_PEM_cert(der_cert)
        conn.close()

        pem_dir = os.path.join(os.path.dirname(__file__), "certs")
        os.makedirs(pem_dir, exist_ok=True)
        pem_path = os.path.join(pem_dir, "auto_appended.pem")
        with open(pem_path, "w") as f:
            f.write(pem)
        print(f"[startup] Fetched live NASA cert chain -> {pem_path}", flush=True)
    except ssl.SSLError as e:
        print(f"[startup][skip] NASA cert SSL handshake failed ({e}); continuing without.", flush=True)
    except Exception as e:
        print(f"[startup][skip] NASA cert fetch skipped ({e})", flush=True)


# Helper: Build a standalone NASA CA chain by concatenating certifi cacert.pem + any NASA PEMs in ./certs
def _build_nasa_chain():
    import shutil
    bundle_path = certifi.where()
    certs_dir = os.path.join(os.path.dirname(__file__), "certs")
    # Create a temp file for the merged bundle
    fd, merged_path = tempfile.mkstemp(prefix="nasa_ca_bundle_", suffix=".pem")
    os.close(fd)
    # Start with certifi bundle
    with open(bundle_path, "rb") as src, open(merged_path, "wb") as dst:
        shutil.copyfileobj(src, dst)
        # Append each .pem in ./certs (if any)
        if os.path.isdir(certs_dir):
            for name in sorted(os.listdir(certs_dir)):
                if name.lower().endswith(".pem"):
                    pem_path = os.path.join(certs_dir, name)
                    try:
                        with open(pem_path, "rb") as pemf:
                            dst.write(b"\n")
                            dst.write(pemf.read())
                            dst.write(b"\n")
                    except Exception as e:
                        print(f"[startup][warn] Could not append NASA PEM {pem_path}: {e}", flush=True)
    return merged_path

# --- New startup sequence: ensure NASA cert, build merged CA bundle, set env vars, and set SSL context ---
ensure_nasa_cert()
NASA_CA_BUNDLE = _build_nasa_chain()
os.environ["SSL_CERT_FILE"] = NASA_CA_BUNDLE
os.environ["REQUESTS_CA_BUNDLE"] = NASA_CA_BUNDLE
ssl._create_default_https_context = ssl._create_unverified_context
print(f"[startup] Using standalone NASA_CA_BUNDLE: {NASA_CA_BUNDLE}", flush=True)



# Use /tmp/output as the root for all temp/config/download dirs, regardless of environment
base_tmp = "/tmp/output"
os.environ["SUNPY_CONFIGDIR"] = os.path.join(base_tmp, "config")
os.environ["SUNPY_DOWNLOADDIR"] = os.path.join(base_tmp, "data")
os.environ["VSO_URL"] = "http://vso.stanford.edu/cgi-bin/VSO_GETDATA.cgi"

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


# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────
APP_NAME = "Solar Archive Backend"
OUTPUT_DIR = os.getenv("SOLAR_ARCHIVE_OUTPUT_DIR", base_tmp)

# Preview subdirectory for all preview-related output
PREVIEW_DIR = os.path.join(OUTPUT_DIR, "preview")
os.makedirs(PREVIEW_DIR, exist_ok=True)

if os.getenv("RENDER"):
    os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = "https://solar-archive.onrender.com/"
else:
    os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = "http://127.0.0.1:8000/asset/"

ASSET_BASE_URL = os.getenv("SOLAR_ARCHIVE_ASSET_BASE_URL", "")  # e.g., CDN base; else empty for local
print(f"{ASSET_BASE_URL = }")
print(f"{OUTPUT_DIR = }")
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(PREVIEW_DIR, exist_ok=True)

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



# ──────────────────────────────────────────────────────────────────────────────
# FastAPI app
# ──────────────────────────────────────────────────────────────────────────────

from fastapi.middleware.cors import CORSMiddleware
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import sys
import threading

app = FastAPI(title=APP_NAME)


from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse


from fastapi.staticfiles import StaticFiles
# Serve all static files (HTML, JS, CSS) from /api/
app.mount("/api/static", StaticFiles(directory="api"), name="static")

from fastapi.responses import FileResponse
# Main asset mount: serves HQ/full-res images from OUTPUT_DIR (not including preview subdir)
app.mount("/asset", StaticFiles(directory=OUTPUT_DIR), name="asset")
# New: serve preview images from the preview subfolder
app.mount("/asset/preview", StaticFiles(directory=PREVIEW_DIR), name="asset_preview")

@app.get("/api/frontend.html")
async def serve_frontend():
    """Serve the frontend.html page."""
    return FileResponse(os.path.join("api", "frontend.html"))


# ---------------------------------------------------------
# CORS CONFIGURATION — fixes Shopify ↔ Render cross-origin
# ---------------------------------------------------------
from fastapi.middleware.cors import CORSMiddleware

# Define allowed origins explicitly
# allowed_origins = [
#     "https://solar-archive.myshopify.com",
#     "https://solar-archive.onrender.com",
#     "https://poe.com",
#     "https://app.poe.com",
#     "https://preview.poe.com",
#     "https://pfst.cf2.poecdn.net",
#     "https://qph.cf2.poecdn.net",
#     "http://127.0.0.1:8000",
#     "http://localhost:8000",
# ]

# Remove any old middleware before re-adding
# (avoids duplicate middleware layers if app reloads)
for i, middleware in enumerate(app.user_middleware):
    if middleware.cls.__name__ == "CORSMiddleware":
        app.user_middleware.pop(i)
        break

# Add updated CORS policy
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # Allow any origin (Poe, Shopify, etc.)
    allow_credentials=False,       # Must be False when using wildcard
    allow_methods=["*"],
    allow_headers=["*"],
)

# ──────────────────────────────────────────────────────────────────────────────
# /api/generate_preview — fast preview: single FITS, log10, color, no filtering
# ──────────────────────────────────────────────────────────────────────────────
from fastapi import Body

# Helper: fetch the first FITS file for preview, using same SSL and downloader as do_generate_sync
def fetch_first_fits(dt, wl):
    """
    Download only the first FITS file for the given date and wavelength using NASA SSL setup.
    Returns the path to the downloaded FITS file.
    """
    # Ensure SSL environment and NASA certificates before VSO calls
    try:
        from api.main import ensure_nasa_cert
        ensure_nasa_cert()
    except Exception as e:
        print(f"[fetch_first_fits][warn] Could not re-ensure NASA certs: {e}", flush=True)
    import certifi
    os.environ["SSL_CERT_FILE"] = os.getenv("SSL_CERT_FILE", NASA_CA_BUNDLE)
    os.environ["REQUESTS_CA_BUNDLE"] = os.getenv("REQUESTS_CA_BUNDLE", NASA_CA_BUNDLE)
    os.environ["VSO_URL"] = "https://vso.stanford.edu/cgi-bin/VSO_GETDATA.cgi"
    print(f"[fetch_first_fits] Using SSL_CERT_FILE={os.environ['SSL_CERT_FILE']}", flush=True)
    print(f"[fetch_first_fits] Using VSO_URL={os.environ['VSO_URL']}", flush=True)
    from sunpy.net import Fido, attrs as a
    import astropy.units as u
    from sunpy.net.vso import VSOClient
    from parfive import Downloader
    # Enforce HTTPS for VSO URL
    client = VSOClient()
    qr = client.search(
        a.Time(dt, dt + timedelta(minutes=1)),
        a.Detector("AIA"),
        a.Wavelength(wl * u.angstrom),
        a.Source("SDO"),
    )
    if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
        raise HTTPException(status_code=502, detail="No VSO AIA data for this date/wavelength")
    target_dir = os.environ.get("SUNPY_DOWNLOADDIR", OUTPUT_DIR)
    dl = get_downloader()
    files = Fido.fetch(qr[0], downloader=dl, path=target_dir)
    if not files or len(files) == 0:
        raise HTTPException(status_code=502, detail="VSO AIA fetch returned no files")
    return str(files[0])


@app.post("/api/generate_preview")
async def generate_preview(req: PreviewRequest = Body(...)):
    """
    Fast preview: fetch only first FITS, downsample, apply RHEF, color, PNG.
    Returns: {"preview_url": "/asset/preview/preview_SDO_<wl>_<date>.png"}
    """
    try:
        # Parse date/wavelength
        dt = datetime.strptime(req.date, "%Y-%m-%d")
        wl = int(req.wavelength)
        date_str = dt.strftime("%Y%m%d")
        out_path = os.path.join(PREVIEW_DIR, f"preview_SDO_{wl}_{date_str}.png")
        url_path = f"/asset/preview/preview_SDO_{wl}_{date_str}.png"
        # If already exists, return immediately
        if os.path.exists(out_path):
            return {"preview_url": url_path}

        # --- Custom Fido.fetch: use downloader with verify_ssl=False ---
        from sunpy.net import Fido, attrs as a
        from parfive import Downloader
        from sunpy.net.vso import VSOClient
        import astropy.units as u
        from datetime import timedelta
        # Compose VSO query for first frame
        client = VSOClient()
        qr = client.search(
            a.Time(dt, dt + timedelta(minutes=1)),
            a.Detector("AIA"),
            a.Wavelength(wl * u.angstrom),
            a.Source("SDO"),
        )
        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            raise HTTPException(status_code=502, detail="No VSO AIA data for this date/wavelength")
        download_dir = os.environ.get("SUNPY_DOWNLOADDIR", OUTPUT_DIR)
        # Create downloader with SSL validation bypassed
        def make_downloader_for(url, verify_ssl=True):
            from parfive import Downloader
            import ssl
            if _is_nasa_url(url):
                if not verify_ssl:
                    ctx = ssl.create_default_context()
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                    import ssl as _ssl_mod
                    _ssl_mod._create_default_https_context = lambda: ctx
                    return Downloader(max_conn=15)
                else:
                    return Downloader(max_conn=15)
            return Downloader(max_conn=15)
        downloader = make_downloader_for("https://sdo5.nascom.nasa.gov", verify_ssl=False)
        log_to_queue("[generate_preview] Using same downloader as main generator")
        # Fetch with downloader
        result = Fido.fetch(qr[0], path=download_dir, downloader=downloader)
        if not result or len(result) == 0:
            raise HTTPException(status_code=502, detail="VSO AIA fetch returned no files")
        fits_path = str(result[0])

        # Load Map, then downsample, apply RHEF, color
        from sunpy.map import Map
        import numpy as np
        import matplotlib.pyplot as plt
        # Import block_reduce only here
        from skimage.measure import block_reduce
        smap = Map(fits_path)
        # Downsample to ~512x512 using block_reduce (nanmean)
        data = np.array(smap.data, dtype=np.float32)
        data[data <= 0] = np.nan
        h, w = data.shape
        block_size = max(1, int(np.ceil(h / 512)))
        reduced = block_reduce(data, block_size=(block_size, block_size), func=np.nanmean)
        # Rebuild Map with reduced data and original metadata (approximate WCS)
        from sunpy.map.sources.sdo import AIAMap
        from sunpy.util.metadata import MetaDict
        meta = MetaDict(smap.meta.copy())
        # Adjust pixel size (cdelt1/cdelt2) if present
        if "cdelt1" in meta and "cdelt2" in meta:
            meta["cdelt1"] = meta["cdelt1"] * block_size
            meta["cdelt2"] = meta["cdelt2"] * block_size
            meta["crpix1"] = meta["crpix1"] / block_size
            meta["crpix2"] = meta["crpix2"] / block_size
        # Optionally adjust NAXIS1/2
        meta["naxis1"] = reduced.shape[1]
        meta["naxis2"] = reduced.shape[0]
        # Build as AIAMap to preserve correct subclass and WCS
        smap_reduced = AIAMap(reduced, meta)
        from sunkit_image import radial
        # Apply RHEF with fallback
        try:
            rhef_data = radial.rhef(smap_reduced, progress=True).data
        except Exception:
            log_to_queue("[rhef][warn] Preview RHEF failed on Map — using array fallback.")
            rhef_data = radial.rhef(smap_reduced.data, progress=True).data
        # Save PNG with color table
        cmap = plt.get_cmap(f"sdoaia{wl}")
        vmin = np.nanpercentile(rhef_data, 1)
        vmax = np.nanpercentile(rhef_data, 99.7)
        plt.figure(figsize=(8,8), dpi=100)
        plt.axis("off")
        plt.imshow(rhef_data, cmap=cmap, vmin=vmin, vmax=vmax, origin="lower")
        plt.tight_layout(pad=0)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        plt.savefig(out_path, bbox_inches="tight", pad_inches=0)
        plt.close()
        # Ensure file is written and visible before returning
        import time
        for _ in range(50):
            if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
                break
            time.sleep(0.05)
        return {"preview_url": url_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Preview failed: {e}")



from api import printful_routes
app.include_router(printful_routes.router, prefix="/api")

# --- Asynchronous HQ generation endpoints ---
from fastapi import BackgroundTasks, HTTPException, APIRouter
import uuid, asyncio

import threading
# Simple in-memory task registry
tasks = {}
# Thread lock for status updates
status_lock = threading.Lock()

async def run_generation_task(task_id: str, date: str, wavelength: str, mission: str, detector: str):
    """
    Actual HQ generation logic for async background task.
    """
    try:
        with status_lock:
            tasks[task_id] = {"status": "started", "message": "HQ generation started"}
            log_to_queue(f"[hq-task][{task_id}] Status: started")
        # Convert date/wavelength types
        dt = datetime.strptime(date, "%Y-%m-%d")
        wl = int(wavelength)
        # Run HQ generation in a thread to avoid blocking event loop
        png_url = await asyncio.to_thread(do_generate_sync, dt, wl, mission, detector)
        # Check PNG existence
        png_path = os.path.join(OUTPUT_DIR, os.path.basename(png_url.lstrip("/")))
        if os.path.exists(png_path) and os.path.getsize(png_path) > 1000:
            with status_lock:
                tasks[task_id] = {
                    "status": "completed",
                    "message": "HQ image ready",
                    "image_url": png_url
                }
                log_to_queue(f"[hq-task][{task_id}] Status: completed (HQ image ready at {png_url})")
        else:
            with status_lock:
                tasks[task_id] = {
                    "status": "completed",
                    "message": "HQ generation completed (PNG reused from cache or already available)",
                    "image_url": png_url
                }
                log_to_queue(f"[hq-task][{task_id}] Status: completed (HQ PNG reused/cached at {png_url})")
    except Exception as e:
        with status_lock:
            tasks[task_id] = {"status": "failed", "message": str(e)}
            log_to_queue(f"[hq-task][{task_id}] Status: failed ({e})")


# Helper: HQ generation, sync version for to_thread usage
def do_generate_sync(date: datetime, wavelength: int, mission: str, detector: str):
    """
    Generate a HQ PNG using the full RHEF pipeline, caching result if already exists.
    Returns the /asset/... URL path to the PNG.
    """
    # Reassert SSL/NASA cert configuration inside thread
    import ssl, certifi
    os.environ["SSL_CERT_FILE"] = os.getenv("SSL_CERT_FILE", certifi.where())
    os.environ["REQUESTS_CA_BUNDLE"] = os.getenv("REQUESTS_CA_BUNDLE", certifi.where())
    ssl._create_default_https_context = ssl._create_unverified_context
    # Compose output PNG path and URL
    date_str = date.strftime("%Y%m%d")
    out_name = f"hq_{mission}_{wavelength}_{date_str}.png"
    out_path = os.path.join(OUTPUT_DIR, out_name)
    url_path = f"/asset/{out_name}"
    # If already exists and is non-empty, return its URL (cached)
    if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
        log_to_queue(f"[do_generate_sync] PNG already exists, using cached: {out_path}")
        return url_path
    # Fetch and process HQ map
    log_to_queue(f"[do_generate_sync] Generating HQ PNG: {out_path}")
    smap = fido_fetch_map(date, mission, wavelength, detector)
    # Apply RHEF filter at full resolution
    try:
        rhef_map = rhef(smap, progress=True)
        data = rhef_map.data
    except Exception as e:
        log_to_queue(f"[do_generate_sync][warn] RHEF failed on Map, falling back to array: {e}")
        data = rhef(smap.data, progress=True).data
    # Colorize and save PNG
    import matplotlib.pyplot as plt
    import numpy as np
    cmap_name = f"sdoaia{wavelength}"
    try:
        cmap = plt.get_cmap(cmap_name)
    except Exception:
        cmap = plt.get_cmap("gray")
    vmin = np.nanpercentile(data, 1)
    vmax = np.nanpercentile(data, 99.7)
    plt.figure(figsize=(10, 10), dpi=300)
    plt.axis("off")
    plt.imshow(data, cmap=cmap, vmin=vmin, vmax=vmax, origin="lower")
    plt.tight_layout(pad=0)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, bbox_inches="tight", pad_inches=0)
    plt.close()
    # Ensure PNG is written and visible
    import time
    for _ in range(50):
        if os.path.exists(out_path) and os.path.getsize(out_path) > 1000:
            break
        time.sleep(0.05)
    log_to_queue(f"[do_generate_sync] HQ PNG written: {out_path}")
    return url_path

@app.post("/api/generate")
async def start_generate(background_tasks: BackgroundTasks, payload: dict):
    """Start the HQ generation task asynchronously and return a task_id."""
    date = payload.get("date")
    wavelength = payload.get("wavelength")
    mission = payload.get("mission", "SDO")
    detector = payload.get("detector", "AIA")
    if not date or not wavelength:
        raise HTTPException(status_code=400, detail="Missing date or wavelength")
    task_id = str(uuid.uuid4())
    with status_lock:
        tasks[task_id] = {"status": "queued", "message": "HQ generation queued"}
    background_tasks.add_task(run_generation_task, task_id, date, wavelength, mission, detector)
    return {"task_id": task_id, "status_url": f"/api/status/{task_id}"}

@app.get("/api/status/{task_id}")
async def get_status(task_id: str):
    """Poll generation task status."""
    with status_lock:
        task_status = tasks.get(task_id, {"status": "unknown", "message": "No such task"})
    return JSONResponse(content=task_status)




# Serve /api/frontend.html and other frontend assets
# app.mount("/api", StaticFiles(directory="/Users/cgilbert/vscode/sunback/webapp/api"), name="api")

from pathlib import Path
app_dir = Path(__file__).parent
# app.mount("/api", StaticFiles(directory=app_dir, html=True), name="api")
app.mount("/static", StaticFiles(directory=app_dir, html=True), name="static")



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
@app.post("/api/clear_cache")
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
                <button id="printful-btn" class="action-btn">Upload to Printful</button>
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
            const printfulBtn = document.getElementById('printful-btn');
            printfulBtn.style.display = "none";
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
                printfulBtn.style.display = "none";
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
                        printfulBtn.style.display = "inline-block";
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
            printfulBtn.addEventListener('click', async () => {
              if (!lastImageUrl) {
                alert("No image to upload.");
                return;
              }
              printfulBtn.disabled = true;
              printfulBtn.textContent = "Uploading...";
              try {
                const payload = { image_path: lastImageUrl.split('/').pop(), title: "Solar Archive Image" };
                const res = await fetch('/upload_to_printful', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify(payload)
                });
                const result = await res.json();
                if (res.ok) {
                  alert("Upload successful! File ID: " + (result.file_id || "unknown"));
                } else {
                  alert("Upload failed: " + result.detail);
                }
              } catch (err) {
                alert("Error uploading to Printful: " + err);
              }
              printfulBtn.disabled = false;
              printfulBtn.textContent = "Upload to Printful";
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
    """Redirect root URL to hosted frontend page."""
    return RedirectResponse(url="https://solar-archive.onrender.com/api/frontend.html", status_code=302)


# Serve the original cute Solar Archive landing page at /api
@app.get("/api", response_class=HTMLResponse)
async def api_root():
    """Serve the original cute Solar Archive landing page at /api."""
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
    # try:
    #     client.registry.load()
    # except Exception as e:
    #     print(f"[debug_vso] Registry load exception: {e}", flush=True)

    try:
        qr = client.search(
            a.Time("2019-06-01T00:00:00", "2019-06-01T00:00:12"),
            a.Detector("AIA"),
            a.Wavelength(171 * u.angstrom),
            a.Source("SDO"),
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


# --- Inserted endpoint: /debug/vso_download_test ---
@app.get("/debug/vso_download_test")
def debug_vso_download_test():
    """
    Attempts to download a small file from VSO (using the same query as /debug/vso).
    Returns success if a file is downloaded to the temp directory.
    """
    from sunpy.net.vso import VSOClient
    from sunpy.net import attrs as a
    from astropy import units as u
    from parfive import Downloader



    # Enforce HTTPS for VSO URL
    os.environ["VSO_URL"] = "https://vso.stanford.edu/cgi-bin/VSO_GETDATA.cgi"
    client = VSOClient()
    try:
        qr = client.search(
            a.Time("2019-06-01T00:00:00", "2019-06-01T00:02:00"),
            a.Detector("AIA"),
            a.Wavelength(171 * u.angstrom),
            a.Source("SDO"),
        )
        if len(qr) == 0:
            raise HTTPException(status_code=404, detail="No results found for VSO test query.")
        dl = get_downloader()
        target_dir = os.environ.get("SUNPY_DOWNLOADDIR", "/tmp/output/data")
        files = client.fetch(qr, path=target_dir, downloader=dl)
        if files and len(files) > 0 and os.path.exists(str(files[0])):
            return {"status": "success", "file": str(files[0])}
        else:
            raise HTTPException(status_code=502, detail="VSO fetch returned no files or file missing.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"VSO download test failed: {e}")





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
# /api/generate — HQ render: use combined cache if exists, else fetch; apply RHEF, save PNG, return URL
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

@app.get("/debug/list_output")
async def list_output():
    from pathlib import Path
    root = Path(OUTPUT_DIR)
    files = sorted([str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()])
    return {"output_dir": OUTPUT_DIR, "files": files}

# --- Safe aiapy calibration import (handles version differences gracefully) ---
try:
    from aiapy.calibrate import register, update_pointing, correct_degradation, get_pointing_table
except ImportError:
    from aiapy.calibrate import register, update_pointing, correct_degradation
    try:
        from aiapy.calibrate.util import get_correction_table as get_pointing_table
    except ImportError:
        get_pointing_table = None

def normalize_exposure(m):
    """
    Safe fallback for exposure normalization.
    Divides by 'exptime' if present in metadata.
    """
    import astropy.units as u
    from sunpy.map import Map
    try:
        exptime = m.meta.get("exptime") or m.meta.get("EXPTIME")
        if exptime:
            data = m.data / float(exptime)
            return Map(data, m.meta)
    except Exception as e:
        print(f"[aiapy][warn] normalize_exposure fallback failed: {e}")
    return m

def manual_aiaprep(m, logger=print):
    """
    Modern aiapy-based AIA calibration pipeline using the current aiapy interface:
      - Retrieves pointing table from JSOC (±12h window) via aiapy.calibrate.get_pointing_table
      - Updates pointing metadata (if possible)
      - Registers image to a common reference frame
      - Normalizes exposure
    Handles missing get_pointing_table gracefully and logs any failures.
    """
    import astropy.units as u
    from datetime import timedelta
    from sunpy.map import Map

    # Use safe import block from above (get_pointing_table may be None)
    point = False

    if point:
        try:
            # Try pointing correction if possible
            if get_pointing_table is not None:
                try:
                    t0 = m.date - 12 * u.hour
                    t1 = m.date + 12 * u.hour
                    # logger(f"[fetch][AIA] Retrieving pointing table from JSOC for {t0}–{t1}...")
                    pointing_table = get_pointing_table("JSOC", m.date)
                    # logger(f"[fetch][AIA] Pointing table retrieved ({len(pointing_table)} entries).")
                    try:
                        m = update_pointing(m, pointing_table=pointing_table)
                        # logger("[fetch][AIA] Pointing metadata updated.")
                    except Exception as e:
                        # logger(f"[fetch][warn] AIA pointing correction skipped: {e}")
                        pass
                except Exception as e:
                    pass
                    # logger(f"[fetch][warn] AIA pointing correction skipped: {e}")
        except Exception as e:
            # logger(f"[fetch][warn] manual_aiaprep failed: {e}; returning unprocessed map.")
            return m

    else:
        # logger("[fetch][warn] AIA pointing correction skipped")
        pass

    # Continue with registration and degradation correction regardless of pointing success
    try:
        m = register(m)
        # logger("[fetch][AIA] Image registered to common scale and orientation.")
    except Exception as reg_err:
        # logger(f"[fetch][warn] aiapy register failed: {reg_err}")
        pass
    try:
        from aiapy.calibrate import get_correction_table
        corr_table = get_correction_table("aia", m.date)
        m = correct_degradation(m, correction_table=corr_table)
        # logger("[fetch][AIA] Degradation correction applied.")
    except Exception as corr_err:
        # logger(f"[fetch][warn] aiapy degradation correction failed: {corr_err}")
        pass

    m = normalize_exposure(m)
    # logger("[fetch][AIA] Exposure normalized successfully.")
    return m


def fido_fetch_map(dt: datetime, mission: str, wavelength: Optional[int], detector: Optional[str]) -> Map:
    """
    Retrieve a SunPy Map near the given date for the chosen mission.
    We search a small window around the date to find at least one file.
    For SDO/AIA, use VSO only.
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
            # Ensure combined_data and metadata are wrapped into a Map
            import numpy as np
            if isinstance(combined_data, np.ndarray):
                try:
                    combined_map = Map(combined_data, combined_meta)
                except Exception:
                    # fallback minimal header if meta missing
                    combined_map = Map(combined_data, {})
            else:
                combined_map = combined_data
            log_to_queue(f"[fetch] Returning combined map ({combined_meta['n_frames']} frames).")
            return combined_map

    if mission == "SDO":
        # Create a unique working directory for this date
        from pathlib import Path
        work_dir = Path(OUTPUT_DIR) / f"aia_{date_str}"
        work_dir.mkdir(parents=True, exist_ok=True)
        from sunpy.net import Fido, attrs as a
        import astropy.units as u
        wl = wavelength or int(DEFAULT_AIA_WAVELENGTH.value)
        log_to_queue(f"[fetch] Using VSO for AIA data ({wl}Å)")

        from sunpy.net import vso
        os.environ["VSO_URL"] = "https://vso.stanford.edu/cgi-bin/VSO_GETDATA.cgi"
        client = vso.VSOClient()
        try:
            nasa_ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE"))
            nasa_ctx.check_hostname = True
            nasa_ctx.verify_mode = ssl.CERT_REQUIRED
            connector = aiohttp.TCPConnector(ssl=nasa_ctx)
            dl = Downloader(max_conn=8, progress=True, connector=connector)
            log_to_queue("[fetch][AIA] Using custom Downloader with NASA SSL context (modern VSOClient).")
        except Exception as e:
            log_to_queue(f"[fetch][AIA][warn] Failed to create NASA SSL connector: {e}")
            dl = Downloader(max_conn=8, progress=True)

        # from sunpy.net.vso import VSOClient

        # Enforce HTTPS for VSO URL

        qr = client.search(
                a.Time(dt, dt + timedelta(minutes=2)),
                a.Detector("AIA"),
                a.Wavelength(wavelength * u.angstrom),
                a.Source("SDO"),
        )

        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            log_to_queue(f"[fetch] [AIA] No VSO results found in ±1min, retrying ±10min...")
            qr = Fido.search(
                a.Time(dt - timedelta(minutes=10), dt + timedelta(minutes=10)),
                a.Detector("AIA"), a.Provider("VSO"),
                a.Source("SDO"),
                a.Wavelength(wl * u.angstrom),
            )
        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            log_to_queue(f"[fetch] [AIA] No VSO results found in ±10min. No fallback available.")
            raise HTTPException(status_code=502, detail="No VSO data available for this date.")
        log_to_queue(f"[fetch] [AIA] VSO AIA data: {len(qr[0])} results...")
        # Download to work_dir using custom downloader
        files = Fido.fetch(qr, downloader=dl, path=str(work_dir))
        try:
            files = list(map(str, files))
        except Exception:
            files = list(files) if isinstance(files, (list, tuple)) else [str(files)]
        log_to_queue(f"[fetch] Retrieved {len(files)} AIA frames from VSO (existing files were skipped by the downloader if present).")
        if not files or len(files) == 0:
            log_to_queue(f"[fetch] [AIA] VSO fetch returned no files.")
            raise HTTPException(status_code=502, detail="No files from VSO AIA fetch.")

        # Restrict to only full-resolution level-1 science FITS files (exclude preview/quicklook)
        fits_files = sorted(work_dir.glob("*.fits"))
        fits_files = [str(f) for f in fits_files if "preview" not in str(f) and "quicklook" not in str(f) and "image_lev1" in str(f)]
        log_to_queue(f"[fetch][AIA] {len(fits_files)} full-res level-1 FITS found after filtering.")
        if not fits_files:
            log_to_queue("[fetch][AIA][warn] No full-res level-1 science FITS found after filtering.")
            raise HTTPException(status_code=502, detail="No full-res level-1 AIA FITS found.")
        # --- Memory-safe streaming AIA frame combination ---
        import numpy as np
        import gc
        from sunpy.map import Map
        n_frames = 0
        sum_exp = 0.0
        combined_data = None
        ref_shape = None
        ref_header = None
        combined_meta = None
        t_start = None
        t_end = None
        log_to_queue(f"[fetch][AIA] Streaming {len(fits_files)} FITS files for memory-safe combination...")
        for i, f in enumerate(tqdm(fits_files, desc="Prepping Files")):
            try:
                m = Map(f)
                try:
                    m_prep = manual_aiaprep(
                        m,
                        logger=lambda msg: log_to_queue(msg)
                    )
                except Exception as e:
                    log_to_queue(f"[fetch][warn] aiapy prep failed for {os.path.basename(f)}: {e}")
                    m_prep = m
                # On first valid frame, set reference shape and allocate accumulator
                if ref_shape is None:
                    ref_shape = m_prep.data.shape
                    if ref_shape[0] < 2000:
                        log_to_queue(f"[fetch][warn] Detected low-res reference map ({ref_shape}), will skip such frames.")
                    if ref_shape[0] < 2000:
                        # Don't use this frame, keep searching for a full-res frame
                        del m, m_prep
                        gc.collect()
                        continue
                    combined_data = np.zeros(ref_shape, dtype=np.float32)
                    ref_header = m_prep.meta.copy()
                    t_start = str(m_prep.date) if hasattr(m_prep, "date") else None
                    t_end = t_start
                    # Log memory usage
                    import psutil
                    mem = psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
                    log_to_queue(f"[fetch][AIA][mem] Allocated accumulator array, memory used: {mem:.1f} MB")
                # Only combine frames matching reference shape (full-res)
                if m_prep.data.shape != ref_shape:
                    log_to_queue(f"[fetch][warn] Skipping frame {i+1} ({os.path.basename(f)}), shape {m_prep.data.shape} != ref {ref_shape}")
                    del m, m_prep
                    gc.collect()
                    continue
                exptime = float(m_prep.meta.get("exptime", 1.0))
                if not np.isfinite(exptime) or exptime <= 0:
                    exptime = 1.0
                combined_data += m_prep.data.astype(np.float32) * exptime
                sum_exp += exptime
                n_frames += 1
                # Update t_end to last valid frame
                t_end = str(m_prep.date) if hasattr(m_prep, "date") else t_end
                log_to_queue(f"[fetch][AIA][progress] Processed frame {n_frames}: {os.path.basename(f)} (exp={exptime})")
                del m, m_prep
                gc.collect()
            except Exception as e:
                log_to_queue(f"[fetch][warn] Failed to process {os.path.basename(f)}: {e}")
                gc.collect()
                continue
        if n_frames == 0:
            raise RuntimeError("No full-resolution AIA frames loaded for combination.")
        # Weighted average
        combined_data = combined_data / max(sum_exp, 1e-8)
        # SNR diagnostics
        try:
            h, w = ref_shape
            x0, x1 = int(w // 2 - 128), int(w // 2 + 128)
            y0, y1 = int(h // 2 - 128), int(h // 2 + 128)
            # For single-frame SNR, reload the first file
            m_single = Map(fits_files[0])
            m_single_prep = manual_aiaprep(m_single, logger=lambda msg: None)
            sigma_single = float(np.nanstd(m_single_prep.data[y0:y1, x0:x1] / max(float(m_single_prep.meta.get("exptime", 1.0)), 1e-6)))
            sigma_comb = float(np.nanstd(combined_data[y0:y1, x0:x1]))
            snr_gain = (sigma_single / sigma_comb) if sigma_comb > 0 else float("nan")
            log_to_queue(f"[fetch][snr] Central patch σ_single/σ_combined = {sigma_single:.3g}/{sigma_comb:.3g} → gain ≈ {snr_gain:.2f}× (expected ~{np.sqrt(n_frames):.2f}×)")
            del m_single, m_single_prep
        except Exception as snr_err:
            log_to_queue(f"[fetch][snr][warn] Unable to compute SNR diagnostics: {snr_err}")
        # Compose combined metadata
        combined_meta = ref_header.copy() if ref_header else {}
        combined_meta["n_frames"] = n_frames
        if t_start:
            combined_meta["t_start"] = t_start
        if t_end:
            combined_meta["t_end"] = t_end
        # Save combined .npz to OUTPUT_DIR (not to work_dir!)
        date_str = dt.strftime("%Y%m%d")
        try:
            from astropy import units as _u
            wl_key = int((wavelength or int(DEFAULT_AIA_WAVELENGTH.value)))
        except Exception:
            wl_key = int(DEFAULT_AIA_WAVELENGTH.value)
        combined_cache_file = os.path.join(OUTPUT_DIR, f"temp_combined_{mission}_{wl_key}_{date_str}.npz")
        np.savez_compressed(combined_cache_file, data=combined_data, meta=combined_meta)
        import psutil
        mem = psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)
        log_to_queue(f"[cache] Saved combined map to {combined_cache_file}")
        log_to_queue(f"[fetch][AIA][mem] Final memory usage: {mem:.1f} MB")
        # Delete all FITS files in work_dir (but not .npz or .png)
        for f in fits_files:
            try:
                Path(f).unlink()
            except Exception:
                pass
        # del maps
        import gc
        gc.collect()
        log_to_queue(f"[fetch] Returning combined map ({combined_meta['n_frames']} frames).")
        # Always return a proper sunpy.map.Map object
        if isinstance(combined_data, np.ndarray):
            try:
                combined_map = Map(combined_data, combined_meta)
            except Exception:
                # fallback minimal header if meta missing
                combined_map = Map(combined_data, {})
        else:
            combined_map = combined_data
        return combined_map
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
            # from parfive import Downloader
            dl = get_downloader()
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
            dl = Downloader(max_conn=15, progress=False, overwrite=False  )
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
    import numpy as _np
    import time as _time
    from sunpy.map import Map as _SunpyMap
    from astropy.nddata import block_reduce as _block_reduce
    from astropy import units as _u

    # Local context manager: ensure tqdm carriage returns reach the SSE stream
    @contextlib.contextmanager
    def tqdm_stream_adapter():
        class _CR2NL:
            def __init__(self, stream):
                self._s = stream
            def write(self, data):
                data = data.replace("\r", "\n")
                self._s.write(data)
                self._s.flush()
            def flush(self):
                self._s.flush()
            def isatty(self):
                return False
        _orig_out, _orig_err = sys.stdout, sys.stderr
        adapter = _CR2NL(_orig_out)
        sys.stdout = adapter
        sys.stderr = adapter
        try:
            yield
        finally:
            sys.stdout = _orig_out
            sys.stderr = _orig_err

    t0 = _time.time()
    try:
        # ── 1) Prepare data safely for RHEF ────────────────────────────────────
        data = _np.array(smap.data, dtype=_np.float32, copy=True)
        # Mask obvious bads
        data[~_np.isfinite(data)] = _np.nan
        # Avoid negative / zeros that can destabilize ranks in deep background
        data[data <= 0] = _np.nan

        # Choose downsample factor (env override: RHEF_BLOCK=1/2/4)
        try:
            block_size = int(os.environ.get("RHEF_BLOCK", "2"))
            if block_size not in (1, 2, 4, 8):
                block_size = 2
        except Exception:
            block_size = 2

        # Skip downsample if already small
        H, W = data.shape[:2]
        if max(H, W) <= 2048:
            block_size = min(block_size, 1)

        # Copy meta so we don't mutate the original
        header = smap.meta.copy()

        if block_size > 1:
            log_to_queue(f"[render] Performing RHEF (downsample x{block_size})...")
            # Adjust WCS for reduced sampling
            for key in ("CRPIX1", "CRPIX2"):
                if key in header:
                    header[key] = header[key] / block_size
            for key in ("CDELT1", "CDELT2"):
                if key in header:
                    header[key] = header[key] * block_size
            # Reduce with NaN-aware average
            data = _block_reduce(data, (block_size, block_size), func=_np.nanmean)
        else:
            log_to_queue("[render] Performing RHEF at native sampling...")

        prep_map = _SunpyMap(data, header)

        # ── 2) Run RHEF ───────────────────────────────────────────────────────
        with tqdm_stream_adapter():
            t1 = _time.time()
            filtered = rhef(
                prep_map,
                progress=True,               # show tqdm into the SSE stream
                vignette=1.51 * _u.R_sun     # robust limb vignette
            )
            t2 = _time.time()
        # Ensure we always return a Map
        # from sunpy.map import Map
        if not isinstance(filtered, _SunpyMap):
            filtered = _SunpyMap(_np.asarray(filtered, dtype=_np.float32), header)

        # Clean any residual infs/nans
        arr = _np.array(filtered.data, dtype=_np.float32, copy=True)
        arr[~_np.isfinite(arr)] = _np.nan
        filtered = _SunpyMap(arr, filtered.meta)

        log_to_queue(f"[render] RHEF complete in {t2 - t1:.2f}s (total {t2 - t0:.2f}s); shape={arr.shape}")
        return filtered

    except Exception as e:
        # Detailed traceback to logs, but keep service alive with a graceful fallback
        import traceback
        log_to_queue("[render] RHEF filter failed with exception:")
        traceback.print_exc()
        log_to_queue(f"[render] RHEF failed ({e}); falling back to asinh stretch.")
        arr = _np.array(smap.data, dtype=_np.float32, copy=True)
        arr[~_np.isfinite(arr)] = _np.nan
        # Asinh stretch is robust to a wide dynamic range
        arr = _np.arcsinh(arr)
        fallback_map = _SunpyMap(arr, smap.meta.copy())
        try:
            fallback_map.meta["rhef_failed"] = True
        except Exception:
            pass
        return fallback_map

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




@app.get("/api/status")
async def status(job_id: Optional[str] = None):
    if job_id and job_id in task_registry:
        return task_registry[job_id]
    return {"status": "idle", "app": APP_NAME}

@app.get("/asset/{filename}")
def get_local_asset(filename: str):
    # Only works when ASSET_BASE_URL is empty (local dev)
    fp = os.path.join(OUTPUT_DIR, filename)
    if not os.path.exists(fp):
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(fp, media_type="image/png", headers=CORS_HEADERS)

def fetch_quicklook_fits(mission: str, date_str: str, wavelength: int):
    """
    Quickly fetch a single FITS file for a mission/date/wavelength using VSO only.
    This avoids JSOC timeouts on hosted servers like Render.
    Falls back to SOHO-EIT 195Å if SDO data is unavailable.
    """
    from sunpy.net.vso import VSOClient
    from sunpy.net import attrs as a
    from astropy import units as u
    from sunpy.map import Map
    from astropy.nddata import block_reduce
    from datetime import datetime, timedelta
    import numpy as np


    dt = datetime.strptime(date_str, "%Y-%m-%d")
    t0 = dt
    t1 = dt + timedelta(minutes=2)
    client = VSOClient()

    def reduce_and_save(file_path):
        """Reduce FITS file resolution and save to /tmp/output"""
        try:
            m = Map(file_path)
            log_to_queue(f"[preview] Reducing FITS preview resolution by 4x for speed...")
            reduced_data = block_reduce(m.data.astype(np.float32), (4, 4), func=np.nanmean)
            header = m.fits_header.copy()
            header['CRPIX1'] = header.get('CRPIX1', 0) / 4
            header['CRPIX2'] = header.get('CRPIX2', 0) / 4
            header['CDELT1'] = header.get('CDELT1', 1) * 4
            header['CDELT2'] = header.get('CDELT2', 1) * 4
            smap_small = Map(reduced_data, header)
            out_dir = "/tmp/output"
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, f"preview_reduced_{mission}_{wavelength}_{date_str}.fits")
            smap_small.save(out_path, filetype="fits", overwrite=True)
            log_to_queue(f"[preview] Reduced FITS saved to {out_path}")
            return out_path
        except Exception as e:
            log_to_queue(f"[preview] FITS reduction failed: {e}, returning original file")
            return file_path

    try:
        if mission.upper() == "SDO":
            wl = wavelength * u.angstrom
            log_to_queue(f"[preview] Using VSO quicklook fetch for SDO/AIA {wl}")
            qr = client.search(a.Time(t0, t1), a.Detector("AIA"), a.Provider("VSO"), a.Wavelength(wl), )
            if len(qr) == 0:
                raise ValueError("No VSO AIA results found.")
        elif mission.upper() == "SOHO-EIT":
            wl = wavelength * u.angstrom
            log_to_queue(f"[preview] Using VSO quicklook fetch for SOHO/EIT {wl}")
            qr = client.search(a.Time(t0, t1), a.Instrument("EIT"), a.Wavelength(wl))
            if len(qr) == 0:
                raise ValueError("No VSO EIT results found.")
        else:
            raise ValueError(f"Unsupported mission: {mission}")

        log_to_queue(f"[preview] Found {len(qr)} records, fetching first file...")
        files = client.fetch(qr, path="/tmp/output")
        if not files or len(files) == 0:
            raise ValueError("VSO fetch returned no files.")
        log_to_queue(f"[preview] Quicklook file fetched: {files[0]}")
        return reduce_and_save(files[0])
    except Exception as e:
        log_to_queue(f"[preview][warn] VSO fetch failed: {e}; attempting SOHO-EIT fallback...")
        try:
            wl = 195 * u.angstrom
            qr = client.search(a.Time(t0, t1), a.Instrument("EIT"), a.Wavelength(wl))
            if len(qr) == 0:
                raise ValueError("No fallback SOHO-EIT results found.")
            files = client.fetch(qr, path="/tmp/output")
            if not files or len(files) == 0:
                raise ValueError("SOHO-EIT fetch returned no files.")
            log_to_queue(f"[preview] Fallback SOHO-EIT file fetched: {files[0]}")
            return reduce_and_save(files[0])
        except Exception as fb_err:
            log_to_queue(f"[preview][error] SOHO-EIT fallback failed: {fb_err}")
            raise HTTPException(status_code=502, detail=f"Quicklook fetch failed: {e}; fallback failed: {fb_err}")




@app.options("/shopify/preview")
async def shopify_preview_options():
    # CORS preflight for Shopify preview endpoint
    return JSONResponse({}, headers=CORS_HEADERS)

# -------------------------------------------------------------------
# Dedicated endpoint to serve image assets via FileResponse
# -------------------------------------------------------------------
from fastapi.responses import FileResponse
@app.get("/asset/{subpath:path}")
async def serve_asset(subpath: str):
    """Serve any file under /tmp/output, including previews and HQ renders."""
    file_path = os.path.join("/tmp/output", subpath)
    if not os.path.exists(file_path):
        return JSONResponse(status_code=404, content={"error": f"File not found: {file_path}"})
    return FileResponse(file_path, media_type="image/png", headers={"Cache-Control": "no-cache"})