import ssl
import aiohttp
import certifi
from parfive import Downloader
import os


def _is_nasa_url(url: str) -> bool:
    return any(host in url for host in ("nascom.nasa.gov", "sdo.nascom.nasa.gov", "sdo5.nascom.nasa.gov"))

def get_downloader(total_timeout=600, connect_timeout=60, sock_read_timeout=300):
    """Return a parfive Downloader that skips SSL verification for NASA hosts.

    parfive 2.2.0 uses SessionConfig; the old connector= kwarg is gone.
    aiohttp 3.12 requires ssl_handshake_timeout > 0 (derived from ClientTimeout.total).
    NASA's sdo*.nascom.nasa.gov certs are not in the standard bundle, so we disable
    verification via ssl=False on a TCPConnector created inside the async session
    generator (which is called inside parfive's running event loop, where aiohttp
    can safely construct the connector).
    """
    from parfive.config import SessionConfig

    def _make_session(cfg):
        # ssl=False: skip cert verification — NASA NASCOM uses a non-standard CA
        connector = aiohttp.TCPConnector(ssl=False)
        timeout = aiohttp.ClientTimeout(
            total=total_timeout,
            connect=connect_timeout,
            sock_read=sock_read_timeout,
        )
        return aiohttp.ClientSession(
            connector=connector,
            timeout=timeout,
            headers=cfg.headers,
            requote_redirect_url=False,
        )

    config = SessionConfig(
        timeouts=aiohttp.ClientTimeout(
            total=total_timeout,
            connect=connect_timeout,
            sock_read=sock_read_timeout,
        ),
        aiohttp_session_generator=_make_session,
    )
    return Downloader(max_conn=8, progress=True, config=config)

# Registry to track background tasks for /generate
task_registry: dict = {}
from urllib.parse import urlencode, quote_plus
import sys
from dotenv import load_dotenv
# Load environment variables from ../.env (backend startup)
load_dotenv(os.path.join(os.path.dirname(__file__), "../.env"))
# Also load operator-only secrets from ~/.claude/secrets/solar-archive.env
# if it exists. This file is gitignored / lives outside the repo and holds
# things like FEEDBACK_ADMIN_KEY, RESEND_API_KEY, FEEDBACK_NOTIFY_EMAIL —
# letting the localhost dev server fire feedback emails just like prod.
# override=False so the repo-tracked .env still wins for anything it sets.
_operator_secrets = os.path.expanduser("~/.claude/secrets/solar-archive.env")
if os.path.isfile(_operator_secrets):
    load_dotenv(_operator_secrets, override=False)
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
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, Literal, Dict, Any
import numpy as np
import requests
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse, RedirectResponse, Response
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
import threading

# sunback/webapp/api/main.py
# FastAPI backend for Solar Archive — date→FITS via SunPy→filtered PNG→Printify product creation

# ──────────────────────────────────────────────────────────────────────
# Heavy-render concurrency cap
# ──────────────────────────────────────────────────────────────────────
# A single AIA HQ render holds 500MB–1GB resident (sunpy + matplotlib +
# numpy on a 4096² float array). Render's Standard plan has 2GB / 1 vCPU,
# which means we can fit one comfortably and two if we're careful — three
# OOMs the box. A semaphore around the heavy paths queues incoming jobs
# instead of fanning out and blowing the instance over.
_HEAVY_RENDER_SEMAPHORE = asyncio.Semaphore(1)
# Number of jobs currently waiting OR running (waiting + 1 if anything is
# active). Reported back to clients so the UI can show "Queued · N ahead"
# instead of an unmoving spinner.
_heavy_render_waiting = 0
_heavy_render_lock = threading.Lock()

def _heavy_queue_depth() -> int:
    with _heavy_render_lock:
        return _heavy_render_waiting

class _HeavyRenderSlot:
    """Async context manager that increments the queue counter on enter
    and decrements on exit — independent of when the semaphore actually
    grants the slot, so waiters show up in the depth count too."""
    async def __aenter__(self):
        global _heavy_render_waiting
        with _heavy_render_lock:
            _heavy_render_waiting += 1
        await _HEAVY_RENDER_SEMAPHORE.acquire()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        global _heavy_render_waiting
        _HEAVY_RENDER_SEMAPHORE.release()
        with _heavy_render_lock:
            _heavy_render_waiting -= 1
        return False

# ──────────────────────────────────────────────────────────────────────
# External-API rate limiters (Helioviewer, VSO)
# ──────────────────────────────────────────────────────────────────────
# Both NASA APIs are rate-sensitive — Helioviewer specifically has been
# known to throttle when slammed. We don't want a beta with 50 testers to
# get our IP block-listed at NASA. Token-style limiter: each call to
# .wait() blocks until enough time has elapsed since the last call to
# satisfy the configured req-per-minute rate. Thread-safe (used from
# inside threadpooled sync calls).
class _RateLimiter:
    def __init__(self, max_per_minute: int, name: str = ""):
        self.interval = 60.0 / max(1, max_per_minute)
        self.lock = threading.Lock()
        self.next_at = 0.0
        self.name = name or "rate-limiter"

    def wait(self) -> None:
        with self.lock:
            now = time.time()
            sleep_for = self.next_at - now
            if sleep_for > 0:
                # Release the lock while sleeping so we don't serialise
                # threads that arrive at the same instant — they each
                # update next_at and pick up correct staggered slots.
                self.next_at = max(self.next_at, now) + self.interval
            else:
                self.next_at = now + self.interval
        if sleep_for > 0:
            time.sleep(sleep_for)

# Helioviewer: 6 req/sec. The wavelength tile picker fires 9 thumb
# requests in parallel the moment a user picks a date, plus the
# main-canvas preview, so 1/sec stretched the visible "all tiles
# load" wait to ~9-10s. 3/sec got the tile grid populated in
# ~3-4s; bumped 2× to 6/sec to absorb the new [-]/[+] time-of-day
# fine-tune feature (debounced bursts of ~10 thumb refetches per
# editing session) while still staying below Helioviewer's public
# soft limit.
_HELIOVIEWER_LIMITER = _RateLimiter(360, "helioviewer")
# VSO is heavier per-call (FITS download), so throttle it tighter.
# Bumped 2× alongside the Helioviewer bump for parity.
_VSO_LIMITER = _RateLimiter(60, "vso")

class PreviewRequest(BaseModel):
    date: str
    # User-picked time of day in UTC, "HH:MM" (e.g. "12:00"). Optional —
    # historical clients (and the older default) anchored everything to
    # noon, so missing/blank reads as "12:00".
    time: str | None = "12:00"
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

# ──────────────────────────────────────────────────────────────────────────────
# Persistent default-image cache (survives deploys; lives on the Render disk)
# ──────────────────────────────────────────────────────────────────────────────
# OUTPUT_DIR above is ephemeral (/tmp on Render). For the FIXED default landing
# image (AR 2192 / 2014-10-24 / 193 Å) we want the HQ-RHEF render to persist
# across deploys, so visitors who keep the default never wait for the 1–3 min
# pipeline. Same env contract as the feedback persistence: FEEDBACK_DATA_DIR
# points at /var/data on Render. We tuck the default cache under there.
def _persistent_data_dir():
    raw = os.getenv("FEEDBACK_DATA_DIR", "").strip()
    d = Path(raw) if raw else Path(__file__).resolve().parent.parent
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        d = Path(__file__).resolve().parent.parent
    return d
DEFAULT_CACHE_DIR = _persistent_data_dir() / "default_cache"
try:
    DEFAULT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass

# The default landing image — kept as named constants so the warm endpoint and
# the do_generate_sync self-restore agree on the tuple. Change BOTH if the
# default moment ever changes.
DEFAULT_LANDING_DATE = "2014-10-24"  # AR 2192, largest sunspot in 24 years
DEFAULT_LANDING_WAVELENGTH = 193
DEFAULT_LANDING_MISSION = "SDO"
DEFAULT_LANDING_DETECTOR = "AIA"
# Filename pattern that do_generate_sync uses for HQ outputs:
#   hq_{mission}_{wavelength}_{YYYYMMDD}.png
DEFAULT_HQ_FILENAME = f"hq_{DEFAULT_LANDING_MISSION}_{DEFAULT_LANDING_WAVELENGTH}_{DEFAULT_LANDING_DATE.replace('-', '')}.png"

def _is_default_tuple(date, wavelength, mission, detector):
    """Does this HQ render request match the fixed landing default?"""
    try:
        ds = date.strftime("%Y-%m-%d") if hasattr(date, "strftime") else str(date)[:10]
    except Exception:
        ds = ""
    return (
        ds == DEFAULT_LANDING_DATE
        and int(wavelength) == DEFAULT_LANDING_WAVELENGTH
        and str(mission).upper() == DEFAULT_LANDING_MISSION
        and str(detector).upper() == DEFAULT_LANDING_DETECTOR
    )

# Phase B persistent paths: cached real-Printify mockups for the default image.
# /asset/default/mockups/<product_id>.png  (one per product)
# /asset/default/default_mockups.json     (manifest the frontend reads)
DEFAULT_MOCKUPS_DIR = DEFAULT_CACHE_DIR / "mockups"
try:
    DEFAULT_MOCKUPS_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass
DEFAULT_MOCKUPS_MANIFEST = DEFAULT_CACHE_DIR / "default_mockups.json"

# Server-side mirror of the visible product catalog (frontend PRODUCTS in
# solar-archive.js). We only need the fields the create-product call uses:
# id (our key), blueprintId, printProviderId, variantId (one representative
# variant per product — the same default the editor opens with), and the
# print-area position. Keep in sync with the frontend if products are
# added / removed / re-keyed. (Excludes _hiddenFromGrid entries like the
# Black mug sibling — those are surfaced via the colour-chooser, not as
# their own grid tile.)
_DEFAULT_MOCKUP_PRODUCTS = [
    {"id": "canvas_stretched",     "blueprintId": 555,  "printProviderId": 69,  "variantId": 70880, "position": "front"},
    {"id": "metal_sign",           "blueprintId": 1206, "printProviderId": 228, "variantId": 91993, "position": "front"},
    {"id": "acrylic_print",        "blueprintId": 1098, "printProviderId": 228, "variantId": 82057, "position": "front"},
    {"id": "poster_matte",         "blueprintId": 282,  "printProviderId": 99,  "variantId": 43135, "position": "front"},
    {"id": "framed_poster",        "blueprintId": 492,  "printProviderId": 36,  "variantId": 65400, "position": "front"},
    {"id": "wall_clock",           "blueprintId": 277,  "printProviderId": 1,   "variantId": 43008, "position": "front"},
    {"id": "tapestry",             "blueprintId": 241,  "printProviderId": 10,  "variantId": 41686, "position": "front"},
    {"id": "mug_15oz",             "blueprintId": 425,  "printProviderId": 1,   "variantId": 62014, "position": "front"},
    {"id": "tumbler_20oz",         "blueprintId": 353,  "printProviderId": 1,   "variantId": 44519, "position": "front"},
    {"id": "tshirt_unisex",        "blueprintId": 12,   "printProviderId": 29,  "variantId": 18052, "position": "front"},
    {"id": "hoodie_pullover",      "blueprintId": 77,   "printProviderId": 29,  "variantId": 32878, "position": "front"},
    {"id": "crewneck_sweatshirt",  "blueprintId": 49,   "printProviderId": 29,  "variantId": 25377, "position": "front"},
    {"id": "crew_socks",           "blueprintId": 365,  "printProviderId": 14,  "variantId": 44904, "position": "front"},
    {"id": "phone_case",           "blueprintId": 269,  "printProviderId": 1,   "variantId": 62582, "position": "front"},
    {"id": "laptop_sleeve",        "blueprintId": 429,  "printProviderId": 1,   "variantId": 62037, "position": "front"},
    {"id": "mouse_pad",            "blueprintId": 582,  "printProviderId": 99,  "variantId": 71665, "position": "front"},
    {"id": "desk_mat",             "blueprintId": 488,  "printProviderId": 1,   "variantId": 65240, "position": "front"},
    {"id": "throw_pillow",         "blueprintId": 220,  "printProviderId": 10,  "variantId": 41521, "position": "front"},
    {"id": "sherpa_blanket",       "blueprintId": 238,  "printProviderId": 99,  "variantId": 41656, "position": "front"},
    {"id": "shower_curtain",       "blueprintId": 235,  "printProviderId": 10,  "variantId": 41653, "position": "front"},
    {"id": "puzzle_1000",          "blueprintId": 532,  "printProviderId": 59,  "variantId": 68984, "position": "front"},
    {"id": "coaster_set",          "blueprintId": 510,  "printProviderId": 48,  "variantId": 72872, "position": "front"},
    {"id": "sticker_kiss",         "blueprintId": 400,  "printProviderId": 99,  "variantId": 45748, "position": "front"},
    {"id": "journal_hardcover",    "blueprintId": 485,  "printProviderId": 28,  "variantId": 65223, "position": "front"},
    {"id": "backpack",             "blueprintId": 347,  "printProviderId": 14,  "variantId": 44419, "position": "front"},
]

# Vibe-grid landing tiles — pre-rendered HQ pairs (raw + RHEF) for the
# 5 "famous moments" cards on the landing page (api/index.html L73–148).
# All entries are static dates so the cache is fully idempotent — the
# earlier dynamic `recent_corona` tile was replaced with `limb_x82_flare`
# (2017-09-10) at the user's request.
#
# X-class flares (X9.3 on 2017-09-06, X8.2 limb on 2017-09-10) use 211 Å
# rather than 131 Å for the vibe-card thumbnails: 131 Å saturates
# severely at the flare peak (Fe XXI ~10 MK blows the detector dynamic
# range), whereas 211 Å (Fe XIV ~2 MK) cleanly shows the active region
# surrounding the flare without the bloom artifact.
_VIBE_GRID_TUPLES = [
    {"slug": "ar2192",                     "date": "2014-10-24", "wavelength": 193,  "time": "12:00", "mission": "SDO", "detector": "AIA"},
    {"slug": "x93_flare",                  "date": "2017-09-06", "wavelength": 211,  "time": "12:02", "mission": "SDO", "detector": "AIA"},
    {"slug": "mothers_day_storm",          "date": "2024-05-10", "wavelength": 193,  "time": "17:00", "mission": "SDO", "detector": "AIA"},
    {"slug": "monster_prominence",         "date": "2012-08-31", "wavelength": 304,  "time": "20:00", "mission": "SDO", "detector": "AIA"},
    {"slug": "limb_x82_flare",             "date": "2017-09-10", "wavelength": 211,  "time": "16:06", "mission": "SDO", "detector": "AIA"},
    # Round-6 additions — one card per previously-missing wavelength so
    # the vibe-grid covers all 9 AIA bands. Per-band rationale:
    {"slug": "pre_x93_powderkeg",          "date": "2017-09-04", "wavelength": 94,   "time": "12:00", "mission": "SDO", "detector": "AIA"},
    {"slug": "post_flare_arcade",          "date": "2012-07-19", "wavelength": 131,  "time": "06:00", "mission": "SDO", "detector": "AIA"},
    {"slug": "great_sympathetic_eruption", "date": "2010-08-01", "wavelength": 171,  "time": "02:00", "mission": "SDO", "detector": "AIA"},
    {"slug": "ar13664_emergence",          "date": "2024-05-08", "wavelength": 335,  "time": "12:00", "mission": "SDO", "detector": "AIA"},
    {"slug": "x16_flare_ribbons",          "date": "2014-09-10", "wavelength": 1600, "time": "17:45", "mission": "SDO", "detector": "AIA"},
    {"slug": "ar2192_photosphere",         "date": "2014-10-24", "wavelength": 1700, "time": "12:00", "mission": "SDO", "detector": "AIA"},
]

# Persistent vibe-grid output paths (mirror DEFAULT_MOCKUPS_*):
#   /asset/default/vibe/<slug>/<tier>_full.png    full-res HQ
#   /asset/default/vibe/<slug>/<tier>_thumb.png   256² thumbnail
#   /asset/default/vibe_manifest.json             frontend manifest
DEFAULT_VIBE_DIR = DEFAULT_CACHE_DIR / "vibe"
try:
    DEFAULT_VIBE_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    pass
DEFAULT_VIBE_MANIFEST = DEFAULT_CACHE_DIR / "vibe_manifest.json"

if os.getenv("RENDER"):
    os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = "https://solar-archive.onrender.com/"
else:
    os.environ["SOLAR_ARCHIVE_ASSET_BASE_URL"] = "http://127.0.0.1:8000/asset/"

ASSET_BASE_URL = os.getenv("SOLAR_ARCHIVE_ASSET_BASE_URL", "")  # e.g., CDN base; else empty for local
print(f"{ASSET_BASE_URL = }")
print(f"{OUTPUT_DIR = }")
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(PREVIEW_DIR, exist_ok=True)



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


app_dir = Path(__file__).parent
# Serve all static files (HTML, JS, CSS) from /api/
app.mount("/api/static", StaticFiles(directory=str(app_dir)), name="static")
# MOUNT ORDER MATTERS in Starlette/FastAPI: registration order is the
# match order, and the first matching prefix wins. So the more-specific
# /asset/default and /asset/preview mounts must be registered BEFORE the
# catch-all /asset, otherwise /asset shadows them and Static lookups land
# in OUTPUT_DIR (the wrong tree).
#
# Persistent default-image cache (Phase A HQ + Phase B real Printify
# mockups + default_mockups.json manifest). Lives on /var/data; survives
# deploys. Served at /asset/default/.
app.mount("/asset/default", StaticFiles(directory=str(DEFAULT_CACHE_DIR)), name="default_cache")
# Preview images.
app.mount("/asset/preview", StaticFiles(directory=PREVIEW_DIR), name="asset_preview")
# Main asset mount: HQ/full-res images from OUTPUT_DIR (the catch-all).
app.mount("/asset", StaticFiles(directory=OUTPUT_DIR), name="asset")

@app.get("/api/frontend.html")
async def serve_frontend():
    """Serve the frontend page (legacy URL, redirects to /)."""
    return RedirectResponse(url="/", status_code=302)


@app.get("/api/index.html")
async def serve_index_direct():
    """Serve the main index.html page."""
    return FileResponse(Path(__file__).parent / "index.html")


# ---------------------------------------------------------
# CORS CONFIGURATION — fixes Shopify ↔ Render cross-origin
# ---------------------------------------------------------
# Round-2 security audit (Mira Sokolov): the previous policy was
# `allow_origins=["*"]`, which combined with unauthenticated POST
# endpoints meant any internet caller could fire /api/printify/checkout
# and bill the operator. Origin allowlist is now hard-coded to the
# Shopify storefront + Render service + localhost dev origins. Override
# in production by setting ALLOWED_ORIGINS=comma,separated,list. The
# api.security module reads the same env var for server-side Origin
# checks on POSTs, so CORS and the per-route check stay in sync.
from fastapi.middleware.cors import CORSMiddleware

_DEFAULT_ALLOWED = [
    "https://solar-archive.myshopify.com",
    "https://solar-archive.onrender.com",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
_env_origins = os.getenv("ALLOWED_ORIGINS", "").strip()
if _env_origins:
    allowed_origins = [o.strip().rstrip("/") for o in _env_origins.split(",") if o.strip()]
else:
    allowed_origins = _DEFAULT_ALLOWED

# Remove any old middleware before re-adding
# (avoids duplicate middleware layers if app reloads)
for i, middleware in enumerate(app.user_middleware):
    if middleware.cls.__name__ == "CORSMiddleware":
        app.user_middleware.pop(i)
        break

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# LAUNCH-READINESS fix (workflow wx5fi2brl, security-headers): emit a
# CSP + HSTS + X-Frame-Options + nosniff + Referrer-Policy on every
# response. Mitigates the ~25 innerHTML sites in solar-archive.js (each
# of which is a latent XSS surface if a future feature accepts user
# content) and prevents clickjacking-by-iframe outside the Shopify
# storefront. frame-ancestors covers both modern + legacy browsers
# (X-Frame-Options is still useful for old Edge).
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import ASGIApp

_CSP = (
    "default-src 'self'; "
    # Allow our own static + the Shopify storefront + Printify CDN images.
    "img-src 'self' data: blob: https://images.printify.com https://cdn.shopify.com https://*.shopify.com; "
    # Inline styles still in use for various dynamic colours.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
    # Inline scripts are used at top of index.html for early bootstrap.
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com https://browser.sentry-cdn.com https://js.sentry-cdn.com; "
    # Allow XHR/fetch to our own origin + Sentry + GA.
    "connect-src 'self' https://www.google-analytics.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io; "
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:; "
    # Embed only in our own Shopify storefront (clickjacking defence).
    "frame-ancestors 'self' https://solar-archive.myshopify.com https://*.myshopify.com; "
    "base-uri 'self'; "
    "form-action 'self';"
)

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        # Skip /docs OpenAPI UI so it doesn't trip on its own inline JS.
        if request.url.path.startswith("/docs") or request.url.path.startswith("/redoc"):
            return response
        h = response.headers
        h.setdefault("Content-Security-Policy", _CSP)
        h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
        h.setdefault("X-Frame-Options", "SAMEORIGIN")
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        return response

app.add_middleware(SecurityHeadersMiddleware)


# ──────────────────────────────────────────────────────────────────────────────
# /api/health — lightweight liveness check (no heavy imports); used by frontend for "Backend online"
# ──────────────────────────────────────────────────────────────────────────────
@app.get("/api/health")
async def api_health():
    """Return 200 as soon as the server can respond. Frontend uses this instead of /docs for status."""
    return JSONResponse(content={"status": "ok"}, headers=CORS_HEADERS)


# ---------------------------------------------------------------------------
# /api/build-info — when frontend assets were last modified (for "page updated" display)
# ---------------------------------------------------------------------------
@app.get("/api/build-info")
async def api_build_info():
    """Return the latest modification time of index.html, solar-archive.js, solar-archive.css (UTC ISO)."""
    import time
    api_dir = Path(__file__).resolve().parent
    files = [api_dir / "index.html", api_dir / "solar-archive.js", api_dir / "solar-archive.css"]
    latest = 0.0
    for p in files:
        if p.exists():
            try:
                m = p.stat().st_mtime
                if m > latest:
                    latest = m
            except OSError:
                pass
    if latest <= 0:
        return JSONResponse(content={"built": None}, headers=CORS_HEADERS)
    return JSONResponse(
        content={"built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(latest))},
        headers=CORS_HEADERS,
    )


# ──────────────────────────────────────────────────────────────────────────────
# /api/helioviewer_thumb — proxy Helioviewer takeScreenshot for wavelength tiles + canvas
# ──────────────────────────────────────────────────────────────────────────────
HELIOVIEWER_BASE = "https://api.helioviewer.org/v2/takeScreenshot"

def _fetch_helioviewer_screenshot(url: str, timeout: int = 60):
    """Sync fetch so we can run in executor; returns (content, content_type) or raises.

    Throttled by _HELIOVIEWER_LIMITER so a beta cohort doesn't slam
    Helioviewer's takeScreenshot endpoint and trip its rate limit.
    Each thread waits its turn before the actual outbound HTTP fires.

    Works across three network shapes without configuration:
      1. External / home wifi: no proxy in use, direct connection succeeds.
      2. Corporate network (dev): outbound direct is blocked, HTTPS_PROXY env
         points at webfilter.nwra.com which does TLS MITM.
      3. Deployed (Render): no proxy, direct connection succeeds.

    Strategy: try direct first (bypassing any HTTPS_PROXY env var). If direct
    refuses with a ConnectionError, retry letting requests honor the env
    proxy. That way external-wifi users aren't trapped by a stale corp-
    network HTTPS_PROXY in their shell profile, and corp-network users still
    reach the API via the filter.

    SSL handling: the app may set SSL_CERT_FILE to a NASA CA bundle (needed for
    JSOC/VSO), which does NOT chain to the public CA that signs api.helioviewer.org.
    Use certifi's bundle for this single call. If the corporate proxy re-signs
    certs with its own CA (breaks certifi), fall through to verify=False — the
    payload is a public read-only image so the downside is minimal.
    """
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    # Wait our turn at the rate limiter before any outbound attempt.
    # Sleeps the calling thread; safe inside run_in_threadpool / asyncio.to_thread.
    _HELIOVIEWER_LIMITER.wait()

    try:
        import certifi
        verify_first = certifi.where()
    except ImportError:
        verify_first = False

    def _do_get(proxies_arg, req_timeout):
        try:
            return requests.get(url, timeout=req_timeout, verify=verify_first, proxies=proxies_arg)
        except requests.exceptions.SSLError:
            return requests.get(url, timeout=req_timeout, verify=False, proxies=proxies_arg)

    # Try direct first with an aggressive (connect=5s, read=timeout) timeout
    # so external-wifi clients succeed fast and corp-network clients fail fast
    # enough to try the env proxy. A full `timeout` on the direct attempt
    # would make corp-network clients wait a full minute before falling back.
    try:
        r = _do_get({"http": None, "https": None}, (5, timeout))
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
        # Direct refused or couldn't connect — retry via whatever proxy
        # HTTPS_PROXY / https_proxy points at. proxies=None means "use
        # default behavior" (env vars).
        r = _do_get(None, timeout)
    r.raise_for_status()
    ct = r.headers.get("Content-Type", "").split(";")[0].strip().lower()
    if "json" in ct:
        try:
            err = r.json()
            msg = err.get("message", err.get("error", r.text[:200]))
            raise requests.RequestException(f"Helioviewer error: {msg}")
        except ValueError:
            raise requests.RequestException(f"Helioviewer returned JSON: {r.text[:200]}")
    if len(r.content) < 100:
        raise requests.RequestException(f"Helioviewer returned tiny body ({len(r.content)} bytes)")
    return r.content, r.headers.get("Content-Type", "image/png")

SDO_LAUNCH_DATE = "2010-05-15"  # First-light AIA imagery available from this date.


def _validate_solar_date(date_str: str, time_str: str | None = None) -> None:
    """Reject dates/times before SDO's first-light or in the future.

    The HTML5 date input enforces min/max client-side, but a beta-tester
    QA pass surfaced that copy/paste or direct API calls bypass that
    completely — a typed 1972-01-01 returns a 500 from upstream
    Helioviewer rather than a polite 400 from us. Clamp server-side.

    The same QA tester also flagged the dateline edge case: a Tokyo
    user picking today at 00:30 local maps to a noon-UTC request that
    hasn't happened yet ("Same for today before 12:00 UTC"). If a
    time_str is provided, we combine it with the date and reject any
    timestamp that's strictly in the future relative to UTC now.
    """
    from datetime import datetime, timezone, timedelta
    if not date_str:
        raise HTTPException(status_code=400, detail="Missing date")
    # Accept either an ISO date (2026-02-10) or a full ISO timestamp
    # (2026-02-10T12:00:00Z); split off the date portion for the
    # launch-date check.
    head = date_str.strip().split("T")[0]
    try:
        d = datetime.strptime(head, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid date format: {date_str!r}")
    today_utc = datetime.now(timezone.utc).date()
    launch = datetime.strptime(SDO_LAUNCH_DATE, "%Y-%m-%d").date()
    if d < launch:
        raise HTTPException(
            status_code=400,
            detail=f"AIA first-light is {SDO_LAUNCH_DATE}; no data before that date.",
        )
    if d > today_utc:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot fetch data from the future (requested {head}, today is {today_utc.isoformat()} UTC).",
        )
    # Datetime-level future check: only if the combined date+time is
    # AHEAD of UTC now. We give a 60-second grace window so clock skew
    # between the user's device and the server doesn't reject
    # legitimate "right now" requests.
    if time_str:
        try:
            hh, mm = time_str.strip().split(":")[:2]
            req_dt = datetime(d.year, d.month, d.day, int(hh), int(mm), 0, tzinfo=timezone.utc)
        except (ValueError, IndexError):
            return  # bad time, skip the future-time check; date-level guards still apply
        now_utc = datetime.now(timezone.utc)
        if req_dt > now_utc + timedelta(seconds=60):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"That observation hasn't happened yet — requested "
                    f"{req_dt.strftime('%Y-%m-%d %H:%M UTC')}, the latest available "
                    f"is roughly {now_utc.strftime('%Y-%m-%d %H:%M UTC')}. "
                    "Try a slightly earlier time of day, or pick yesterday."
                ),
            )


@app.get("/api/helioviewer_thumb")
async def helioviewer_thumb(
    date: str = Query(..., description="ISO date-time e.g. 2026-02-10T12:00:00Z"),
    wavelength: int = Query(..., description="AIA wavelength in Å e.g. 171"),
    image_scale: float = Query(12, description="Helioviewer imageScale (arcsec/pixel)"),
    size: int = Query(256, description="Width and height in pixels"),
):
    """Proxy Helioviewer screenshot API so the frontend can load tiles/canvas without CORS."""
    # `date` here is an ISO timestamp like 2026-02-10T12:00:00Z; pluck
    # the time portion if present so the future-time check covers
    # users in time zones ahead of UTC requesting a frame that hasn't
    # been observed yet.
    _time_part = None
    if "T" in (date or ""):
        try:
            _hhmm = date.split("T", 1)[1][:5]  # "12:00" out of "12:00:00Z"
            _time_part = _hhmm if len(_hhmm) == 5 and _hhmm[2] == ":" else None
        except (IndexError, AttributeError):
            _time_part = None
    _validate_solar_date(date, _time_part)
    # When frontend sends 12, frame out to 1.5 solar radii (~3000 arcsec) so off-limb corona is visible.
    if image_scale == 12:
        scale = 3000.0 / max(size, 64)  # arcsec/pixel so FOV = size * scale ≈ 3000 (1.5 R_sun)
    else:
        scale = float(image_scale)
    url = (
        f"{HELIOVIEWER_BASE}/?"
        f"date={requests.utils.quote(date)}"
        f"&imageScale={scale}"
        f"&layers=[SDO,AIA,AIA,{wavelength},1,100]"
        f"&x0=0&y0=0&width={size}&height={size}&display=true&watermark=false"
    )
    timeout = 90 if size >= 1024 else 60
    try:
        loop = asyncio.get_event_loop()
        content, media_type = await loop.run_in_executor(
            None, lambda: _fetch_helioviewer_screenshot(url, timeout=timeout)
        )
        return Response(content=content, media_type=media_type, headers=CORS_HEADERS)
    except requests.RequestException as e:
        print(f"[helioviewer_thumb] {url[:120]}... -> {e}", flush=True)
        raise HTTPException(status_code=502, detail=f"Helioviewer proxy failed: {e}")


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
    # Anchor to noon UTC to match the Helioviewer JPG (`hour=12`). A
    # date-only `dt` from the frontend parses to midnight, which would
    # otherwise put the FITS ~12 hours off the JPG taken later in the
    # render pipeline.
    dt_query = dt.replace(hour=12, minute=0, second=0, microsecond=0)
    attrs = [
        a.Time(dt_query, dt_query + timedelta(minutes=1)),
        a.Detector("AIA"),
        a.Wavelength(wl * u.angstrom),
        a.Source("SDO"),
    ]
    print(f"[fetch_first_fits] Search attrs: {attrs}", flush=True)
    _VSO_LIMITER.wait()
    qr = client.search(*attrs)
    if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
        raise HTTPException(status_code=502, detail="No VSO AIA data for this date/wavelength")
    target_dir = os.environ.get("SUNPY_DOWNLOADDIR", OUTPUT_DIR)
    dl = get_downloader()
    _VSO_LIMITER.wait()
    files = Fido.fetch(qr[0], downloader=dl, path=target_dir)
    if not files or len(files) == 0:
        raise HTTPException(status_code=502, detail="VSO AIA fetch returned no files")
    return str(files[0])


def _generate_preview_sync(dt, wl, date_str, out_path_raw, out_path_filtered, out_path_jpg, url_path_raw, url_path_filtered, url_path_jpg):
    """Blocking FITS fetch + raw and RHEF-filtered PNGs. Also fetches Helioviewer instant preview as JPG.
    Writes preview_SDO_{wl}_{date_str}_raw.png, _filtered.png, and _jpg.png (Helioviewer) for the UI."""
    import ssl as _ssl
    import certifi
    from sunpy.net import Fido, attrs as a
    from sunpy.net.vso import VSOClient
    import astropy.units as u
    from datetime import timedelta

    # Reassert SSL/NASA cert config inside thread (same as do_generate_sync + fido_fetch_map)
    _ssl._create_default_https_context = _ssl._create_unverified_context
    os.environ["SSL_CERT_FILE"] = os.getenv("SSL_CERT_FILE", NASA_CA_BUNDLE)
    os.environ["REQUESTS_CA_BUNDLE"] = os.getenv("REQUESTS_CA_BUNDLE", NASA_CA_BUNDLE)
    # Force HTTPS for VSO (same as fido_fetch_map line 1125)
    os.environ["VSO_URL"] = "https://vso.stanford.edu/cgi-bin/VSO_GETDATA.cgi"
    log_to_queue(f"[generate_preview] VSO_URL={os.environ['VSO_URL']}")
    log_to_queue(f"[generate_preview] SSL_CERT_FILE={os.environ['SSL_CERT_FILE']}")

    download_dir = os.environ.get("SUNPY_DOWNLOADDIR", os.path.join(OUTPUT_DIR, "data"))
    os.makedirs(download_dir, exist_ok=True)
    log_to_queue(f"[generate_preview] download_dir={download_dir}")

    # Fetch Helioviewer instant preview first (JPG option = helioviewer-derived).
    # Resize to PREVIEW_SIZE so JPG matches raw/filtered; 384 matches PREVIEW_TARGET used for RHEF.
    PREVIEW_SIZE = 384
    os.makedirs(os.path.dirname(out_path_jpg), exist_ok=True)
    try:
        # Use the user's exact time (passed in via `dt`) so the JPG and
        # the FITS query below ask Helioviewer / VSO for the same instant.
        # Previously this was forced to noon, which created the JPG-vs-
        # RHEF time drift the user reported.
        hv_dt = dt.replace(second=0, microsecond=0)
        hv_date_str = hv_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        scale = 3000.0 / 1024.0
        url = (
            f"{HELIOVIEWER_BASE}/?"
            f"date={requests.utils.quote(hv_date_str)}"
            f"&imageScale={scale}"
            f"&layers=[SDO,AIA,AIA,{wl},1,100]"
            f"&x0=0&y0=0&width=1024&height=1024&display=true&watermark=false"
        )
        content, _ = _fetch_helioviewer_screenshot(url)
        # Resize to PREVIEW_SIZE so JPG matches raw/filtered and overlays in the UI
        import io as _io
        import matplotlib.pyplot as _plt_jpg
        from skimage.transform import resize as _sk_resize
        arr = _plt_jpg.imread(_io.BytesIO(content))
        h, w = arr.shape[0], arr.shape[1]
        if (h, w) != (PREVIEW_SIZE, PREVIEW_SIZE):
            preserve = arr.dtype == np.uint8 or np.issubdtype(arr.dtype, np.integer)
            arr = _sk_resize(
                arr, (PREVIEW_SIZE, PREVIEW_SIZE) + (arr.shape[2:] if arr.ndim == 3 else ()),
                preserve_range=preserve, anti_aliasing=True
            )
            if preserve:
                arr = np.clip(arr, 0, 255).astype(np.uint8)
        _plt_jpg.imsave(out_path_jpg, arr)
        log_to_queue(f"[generate_preview] Helioviewer JPG saved (resized to {PREVIEW_SIZE}px): {os.path.basename(out_path_jpg)}")
    except Exception as e:
        log_to_queue(f"[generate_preview] Helioviewer JPG failed (continuing): {e}")

    # Check if we already have a FITS for this date/wavelength cached locally
    import glob as _glob
    date_glob = dt.strftime('%Y_%m_%d')
    search_dirs = [download_dir, OUTPUT_DIR]
    existing = []
    for sdir in search_dirs:
        existing += [f for f in _glob.glob(os.path.join(sdir, f"aia.lev1.{wl}A_{date_glob}*.fits")) if os.path.getsize(f) > 100_000]
        existing += [f for f in _glob.glob(os.path.join(sdir, f"AIA*{date_glob.replace('_', '')}*{wl}*.fits")) if os.path.getsize(f) > 100_000]
    existing = list(dict.fromkeys(existing))  # dedupe, keep order
    log_to_queue(f"[generate_preview] Cache check ({date_glob} {wl}A): {existing or 'none found'}")
    if existing:
        fits_path = existing[0]
        log_to_queue(f"[generate_preview] Using cached FITS: {os.path.basename(fits_path)}")
    else:
        fits_path = None  # will be set by VSO download or left None for Helioviewer fallback
        try:
            client = VSOClient()
            # NASA DRMS can be slow; use timeouts that allow slow-but-valid FITS (~10–50MB) to complete.
            # sock_read=60 allows slow streaming; total=180 so one slow file can finish. Broken records
            # still fail within these limits instead of hanging indefinitely.
            fast_downloader = get_downloader(total_timeout=180, connect_timeout=30, sock_read_timeout=60)

            def _is_usable_fits(path):
                """Return True if the file exists and is large enough to use (avoid placeholders)."""
                if not path or not os.path.exists(path):
                    return False
                return os.path.getsize(path) >= 100_000

            def _try_download(candidate_dt, label):
                """Search ±2min around candidate_dt, probe one row at a time. Use first successful download."""
                _VSO_LIMITER.wait()
                qr = client.search(
                    a.Time(candidate_dt, candidate_dt + timedelta(minutes=2)),
                    a.Detector("AIA"),
                    a.Wavelength(wl * u.angstrom),
                    a.Source("SDO"),
                )
                if len(qr) == 0:
                    return None
                log_to_queue(f"[generate_preview] {label}: {len(qr)} records found, probing one at a time...")
                for i in range(len(qr)):
                    one_row = qr[i:i+1]
                    _VSO_LIMITER.wait()
                    result = Fido.fetch(one_row, path=download_dir, downloader=fast_downloader)
                    if result and len(result) > 0:
                        path = str(result[0])
                        if _is_usable_fits(path):
                            log_to_queue(f"[generate_preview] Using: {os.path.basename(path)}")
                            return path
                        continue
                    err = str(result.errors[0])[:100] if hasattr(result, 'errors') and result.errors else "unknown"
                    log_to_queue(f"[generate_preview] {label}: row {i} failed ({err[:80]}), trying next row...")
                    if os.environ.get("SOLAR_ARCHIVE_DEBUG"):
                        breakpoint()  # inspect result, result.errors, one_row, i, label, download_dir
                log_to_queue(f"[generate_preview] {label}: all {len(qr)} rows failed, skipping day.")
                return None

            # FITS query honours the user's exact time. The frontend now
            # carries an explicit time-of-day field, so `dt` already has
            # the right hour/minute set — no override needed. JPG above
            # uses the same `dt`, so JPG and FITS land on the same instant.
            dt_query = dt.replace(second=0, microsecond=0)
            ts_label = dt_query.strftime("%H:%M UTC")
            fits_path = _try_download(dt_query, f"exact day {dt_query.date()} {ts_label}")
            if not fits_path:
                log_to_queue(f"[generate_preview] Scanning nearby days...")
                for offset in range(1, 8):
                    for candidate in [dt_query - timedelta(days=offset), dt_query + timedelta(days=offset)]:
                        fits_path = _try_download(candidate, f"offset {offset:+}d ({candidate.date()} {ts_label})")
                        if fits_path:
                            break
                    if fits_path:
                        break
        except Exception as vso_err:
            # VSO/SunPy unavailable (e.g. WSDL mirrors unreachable on this network).
            # fits_path stays None so the Helioviewer fallback below runs automatically.
            log_to_queue(f"[generate_preview] VSO unavailable ({type(vso_err).__name__}): {vso_err}")

        if not fits_path:
            if os.environ.get("SOLAR_ARCHIVE_DEBUG"):
                breakpoint()  # inspect before Helioviewer fallback: dt, wl, date_str, out_path_filtered
            # Fallback: NASA DRMS often times out; use Helioviewer PNG so user still gets a preview.
            log_to_queue("[generate_preview] VSO/DRMS failed; trying Helioviewer fallback...")
            try:
                # Same instant the JPG+FITS used above (now user-picked,
                # not hard-coded to noon).
                hv_dt = dt.replace(second=0, microsecond=0)
                hv_date_str = hv_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
                scale = 3000.0 / 1024.0
                url = (
                    f"{HELIOVIEWER_BASE}/?"
                    f"date={requests.utils.quote(hv_date_str)}"
                    f"&imageScale={scale}"
                    f"&layers=[SDO,AIA,AIA,{wl},1,100]"
                    f"&x0=0&y0=0&width=1024&height=1024&display=true&watermark=false"
                )
                content, _ = _fetch_helioviewer_screenshot(url)
                os.makedirs(os.path.dirname(out_path_filtered), exist_ok=True)
                with open(out_path_filtered, "wb") as f:
                    f.write(content)
                if not os.path.exists(out_path_jpg) or os.path.getsize(out_path_jpg) < 100:
                    import io as _io
                    import matplotlib.pyplot as _plt_jpg2
                    from skimage.transform import resize as _sk_resize
                    arr = _plt_jpg2.imread(_io.BytesIO(content))
                    h, w = arr.shape[0], arr.shape[1]
                    sz = PREVIEW_SIZE
                    if (h, w) != (sz, sz):
                        preserve = arr.dtype == np.uint8 or np.issubdtype(arr.dtype, np.integer)
                        arr = _sk_resize(
                            arr, (sz, sz) + (arr.shape[2:] if arr.ndim == 3 else ()),
                            preserve_range=preserve, anti_aliasing=True
                        )
                        if preserve:
                            arr = np.clip(arr, 0, 255).astype(np.uint8)
                    _plt_jpg2.imsave(out_path_jpg, arr)
                log_to_queue(f"[generate_preview] Helioviewer fallback saved: {os.path.basename(out_path_filtered)}")
                return (url_path_filtered, url_path_filtered, url_path_jpg)
            except Exception as e:
                log_to_queue(f"[generate_preview] Helioviewer fallback failed: {e}")
                if os.environ.get("SOLAR_ARCHIVE_DEBUG"):
                    breakpoint()  # inspect e, out_path before raising 502
                raise HTTPException(status_code=502, detail="VSO AIA fetch returned no files after all retries")
    from sunpy.map import Map
    import matplotlib.pyplot as plt
    from skimage.measure import block_reduce
    smap = Map(fits_path)

    # ── JPG ↔ FITS co-registration ──────────────────────────────
    # Helioviewer's takeScreenshot snaps to the nearest available
    # frame at its own discretion, which can drift hours from the
    # FITS frame VSO actually returned (beta tester reported the JPG
    # vs RAW/RHEF panes were not on the same observation). Re-issue
    # the Helioviewer fetch using the FITS file's DATE-OBS so the JPG
    # pane is forced to the same instant. If the re-fetch fails we
    # keep the earlier JPG rather than blowing up the preview path.
    try:
        fits_obs_dt = getattr(smap, "date", None)
        fits_obs_dt = fits_obs_dt.to_datetime() if fits_obs_dt is not None else None
        if fits_obs_dt is not None:
            hv_obs_str = fits_obs_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            hv_scale = 3000.0 / 1024.0
            hv_url = (
                f"{HELIOVIEWER_BASE}/?"
                f"date={requests.utils.quote(hv_obs_str)}"
                f"&imageScale={hv_scale}"
                f"&layers=[SDO,AIA,AIA,{wl},1,100]"
                f"&x0=0&y0=0&width=1024&height=1024&display=true&watermark=false"
            )
            hv_content, _hv_meta = _fetch_helioviewer_screenshot(hv_url)
            import io as _io2
            import matplotlib.pyplot as _plt_jpg3
            from skimage.transform import resize as _sk_resize2
            _arr = _plt_jpg3.imread(_io2.BytesIO(hv_content))
            _h, _w = _arr.shape[0], _arr.shape[1]
            if (_h, _w) != (PREVIEW_SIZE, PREVIEW_SIZE):
                _preserve = _arr.dtype == np.uint8 or np.issubdtype(_arr.dtype, np.integer)
                _arr = _sk_resize2(
                    _arr, (PREVIEW_SIZE, PREVIEW_SIZE) + (_arr.shape[2:] if _arr.ndim == 3 else ()),
                    preserve_range=_preserve, anti_aliasing=True,
                )
                if _preserve:
                    _arr = np.clip(_arr, 0, 255).astype(np.uint8)
            _plt_jpg3.imsave(out_path_jpg, _arr)
            log_to_queue(
                f"[generate_preview] JPG re-fetched at FITS DATE-OBS={hv_obs_str} "
                f"(co-registered with RAW/RHEF)"
            )
    except Exception as _coreg_err:
        log_to_queue(f"[generate_preview] JPG co-registration skipped: {_coreg_err}")

    data = np.array(smap.data, dtype=np.float32)
    data[data <= 0] = np.nan
    h, w = data.shape
    PREVIEW_TARGET = 384  # smaller = faster RHEF so preview is ready sooner for image creation
    block_size = max(1, int(np.ceil(h / PREVIEW_TARGET)))
    reduced = block_reduce(data, block_size=(block_size, block_size), func=np.nanmean)
    from sunpy.map.sources.sdo import AIAMap
    from sunpy.util.metadata import MetaDict
    meta = MetaDict(smap.meta.copy())
    if "cdelt1" in meta and "cdelt2" in meta:
        meta["cdelt1"] = meta["cdelt1"] * block_size
        meta["cdelt2"] = meta["cdelt2"] * block_size
        meta["crpix1"] = meta["crpix1"] / block_size
        meta["crpix2"] = meta["crpix2"] / block_size
    meta["naxis1"] = reduced.shape[1]
    meta["naxis2"] = reduced.shape[0]
    smap_reduced = AIAMap(reduced, meta)
    cmap = plt.get_cmap(f"sdoaia{wl}")
    os.makedirs(os.path.dirname(out_path_raw), exist_ok=True)
    fig_dpi = 100
    fig_inches = PREVIEW_SIZE / fig_dpi
    # Raw preview (no RHEF) — same stretch so toggling is comparable
    vmin_raw = np.nanpercentile(reduced, 1)
    vmax_raw = np.nanpercentile(reduced, 99.7)
    plt.figure(figsize=(fig_inches, fig_inches), dpi=fig_dpi)
    plt.axis("off")
    plt.imshow(reduced, cmap=cmap, vmin=vmin_raw, vmax=vmax_raw, origin="lower")
    plt.tight_layout(pad=0)
    plt.savefig(out_path_raw, bbox_inches="tight", pad_inches=0)
    plt.close()
    # Filtered preview (RHEF)
    from sunkit_image import radial
    try:
        rhef_data = radial.rhef(smap_reduced, progress=True).data
    except Exception:
        log_to_queue("[rhef][warn] Preview RHEF failed on Map — using array fallback.")
        rhef_data = radial.rhef(smap_reduced.data, progress=True).data
    vmin = np.nanpercentile(rhef_data, 1)
    vmax = np.nanpercentile(rhef_data, 99.7)
    plt.figure(figsize=(fig_inches, fig_inches), dpi=fig_dpi)
    plt.axis("off")
    plt.imshow(rhef_data, cmap=cmap, vmin=vmin, vmax=vmax, origin="lower")
    plt.tight_layout(pad=0)
    plt.savefig(out_path_filtered, bbox_inches="tight", pad_inches=0)
    plt.close()
    import time
    for _ in range(50):
        if os.path.exists(out_path_filtered) and os.path.getsize(out_path_filtered) > 1000:
            break
        time.sleep(0.05)
    return (url_path_raw, url_path_filtered, url_path_jpg)


# Cache of (date_str, wl) for which preview generation already failed (e.g. no VSO data)
# so we return 200 with preview_url=null instead of 202 again and avoid repeated failing tasks.
_preview_failed: set = set()
# Keys currently being generated — prevents spawning duplicate background tasks when the
# client polls and gets 202 multiple times before the task finishes.
_preview_in_progress: set = set()


@app.post("/api/clear_preview_failed")
async def clear_preview_failed():
    """Clear the in-memory set of failed preview keys so they can be retried."""
    count = len(_preview_failed)
    _preview_failed.clear()
    # Also clear in_progress so stalled tasks can be retried
    _preview_in_progress.clear()
    return JSONResponse(
        status_code=200,
        content={"cleared": count, "message": f"Cleared {count} failed preview cache entries"},
        headers=CORS_HEADERS,
    )


@app.post("/api/generate_preview")
async def generate_preview(req: PreviewRequest = Body(...)):
    """
    Warm the science-image cache: if preview PNG exists return it; if we already know
    this date/wl has no data, return preview_url=null; otherwise run FITS+RHEF in background.
    Only one background task per (date+time, wavelength) is allowed at a time.
    """
    # Server-side date validation — same rules as /api/helioviewer_thumb.
    # The form's HTML5 min/max attributes don't cover direct API hits, and
    # the heavy FITS pipeline is way too expensive to kick off only to
    # discover the date is invalid an hour later. Pass time too so the
    # future-time check rejects requests for observations that haven't
    # happened yet (e.g. a Tokyo user picking today at 00:30 local maps
    # to a noon-UTC request which is still in the future).
    _validate_solar_date(req.date or "", (req.time or "").strip() or None)
    try:
        # Combine the user's date with their picked time of day so the
        # JPG (Helioviewer) and the RAW/RHEF (VSO/SunPy) fetches both
        # land on the same observation. Defaults to noon UTC for back-
        # compat with clients that don't send the field yet.
        time_raw = (req.time or "12:00").strip()
        try:
            hh, mm = time_raw.split(":")
            hour = max(0, min(23, int(hh)))
            minute = max(0, min(59, int(mm)))
        except Exception:
            hour, minute = 12, 0
        dt = datetime.strptime(req.date, "%Y-%m-%d").replace(hour=hour, minute=minute)
        wl = int(req.wavelength)
        # File slug includes the time so different times of day cache
        # independently — e.g. "20260421_1200" vs "20260421_1830".
        date_str = dt.strftime("%Y%m%d_%H%M")
        key = (date_str, wl)
        base = f"preview_SDO_{wl}_{date_str}"
        out_path_raw = os.path.join(PREVIEW_DIR, f"{base}_raw.png")
        out_path_filtered = os.path.join(PREVIEW_DIR, f"{base}_filtered.png")
        out_path_jpg = os.path.join(PREVIEW_DIR, f"{base}_jpg.png")
        url_path_raw = f"/asset/preview/{base}_raw.png"
        url_path_filtered = f"/asset/preview/{base}_filtered.png"
        url_path_jpg = f"/asset/preview/{base}_jpg.png"
        if os.path.exists(out_path_filtered):
            raw_url = url_path_raw if os.path.exists(out_path_raw) else None
            jpg_url = url_path_jpg if os.path.exists(out_path_jpg) else None
            return {"preview_url": url_path_filtered, "preview_raw_url": raw_url, "preview_jpg_url": jpg_url}
        if key in _preview_failed:
            return JSONResponse(
                status_code=200,
                content={"preview_url": None, "error": "No VSO AIA data for this date/wavelength"},
                headers=CORS_HEADERS,
            )
        # If already generating, return partial results so UI can show JPG while RHEF runs
        if key in _preview_in_progress:
            if os.path.exists(out_path_filtered):
                raw_url = url_path_raw if os.path.exists(out_path_raw) else None
                jpg_url = url_path_jpg if os.path.exists(out_path_jpg) else None
                return {"preview_url": url_path_filtered, "preview_raw_url": raw_url, "preview_jpg_url": jpg_url}
            if os.path.exists(out_path_jpg):
                return JSONResponse(
                    status_code=200,
                    content={
                        "preview_url": None,
                        "preview_raw_url": None,
                        "preview_jpg_url": url_path_jpg,
                        "status": "rhef_generating",
                        "queue_depth": _heavy_queue_depth(),
                    },
                    headers=CORS_HEADERS,
                )
            return JSONResponse(
                status_code=202,
                content={
                    "status": "in_progress",
                    "preview_url": None,
                    "queue_depth": _heavy_queue_depth(),
                },
                headers=CORS_HEADERS,
            )
        # Mark as in-progress and run in background so client gets 202 immediately
        _preview_in_progress.add(key)
        async def run():
            # Funnel every heavy preview render through the same global
            # semaphore so concurrent requests queue rather than fan out
            # and OOM the box. The slot context-manager also keeps the
            # queue-depth counter accurate while we're waiting.
            try:
                async with _HeavyRenderSlot():
                    await asyncio.to_thread(
                        _generate_preview_sync, dt, wl, date_str,
                        out_path_raw, out_path_filtered, out_path_jpg,
                        url_path_raw, url_path_filtered, url_path_jpg
                    )
            except Exception as e:
                _preview_failed.add(key)
                print(f"[generate_preview] background failed: {e}", flush=True)
            finally:
                _preview_in_progress.discard(key)
        asyncio.create_task(run())
        return JSONResponse(
            status_code=202,
            content={
                "status": "accepted",
                "preview_url": None,
                "queue_depth": _heavy_queue_depth(),
            },
            headers=CORS_HEADERS,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))



from api import printify_routes
app.include_router(printify_routes.router, prefix="/api")

from api import feedback_routes
app.include_router(feedback_routes.router, prefix="/api")
app.include_router(feedback_routes.catalog_router, prefix="/api")

from api import stats_routes
app.include_router(stats_routes.router, prefix="/api")

# --- Asynchronous HQ generation endpoints ---
from fastapi import BackgroundTasks, HTTPException, APIRouter
import uuid, asyncio

import threading
# Simple in-memory task registry
tasks = {}
# Thread lock for status updates
status_lock = threading.Lock()

async def run_generation_task(task_id: str, date: str, wavelength: str, mission: str, detector: str, format_type: str = "rhef"):
    """
    Actual HQ generation logic for async background task.
    format_type: 'jpg' | 'raw' | 'rhef'. Currently only rhef is implemented.
    """
    try:
        with status_lock:
            tasks[task_id] = {
                "status": "queued",
                "message": "HQ generation queued",
                "queue_depth": _heavy_queue_depth(),
            }
            log_to_queue(f"[hq-task][{task_id}] Status: queued (depth={_heavy_queue_depth()})")
        # Convert date/wavelength types. Accepts both YYYY-MM-DD (legacy
        # callers) and YYYY-MM-DDTHH:MM:SS (frontend after the time-of-day
        # field landed). fromisoformat handles both shapes.
        try:
            dt = datetime.fromisoformat(date.replace("Z", ""))
        except ValueError:
            dt = datetime.strptime(date, "%Y-%m-%d")
        wl = int(wavelength)
        # Heavy semaphore: queues this HQ render behind any preview/HQ
        # already in flight. status flips from "queued" to "started" the
        # instant we acquire the slot, so the UI can differentiate the
        # waiting phase from the actually-rendering phase.
        async with _HeavyRenderSlot():
            with status_lock:
                tasks[task_id] = {"status": "started", "message": "HQ generation started"}
                log_to_queue(f"[hq-task][{task_id}] Status: started")
            # format_type ignored for now; only RHEF is produced
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
    # Persistent-cache self-restore for the FIXED default landing image —
    # OUTPUT_DIR is ephemeral (/tmp on Render) so a fresh deploy would
    # otherwise re-run the 1–3 min HQ pipeline for the default tuple. If
    # we previously wrote it to the persistent disk (DEFAULT_CACHE_DIR),
    # restore from there instead. Cheap, idempotent, only kicks in for
    # the default — user-picked dates regenerate as before.
    if _is_default_tuple(date, wavelength, mission, detector):
        persistent_default = DEFAULT_CACHE_DIR / out_name
        if persistent_default.exists() and persistent_default.stat().st_size > 1000:
            try:
                import shutil
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                shutil.copy2(str(persistent_default), out_path)
                log_to_queue(f"[do_generate_sync] Restored default HQ from persistent cache: {out_path}")
                return url_path
            except Exception as e:
                log_to_queue(f"[do_generate_sync][warn] Persistent default restore failed: {e}")
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
    # Write-through to the persistent default cache so the next deploy
    # (after /tmp wipes) self-restores instead of regenerating. Only the
    # FIXED default tuple — user-picked dates stay ephemeral.
    if _is_default_tuple(date, wavelength, mission, detector):
        try:
            import shutil
            DEFAULT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copy2(out_path, str(DEFAULT_CACHE_DIR / out_name))
            log_to_queue(f"[do_generate_sync] Default HQ written through to persistent cache")
        except Exception as e:
            log_to_queue(f"[do_generate_sync][warn] Persistent write-through failed: {e}")
    return url_path

def _check_ram_headroom(min_free_mb: int = 400) -> None:
    """LAUNCH-BLOCKER fix (workflow wx5fi2brl, rhef-oom-512mb):
    refuse a fresh RHEF render when free RAM is below `min_free_mb`,
    rather than crashing the process and taking the whole server with
    it. Caller catches HTTPException and surfaces a friendly retry
    message. Silent on import failure (psutil not installed → skip
    guard). Tuneable via RAM_HEADROOM_MB env var; default 400 MB
    matches the worst-case RHEF + matplotlib working set on a 2 GB
    instance."""
    try:
        import psutil as _psutil
    except Exception:
        return
    try:
        mem = _psutil.virtual_memory()
        env_min = int(os.getenv("RAM_HEADROOM_MB", str(min_free_mb)))
        free_mb = mem.available / (1024 * 1024)
        if free_mb < env_min:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Server is busy ({free_mb:.0f} MB free; need ≥{env_min} MB). "
                    f"Try one of the pre-rendered famous moments above, or try again in a minute."
                ),
            )
    except HTTPException:
        raise
    except Exception:
        # Don't let a guard failure block the path — just log + continue.
        print(f"[ram_headroom] guard check failed (continuing): {sys.exc_info()[1]}")


@app.post("/api/generate")
async def start_generate(background_tasks: BackgroundTasks, payload: dict):
    """Start the HQ generation task asynchronously and return a task_id.
    Optional 'format': 'jpg' | 'raw' | 'rhef' (default rhef). Currently only rhef is implemented.
    Optional 'time' (HH:MM UTC) gets folded into `date` so the HQ render
    targets the same instant as the preview pipeline."""
    _check_ram_headroom()
    date = payload.get("date")
    time_raw = (payload.get("time") or "12:00").strip()
    wavelength = payload.get("wavelength")
    mission = payload.get("mission", "SDO")
    detector = payload.get("detector", "AIA")
    format_type = payload.get("format", "rhef")
    if not date or not wavelength:
        raise HTTPException(status_code=400, detail="Missing date or wavelength")
    # Fold time into the date string the worker receives so we don't
    # have to plumb a new arg through `run_generation_task` and its
    # downstream callers. fido_fetch_map already handles ISO datetimes.
    try:
        hh, mm = time_raw.split(":")
        hour = max(0, min(23, int(hh)))
        minute = max(0, min(59, int(mm)))
        date = f"{date}T{hour:02d}:{minute:02d}:00"
    except Exception:
        # Bad time → leave date as-is; downstream parser falls back to noon.
        pass
    task_id = str(uuid.uuid4())
    with status_lock:
        tasks[task_id] = {"status": "queued", "message": "HQ generation queued"}
    background_tasks.add_task(run_generation_task, task_id, date, wavelength, mission, detector, format_type)
    return {"task_id": task_id, "status_url": f"/api/status/{task_id}"}

@app.get("/api/status/{task_id}")
async def get_status(task_id: str):
    """Poll generation task status."""
    with status_lock:
        task_status = tasks.get(task_id, {"status": "unknown", "message": "No such task"})
    return JSONResponse(content=task_status)


# ──────────────────────────────────────────────────────────────────────────────
# Admin: warm the persistent default-image caches
# ──────────────────────────────────────────────────────────────────────────────
# Phase A: pre-render the HQ-RHEF for the FIXED default landing tuple
# (AR 2192 / 2014-10-24 / 193 Å) so a visitor who keeps the default never
# waits for the 1–3 min HQ pipeline. Result lands on /var/data via
# do_generate_sync's write-through (already wired above). Idempotent — if
# the persistent file already exists, returns immediately. (Phase B will
# extend this endpoint to also pre-render real Printify mockups.)
#
# Gated by FEEDBACK_ADMIN_KEY (X-Admin-Key header — same key + same
# constant-time compare contract as the feedback admin endpoint). Trigger
# once post-deploy:
#   source ~/.claude/secrets/solar-archive.env
#   curl -X POST -H "X-Admin-Key: $FEEDBACK_ADMIN_KEY" \
#     https://solar-archive.onrender.com/api/admin/warm_default
import hmac as _hmac

def _check_warm_admin_key(provided: Optional[str]) -> None:
    expected = os.getenv("FEEDBACK_ADMIN_KEY", "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Admin access disabled — set FEEDBACK_ADMIN_KEY to enable.")
    if not provided or not _hmac.compare_digest(provided.strip(), expected):
        raise HTTPException(status_code=401, detail="Invalid admin key")


# ── Phase B helpers ──────────────────────────────────────────────────────────
# Pre-render REAL Printify mockups for each product using the cached default
# HQ image. We call the Printify API DIRECTLY (not through /api/printify/*)
# so we bypass the public origin/rate-limit/BETA_MODE gates — this is a
# server-side admin operation, not a public caller. The flow per product:
#   create draft  →  read mockup URL from response  →  download  →  delete
# Cached files: /var/data/default_cache/mockups/<product_id>.png
# Manifest:     /var/data/default_cache/default_mockups.json
#
# Cost: Printify creates are FREE (only ordering charges). Drafts never
# publish to the Shopify store. We delete them after grabbing the mockup
# so the Printify dashboard stays clean.

def _phase_b_load_default_image_b64():
    """Read the persistent default HQ PNG and return it base64-encoded for
    the Printify uploads endpoint. Raises if Phase A hasn't run yet."""
    import base64
    path = DEFAULT_CACHE_DIR / DEFAULT_HQ_FILENAME
    if not (path.exists() and path.stat().st_size > 1000):
        raise RuntimeError(
            f"Phase B needs the Phase A HQ image first; not found at {path}. "
            "Run Phase A (default warm) before Phase B."
        )
    return base64.b64encode(path.read_bytes()).decode("ascii")

def _phase_b_pick_mockup_url(product_json):
    """Pick the primary mockup URL from a Printify product-create response.
    Prefers the first image marked `is_default: true`, then the first front
    image, then the first image overall. Returns None if there are no
    usable mockup images."""
    imgs = (product_json or {}).get("images") or []
    if not imgs:
        return None
    for img in imgs:
        if img.get("is_default") and img.get("src"):
            return img["src"]
    for img in imgs:
        pos = str(img.get("position") or "").lower()
        if pos == "front" and img.get("src"):
            return img["src"]
    for img in imgs:
        if img.get("src"):
            return img["src"]
    return None

def _phase_b_cdn_download(url, timeout=60, max_attempts=4):
    """Download a public asset (Printify mockup CDN) verifying with certifi.

    The rest of the process points SSL_CERT_FILE / REQUESTS_CA_BUNDLE at the
    NASA-augmented bundle for VSO/JSOC FITS work — that bundle does NOT
    cover the public CA chain CDNs use, which makes a plain requests.get
    to images.printify.com fail with "Max retries exceeded". Pop those env
    vars during the call and pass verify=certifi.where(). Restore after.

    Also retries with small backoff — fresh Printify mockup URLs sometimes
    return transient errors while the CDN warms up.
    """
    import requests as _requests
    import certifi as _certifi, time as _time
    saved_ca = os.environ.pop("REQUESTS_CA_BUNDLE", None)
    saved_ssl = os.environ.pop("SSL_CERT_FILE", None)
    last_err = None
    try:
        for attempt in range(1, max_attempts + 1):
            try:
                r = _requests.get(url, timeout=timeout, verify=_certifi.where())
                if r.status_code == 200 and r.content:
                    return r.content
                last_err = f"HTTP {r.status_code}"
            except Exception as e:
                last_err = str(e)[:160]
            if attempt < max_attempts:
                _time.sleep(1.5 * attempt)  # 1.5s, 3s, 4.5s
        raise RuntimeError(f"download failed after {max_attempts} attempts: {last_err}")
    finally:
        if saved_ca: os.environ["REQUESTS_CA_BUNDLE"] = saved_ca
        if saved_ssl: os.environ["SSL_CERT_FILE"] = saved_ssl


def _phase_b_cleanup_orphan_drafts():
    """Delete any leftover draft products whose title starts with the warm
    marker '[MOCKUP-WARM]' — from a previous failed warm run. Best-effort.
    Returns the count deleted (and printed failures)."""
    from api.printify_routes import _printify_request, _headers, _shop_id, PRINTIFY_BASE
    import time as _time
    shop_id = _shop_id()
    deleted = 0
    # Paginate through the shop's products. Printify supports ?limit=&page=.
    page = 1
    while True:
        r = _printify_request(
            "GET", f"{PRINTIFY_BASE}/shops/{shop_id}/products.json",
            headers=_headers(), params={"limit": 50, "page": page}, timeout=60,
        )
        if r.status_code >= 400:
            print(f"[warm_default][cleanup] list page {page} failed: {r.status_code} {r.text[:160]}", flush=True)
            break
        body = r.json() or {}
        data = body.get("data") or body if isinstance(body, list) else (body.get("data") or [])
        if not data:
            break
        for prod in data:
            title = (prod.get("title") or "")
            if title.startswith("[MOCKUP-WARM]"):
                pid = prod.get("id")
                if not pid:
                    continue
                try:
                    dr = _printify_request(
                        "DELETE", f"{PRINTIFY_BASE}/shops/{shop_id}/products/{pid}.json",
                        headers=_headers(), timeout=60,
                    )
                    if dr.status_code < 400:
                        deleted += 1
                    else:
                        print(f"[warm_default][cleanup] delete {pid} failed: {dr.status_code}", flush=True)
                except Exception as e:
                    print(f"[warm_default][cleanup] delete {pid} error: {e}", flush=True)
                _time.sleep(0.3)
        # Stop if we've reached the last page (heuristic: < 50 items)
        if len(data) < 50:
            break
        page += 1
        if page > 20:  # safety cap
            break
    return deleted


def _phase_b_warm(image_id_cache):
    """Synchronously pre-render + cache real Printify mockups for every
    product in `_DEFAULT_MOCKUP_PRODUCTS`. Idempotent: skips products
    whose mockup file already exists on disk. Per-product try/except so
    one failure doesn't break the batch.

    `image_id_cache` is a one-item list used as a lazy holder for the
    uploaded image id — uploaded only when at least one product actually
    needs to be rendered.

    Returns a summary dict with counts + per-product status + the
    written manifest path."""
    # Lazy imports so module load order stays clean.
    from api.printify_routes import _printify_request, _headers, _shop_id, PRINTIFY_BASE
    import json, time, requests as _requests

    DEFAULT_MOCKUPS_DIR.mkdir(parents=True, exist_ok=True)

    # Load any existing manifest so re-runs preserve previous entries.
    manifest = {}
    if DEFAULT_MOCKUPS_MANIFEST.exists():
        try:
            manifest = json.loads(DEFAULT_MOCKUPS_MANIFEST.read_text()) or {}
        except Exception:
            manifest = {}

    def _ensure_uploaded():
        if image_id_cache[0]:
            return image_id_cache[0]
        b64 = _phase_b_load_default_image_b64()
        body = {"file_name": DEFAULT_HQ_FILENAME, "contents": b64}
        r = _printify_request(
            "POST", f"{PRINTIFY_BASE}/uploads/images.json",
            headers=_headers(), json=body, timeout=120,
        )
        if r.status_code >= 400:
            raise RuntimeError(f"Printify upload failed: {r.status_code} {r.text[:200]}")
        image_id_cache[0] = r.json().get("id")
        if not image_id_cache[0]:
            raise RuntimeError(f"Printify upload returned no id: {r.text[:200]}")
        return image_id_cache[0]

    created = 0
    skipped = 0
    failed = []
    per_product = []
    shop_id = _shop_id()

    # Clean up any orphan drafts from a previous failed warm run so we
    # don't accumulate "[MOCKUP-WARM]" garbage on the Printify dashboard.
    # Best-effort — a failure here doesn't block the actual warm.
    try:
        orphan_count = _phase_b_cleanup_orphan_drafts()
        if orphan_count:
            print(f"[warm_default][phase_b] cleaned {orphan_count} orphan draft(s) from prior run", flush=True)
    except Exception as _e:
        print(f"[warm_default][phase_b] orphan cleanup error (continuing): {_e}", flush=True)

    for prod in _DEFAULT_MOCKUP_PRODUCTS:
        pid = prod["id"]
        mock_path = DEFAULT_MOCKUPS_DIR / f"{pid}.png"
        status = {"id": pid}
        # Idempotent skip: file on disk AND manifest entry → done.
        if mock_path.exists() and mock_path.stat().st_size > 1000 and pid in manifest:
            skipped += 1
            status["status"] = "skipped_cached"
            per_product.append(status)
            continue

        # Pace ourselves so Printify doesn't rate-limit a 25-product blast.
        time.sleep(1.2)

        try:
            image_id = _ensure_uploaded()
            payload = {
                "title": f"[MOCKUP-WARM] Solar Archive default — {pid}",
                "description": "Auto-generated default mockup; will be deleted.",
                "blueprint_id": prod["blueprintId"],
                "print_provider_id": prod["printProviderId"],
                "variants": [{"id": prod["variantId"], "price": 100, "is_enabled": True}],
                "print_areas": [{
                    "variant_ids": [prod["variantId"]],
                    "placeholders": [{
                        "position": prod.get("position", "front"),
                        "images": [{"id": image_id, "x": 0.5, "y": 0.5, "scale": 1, "angle": 0}],
                    }],
                }],
            }
            # Reuse the same _expand_print_areas helper the public route uses,
            # so blueprints with multi-position panel layouts (crew socks,
            # journal, pillow) get all their placeholders filled.
            from api.printify_routes import _expand_print_areas
            payload = _expand_print_areas(payload)

            r = _printify_request(
                "POST", f"{PRINTIFY_BASE}/shops/{shop_id}/products.json",
                headers=_headers(), json=payload, timeout=120,
            )
            if r.status_code >= 400:
                raise RuntimeError(f"create failed: {r.status_code} {r.text[:200]}")
            product_json = r.json()
            printify_product_id = product_json.get("id")
            # try/finally: even if the download fails, we still attempt to
            # DELETE the draft so failed runs don't accumulate orphans.
            try:
                mockup_url = _phase_b_pick_mockup_url(product_json)
                if not mockup_url:
                    raise RuntimeError("create succeeded but no mockup images in response")
                # certifi-verified, retried download — plain requests.get
                # fails on this CDN because our process has SSL_CERT_FILE
                # pointed at a NASA-augmented bundle for VSO/FITS work.
                img_bytes = _phase_b_cdn_download(mockup_url)
                mock_path.write_bytes(img_bytes)
                manifest[pid] = {
                    "url": f"/asset/default/mockups/{pid}.png",
                    "size_bytes": mock_path.stat().st_size,
                    "source_mockup_url": mockup_url,
                }
                # Incremental manifest write: persists partial progress so a
                # Render edge-cut on a long-running warm doesn't lose
                # everything. Re-runs read this manifest + skip cached.
                try:
                    _tmp_mockup = DEFAULT_MOCKUPS_MANIFEST.with_suffix(".json.tmp"); _tmp_mockup.write_text(json.dumps(manifest, indent=2)); os.replace(_tmp_mockup, DEFAULT_MOCKUPS_MANIFEST)
                except Exception as _e:
                    print(f"[warm_default][phase_b] manifest incremental-write failed: {_e}", flush=True)
                created += 1
                status["status"] = "created"
                status["size_bytes"] = mock_path.stat().st_size
            finally:
                if printify_product_id:
                    try:
                        dr = _printify_request(
                            "DELETE",
                            f"{PRINTIFY_BASE}/shops/{shop_id}/products/{printify_product_id}.json",
                            headers=_headers(), timeout=60,
                        )
                        if dr.status_code >= 400:
                            print(f"[warm_default][phase_b] delete failed for {pid} ({printify_product_id}): "
                                  f"{dr.status_code} {dr.text[:120]}", flush=True)
                    except Exception as _e:
                        print(f"[warm_default][phase_b] delete error for {pid}: {_e}", flush=True)
        except Exception as e:
            failed.append({"id": pid, "error": str(e)[:240]})
            status["status"] = "failed"
            status["error"] = str(e)[:240]
        per_product.append(status)

    # Persist the manifest. Always rewrite (with any new entries merged in
    # via the existing dict).
    try:
        _tmp_mockup = DEFAULT_MOCKUPS_MANIFEST.with_suffix(".json.tmp"); _tmp_mockup.write_text(json.dumps(manifest, indent=2)); os.replace(_tmp_mockup, DEFAULT_MOCKUPS_MANIFEST)
    except Exception as e:
        print(f"[warm_default][phase_b] manifest write failed: {e}", flush=True)

    return {
        "phase": "B",
        "total_products": len(_DEFAULT_MOCKUP_PRODUCTS),
        "created": created,
        "skipped_cached": skipped,
        "failed": len(failed),
        "failures": failed,
        "manifest_url": "/asset/default/default_mockups.json",
        "per_product": per_product,
    }


@app.post("/api/admin/warm_default")
async def warm_default(request: Request):
    """Pre-render + cache the default-landing assets on the persistent disk.

    Currently warms Phase A only: the HQ-RHEF for the fixed default tuple
    (DEFAULT_LANDING_*). Idempotent: returns {ok, cached:true} if the
    persistent PNG already exists; otherwise runs the HQ pipeline (1–3 min
    cold) and writes it through to DEFAULT_CACHE_DIR so it survives deploys.

    The actual generation is offloaded to a thread so we don't block the
    asyncio loop for minutes. The HTTP request still waits for completion
    (no task-id polling yet) — for an admin operation triggered once per
    deploy, the few-minute wait is acceptable and gives a definitive
    success/failure response.
    """
    _check_warm_admin_key(request.headers.get("x-admin-key"))

    persistent_default = DEFAULT_CACHE_DIR / DEFAULT_HQ_FILENAME
    out_path_in_output = os.path.join(OUTPUT_DIR, DEFAULT_HQ_FILENAME)
    served_url = f"/asset/{DEFAULT_HQ_FILENAME}"

    phase_a_result = None
    # Fast path: already on the persistent disk → ensure it's also in
    # OUTPUT_DIR so /asset/ serves it without re-running the pipeline.
    if persistent_default.exists() and persistent_default.stat().st_size > 1000:
        if not os.path.exists(out_path_in_output) or os.path.getsize(out_path_in_output) <= 1000:
            try:
                import shutil
                os.makedirs(os.path.dirname(out_path_in_output), exist_ok=True)
                shutil.copy2(str(persistent_default), out_path_in_output)
            except Exception as e:
                print(f"[warm_default] OUTPUT_DIR sync failed: {e}", flush=True)
        phase_a_result = {
            "ok": True,
            "cached": True,
            "url": served_url,
            "persistent_path": str(persistent_default),
            "size_bytes": persistent_default.stat().st_size,
            "phase": "A",
        }

    # Cold path: run the HQ pipeline for the default tuple. do_generate_sync
    # is the same code path the public HQ task uses; we just call it
    # directly in a thread (no Printify, no auth — purely server-side
    # asset generation). On success it writes through to the persistent
    # cache (see the write-through block in do_generate_sync).
    if phase_a_result is None:
        try:
            dt = datetime.strptime(DEFAULT_LANDING_DATE, "%Y-%m-%d").replace(hour=12, minute=0)
            png_url = await asyncio.to_thread(
                do_generate_sync, dt,
                DEFAULT_LANDING_WAVELENGTH,
                DEFAULT_LANDING_MISSION,
                DEFAULT_LANDING_DETECTOR,
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Warm-default generation failed: {e}")
        # Re-check the persistent disk after generation — write-through should
        # have copied it; if not, raise rather than report a false success.
        if not (persistent_default.exists() and persistent_default.stat().st_size > 1000):
            raise HTTPException(
                status_code=500,
                detail=(
                    "Generation completed but write-through to persistent cache failed. "
                    "Check do_generate_sync's write-through block and DEFAULT_CACHE_DIR permissions."
                ),
            )
        phase_a_result = {
            "ok": True,
            "cached": False,
            "url": png_url,
            "persistent_path": str(persistent_default),
            "size_bytes": persistent_default.stat().st_size,
            "phase": "A",
        }

    # Phase B — pre-render real Printify mockups for every product using the
    # Phase A HQ image. Idempotent per product (skips cached ones), so a
    # client timeout can re-trigger and pick up where it left off. Runs in
    # a thread to avoid blocking the asyncio loop for the heavy Printify
    # orchestration.
    try:
        phase_b_result = await asyncio.to_thread(_phase_b_warm, [None])
    except Exception as e:
        # Phase B failed wholesale (likely Phase A image missing or
        # Printify creds). Return Phase A success + the B error so the
        # operator can fix and re-trigger.
        return {"phase_a": phase_a_result, "phase_b": {"phase": "B", "ok": False, "error": str(e)}}

    return {"phase_a": phase_a_result, "phase_b": phase_b_result}


# ──────────────────────────────────────────────────────────────────────
# Admin: warm the vibe-grid HQ images (Raw + RHEF, full + thumb)
# ──────────────────────────────────────────────────────────────────────
# Pre-renders the 5 landing-page "famous moments" cards (api/index.html
# L73–148). For each vibe we produce FOUR PNGs on the persistent disk:
#   raw_full.png   — RHEF-free HQ science PNG (gamma-stretched)
#   raw_thumb.png  — 256² downsample of raw_full
#   rhef_full.png  — RHEF-filtered HQ (same pipeline as do_generate_sync)
#   rhef_thumb.png — 256² downsample of rhef_full
# Thumbs are what the landing card displays; full-res is what loads when
# the user clicks into the editor. Manifest at /asset/default/vibe_manifest.json.
#
# Pipeline note: do_generate_sync always applies RHEF, so it can't double
# as the raw-tier renderer. The helper below fetches the FITS once via
# fido_fetch_map (cached on disk so a re-run is cheap), then renders raw
# and RHEF tiers from the same Map — saving a re-download per vibe.

def _resolve_vibe_grid_tuples():
    """All vibes are static now (the earlier dynamic recent_corona was
    swapped for limb_x82_flare at user request — see _VIBE_GRID_TUPLES
    comment). Function kept for API stability with the existing warm
    orchestrator."""
    return list(_VIBE_GRID_TUPLES)


def _vibe_pick_cmap(wavelength: int, mission: str):
    """AIA wavelength → SunPy-registered colormap. Mirrors map_to_png's
    instrument/wavelength dispatch but stripped down — we don't need the
    annotation / metadata logic here."""
    from sunpy.visualization.colormaps import color_tables as ct
    try:
        wl_int = int(wavelength)
    except Exception:
        wl_int = 211
    if mission.upper() == "SDO" and wl_int in [94, 131, 171, 193, 211, 304, 335, 1600, 1700, 4500]:
        try:
            return ct.aia_color_table(wl_int * u.angstrom)
        except Exception:
            pass
    if mission.upper() == "SOHO-EIT":
        if wl_int == 195:
            return plt.get_cmap("sohoeit195")
    try:
        return plt.get_cmap(f"sdoaia{wl_int}")
    except Exception:
        return plt.get_cmap("gray")


def _vibe_render_array_to_png(data, out_path: str, cmap, gamma: float = None):
    """Write a 2D array to a square borderless PNG at the same dpi/size
    do_generate_sync uses (10in × 300dpi ≈ 3000²).

    `gamma` (optional) applies a PowerNorm display stretch with the given
    exponent: gamma=1/2.2 ≈ 0.4545 is the sRGB-display convention and the
    near-equivalent of sqrt (gamma=0.5) commonly seen in AIA papers.
    Without it, raw FITS data has linear percentile clipping — fine for
    RHEF (which already shapes the histogram) but the corona looks too
    contrasty for an "Original" preview. Default None preserves the
    linear pre-2026-05 behavior for any caller not opting in.
    """
    import numpy as _np
    import matplotlib.colors as _mc
    # LAUNCH-BLOCKER fix (workflow wx5fi2brl, rhef-oom-512mb):
    # downcast to float32 if not already — halves memory vs float64
    # (4096² float64 = 128 MB; float32 = 64 MB). matplotlib's colormap
    # path doesn't care which dtype it gets. The free-tier OOM trigger
    # was holding 2× float64 copies during PowerNorm; this cuts it.
    arr = _np.asarray(data)
    if arr.dtype != _np.float32 and arr.dtype.kind == "f":
        arr = arr.astype(_np.float32, copy=False)
    finite = arr[_np.isfinite(arr)]
    if finite.size == 0:
        vmin, vmax = 0.0, 1.0
    else:
        vmin = _np.nanpercentile(arr, 1)
        vmax = _np.nanpercentile(arr, 99.7)
        if not _np.isfinite(vmin) or not _np.isfinite(vmax) or vmax <= vmin:
            vmin, vmax = float(finite.min()), float(finite.max() or finite.min() + 1.0)
    fig = plt.figure(figsize=(10, 10), dpi=300)
    plt.axis("off")
    if gamma is not None and gamma > 0:
        # PowerNorm maps (data - vmin) / (vmax - vmin) → x, then x ** gamma
        # before colormap mapping. clip=True suppresses out-of-range values
        # (some FITS frames have negative speckle below the 1st percentile
        # that PowerNorm would otherwise warn about).
        plt.imshow(arr, cmap=cmap, origin="lower",
                   norm=_mc.PowerNorm(gamma=gamma, vmin=vmin, vmax=vmax, clip=True))
    else:
        plt.imshow(arr, cmap=cmap, vmin=vmin, vmax=vmax, origin="lower")
    plt.tight_layout(pad=0)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    plt.savefig(out_path, bbox_inches="tight", pad_inches=0)
    plt.close(fig)


# sRGB-display gamma. 1/2.2 ≈ 0.4545. Visually indistinguishable from
# sqrt (0.5) and matches what AIA images look like in journal figures.
_AIA_DISPLAY_GAMMA = 1.0 / 2.2


def _vibe_write_thumb(full_path: str, thumb_path: str, size: int = 256):
    """Downsample full-res PNG to a `size`² thumbnail via Pillow."""
    from PIL import Image
    with Image.open(full_path) as im:
        im = im.convert("RGB")
        im.thumbnail((size, size), Image.LANCZOS)
        # Force exact square by pasting onto a black canvas if needed
        # (Pillow's thumbnail preserves aspect ratio — our full pngs are
        # already square so this is a no-op, but keeps the contract).
        if im.size != (size, size):
            canvas = Image.new("RGB", (size, size), (0, 0, 0))
            x = (size - im.size[0]) // 2
            y = (size - im.size[1]) // 2
            canvas.paste(im, (x, y))
            im = canvas
        os.makedirs(os.path.dirname(thumb_path), exist_ok=True)
        im.save(thumb_path, format="PNG", optimize=True)


def _render_vibe_pair(vibe: dict) -> dict:
    """Render Raw + RHEF (full + thumb) for one vibe. Returns the manifest
    sub-entry. Raises on fatal failures so the orchestrator can mark the
    vibe failed without taking down siblings."""
    import ssl as _ssl, certifi as _certifi
    os.environ["SSL_CERT_FILE"] = os.getenv("SSL_CERT_FILE", _certifi.where())
    os.environ["REQUESTS_CA_BUNDLE"] = os.getenv("REQUESTS_CA_BUNDLE", _certifi.where())
    _ssl._create_default_https_context = _ssl._create_unverified_context

    slug = vibe["slug"]
    date_str = vibe["date"]
    wl = int(vibe["wavelength"])
    mission = vibe["mission"]
    detector = vibe["detector"]
    time_str = vibe.get("time", "12:00")

    out_dir = DEFAULT_VIBE_DIR / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_full = out_dir / "raw_full.png"
    raw_thumb = out_dir / "raw_thumb.png"
    rhef_full = out_dir / "rhef_full.png"
    rhef_thumb = out_dir / "rhef_thumb.png"

    entry = {
        "date": date_str,
        "wavelength": wl,
        "time": time_str,
        "mission": mission,
        "detector": detector,
        "raw_full_url":   f"/asset/default/vibe/{slug}/raw_full.png",
        "raw_thumb_url":  f"/asset/default/vibe/{slug}/raw_thumb.png",
        "rhef_full_url":  f"/asset/default/vibe/{slug}/rhef_full.png",
        "rhef_thumb_url": f"/asset/default/vibe/{slug}/rhef_thumb.png",
    }

    # Idempotent skip: both full-res tiers already on disk → we're done.
    # (Thumbs are derived from full; we always re-derive them below if a
    # full was regenerated. If a thumb is missing but its full is present,
    # we re-derive the thumb without re-running the heavy pipeline.)
    both_full_present = (
        raw_full.exists() and raw_full.stat().st_size > 1000
        and rhef_full.exists() and rhef_full.stat().st_size > 1000
    )
    if both_full_present:
        # Backfill thumbs if missing
        if not (raw_thumb.exists() and raw_thumb.stat().st_size > 100):
            _vibe_write_thumb(str(raw_full), str(raw_thumb))
        if not (rhef_thumb.exists() and rhef_thumb.stat().st_size > 100):
            _vibe_write_thumb(str(rhef_full), str(rhef_thumb))
        entry["ok"] = True
        entry["status"] = "skipped_cached"
        return entry

    # Build the datetime carrying the user-picked time (mirrors the
    # date+time folding /api/generate does in start_generate).
    try:
        hh, mm = time_str.split(":")
        dt = datetime.strptime(date_str, "%Y-%m-%d").replace(
            hour=max(0, min(23, int(hh))),
            minute=max(0, min(59, int(mm))),
        )
    except Exception:
        dt = datetime.strptime(date_str, "%Y-%m-%d").replace(hour=12, minute=0)

    print(f"[warm_vibe_grid] {slug}: fetching FITS for {date_str}T{time_str} {mission} {wl}Å", flush=True)
    smap = fido_fetch_map(dt, mission, wl, detector)

    cmap = _vibe_pick_cmap(wl, mission)

    # ── Raw tier ("Original" in the frontend toggle): apply sRGB display
    # gamma (1/2.2). This matches the AIA-paper convention: linear FITS
    # data has too much dynamic range for direct percentile-clipped display
    # (corona looks crushed, flare cores blow out). Gamma 0.45 lifts the
    # mid-tones the way the human visual system expects. ──────────────
    if not (raw_full.exists() and raw_full.stat().st_size > 1000):
        print(f"[warm_vibe_grid] {slug}: rendering RAW full (gamma={_AIA_DISPLAY_GAMMA:.3f}) → {raw_full}", flush=True)
        _vibe_render_array_to_png(smap.data, str(raw_full), cmap, gamma=_AIA_DISPLAY_GAMMA)
    _vibe_write_thumb(str(raw_full), str(raw_thumb))

    # ── RHEF tier: NO gamma. RHEF already flattens the histogram via
    # radial-percentile equalization; adding gamma on top would distort
    # the equalized distribution. ─────────────────────────────────────
    if not (rhef_full.exists() and rhef_full.stat().st_size > 1000):
        print(f"[warm_vibe_grid] {slug}: applying RHEF + rendering → {rhef_full}", flush=True)
        try:
            rhef_map = rhef(smap, progress=False)
            rhef_data = rhef_map.data
        except Exception as e:
            print(f"[warm_vibe_grid] {slug}: RHEF on Map failed ({e}); falling back to array path", flush=True)
            rhef_data = rhef(smap.data, progress=False).data
        _vibe_render_array_to_png(rhef_data, str(rhef_full), cmap)
    _vibe_write_thumb(str(rhef_full), str(rhef_thumb))

    entry["ok"] = True
    entry["status"] = "created"
    return entry


def _warm_vibe_grid(force: bool = False) -> dict:
    """Sync orchestrator — renders every vibe sequentially. Per-vibe
    try/except so one bad render doesn't sink the others. Writes the
    manifest incrementally so a process restart mid-warm leaves a valid
    (partial) manifest behind.

    `force=True` deletes every existing vibe file + the manifest before
    starting, so a tuple-list change (e.g. swapping wavelengths from
    131→211 for the X-flare cards) actually gets re-rendered instead of
    being skipped as already-cached."""
    DEFAULT_VIBE_DIR.mkdir(parents=True, exist_ok=True)
    if force:
        try:
            import shutil
            if DEFAULT_VIBE_DIR.exists():
                shutil.rmtree(DEFAULT_VIBE_DIR)
            DEFAULT_VIBE_DIR.mkdir(parents=True, exist_ok=True)
            if DEFAULT_VIBE_MANIFEST.exists():
                DEFAULT_VIBE_MANIFEST.unlink()
            print(f"[warm_vibe_grid] force=1 — purged vibe cache + manifest", flush=True)
        except Exception as e:
            print(f"[warm_vibe_grid] force purge failed (continuing): {e}", flush=True)

    vibes = _resolve_vibe_grid_tuples()
    print(f"[warm_vibe_grid] starting warm of {len(vibes)} vibes (force={force})", flush=True)

    per_vibe = []
    warmed = 0
    skipped = 0
    failed = 0
    manifest_vibes: Dict[str, Any] = {}

    # Preserve any pre-existing manifest entries (e.g. a previous warm
    # populated some slugs; re-run picks up where it left off). Skipped
    # when force=True since the cache was just nuked.
    if not force and DEFAULT_VIBE_MANIFEST.exists():
        try:
            prev = json.loads(DEFAULT_VIBE_MANIFEST.read_text())
            manifest_vibes = dict((prev or {}).get("vibes") or {})
        except Exception:
            manifest_vibes = {}

    for vibe in vibes:
        slug = vibe["slug"]
        try:
            entry = _render_vibe_pair(vibe)
            if entry.get("status") == "skipped_cached":
                skipped += 1
            else:
                warmed += 1
            manifest_vibes[slug] = entry
            per_vibe.append({"slug": slug, "status": entry.get("status", "ok"), "ok": True})
        except Exception as e:
            failed += 1
            err = str(e)[:240]
            print(f"[warm_vibe_grid] {slug}: FAILED — {err}", flush=True)
            manifest_vibes[slug] = {
                "date": vibe.get("date"),
                "wavelength": vibe.get("wavelength"),
                "time": vibe.get("time"),
                "ok": False,
                "error": err,
            }
            per_vibe.append({"slug": slug, "status": "failed", "ok": False, "error": err})

        # Incremental manifest write — survives mid-run process death.
        # NEEDS-FIX (workflow wx5fi2brl, manifest-non-atomic-writes):
        # write to .tmp then os.replace so a concurrent reader can never
        # observe a partial JSON file. os.replace is atomic on POSIX +
        # Windows; same primitive used by the bundle-upload path.
        try:
            payload = json.dumps({
                "generated_at": datetime.utcnow().isoformat() + "Z",
                "vibes": manifest_vibes,
            }, indent=2)
            tmp = DEFAULT_VIBE_MANIFEST.with_suffix(".json.tmp")
            tmp.write_text(payload)
            os.replace(tmp, DEFAULT_VIBE_MANIFEST)
        except Exception as e:
            print(f"[warm_vibe_grid] manifest incremental-write failed: {e}", flush=True)

    print(f"[warm_vibe_grid] done — warmed={warmed} skipped={skipped} failed={failed}", flush=True)
    return {
        "ok": failed == 0,
        "warmed": warmed,
        "skipped": skipped,
        "failed": failed,
        "per_vibe": per_vibe,
        "manifest_url": "/asset/default/vibe_manifest.json",
    }


@app.post("/api/admin/warm_vibe_grid")
async def warm_vibe_grid(request: Request, force: int = 0):
    """Pre-render the landing-page vibe-grid tiles (Raw + RHEF, full +
    thumb) to the persistent disk. Gated by FEEDBACK_ADMIN_KEY.

        source ~/.claude/secrets/solar-archive.env
        curl -X POST -H "X-Admin-Key: $FEEDBACK_ADMIN_KEY" \
            "https://solar-archive.onrender.com/api/admin/warm_vibe_grid?force=1"

    Each vibe takes 1–3 min cold; the full warm runs 20+ min sequentially.
    Idempotent — re-running picks up any vibe whose both `*_full.png`
    files aren't on disk yet. Pass `?force=1` to purge the existing
    cache + manifest first (use after changing tuple wavelengths so the
    new renders actually get written). Held under the heavy-render
    semaphore so we don't fight a concurrent /api/generate for memory.

    **NOTE:** On Render's 2 GB Standard instance this routinely OOMs
    on the RHEF step (a 4096² float64 array + matplotlib at 300dpi
    flirts with the limit and gets killed by the kernel mid-render).
    Prefer `POST /api/admin/upload_vibe_bundle` from a local machine
    with more headroom; see that route's docstring."""
    _check_warm_admin_key(request.headers.get("x-admin-key"))
    async with _HeavyRenderSlot():
        try:
            result = await asyncio.to_thread(_warm_vibe_grid, bool(force))
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"warm_vibe_grid failed: {e}")
    return result


# ──────────────────────────────────────────────────────────────────────
# Upload pre-rendered vibe bundle from a local machine.
# Workaround for Render's 2 GB OOM on the warm route: render the
# tiles on a beefier dev box, tar them up, POST the tar here. Server
# just extracts under DEFAULT_CACHE_DIR — no heavy compute, no
# semaphore contention.
# ──────────────────────────────────────────────────────────────────────

# Cap upload at 1 GB. Originally 200 MB (sized for the 5-vibe HQ bundle
# = ~100 MB); bumped to handle the 11-vibe Raw+RHEF MQ bundle which
# runs ~600 MB — RHEF PNGs have high entropy (every pixel carries
# information after the radial histogram equalization) so they
# compress poorly compared to smooth Raw images. A 1 GB ceiling
# still bounds the worst case but covers the realistic warm-and-ship
# bundles for the foreseeable future.
_VIBE_BUNDLE_MAX_BYTES = 1024 * 1024 * 1024
# Permit only these path prefixes inside the tar (everything else is
# rejected so a malicious bundle can't write outside the vibe cache).
_VIBE_BUNDLE_ALLOWED_PREFIXES = ("vibe/", "vibe_manifest.json")


@app.post("/api/admin/upload_vibe_bundle")
async def upload_vibe_bundle(request: Request):
    """Accept a tar (or tar.gz) of the vibe/ directory + vibe_manifest.json,
    extract it under DEFAULT_CACHE_DIR. Gated by FEEDBACK_ADMIN_KEY.

    Use when the on-server warm route OOMs (Render's 2 GB Standard
    instance can't hold a 4096² float64 RHEF array + matplotlib +
    SunPy + the Python interpreter without the kernel killing it).
    Render the bundle on a machine with headroom, ship it here:

        source ~/.claude/secrets/solar-archive.env
        # 1. Render locally
        curl -X POST -H "X-Admin-Key: $FEEDBACK_ADMIN_KEY" \
            "http://localhost:8000/api/admin/warm_vibe_grid?force=1"
        # 2. Bundle
        cd default_cache && tar czf /tmp/vibe_bundle.tar.gz vibe vibe_manifest.json
        # 3. Ship
        curl -X POST -H "X-Admin-Key: $FEEDBACK_ADMIN_KEY" \
            --data-binary @/tmp/vibe_bundle.tar.gz \
            -H "Content-Type: application/gzip" \
            "https://solar-archive.onrender.com/api/admin/upload_vibe_bundle"

    The wrapper script `scripts/warm_and_upload_vibe.sh` does all three.

    Safety: rejects any tar entry whose normalised path escapes
    DEFAULT_CACHE_DIR, isn't under `vibe/` or the manifest filename,
    or is a symlink/hardlink/device node. Replaces the manifest
    atomically; replaces individual vibe files in place. Bundle size
    capped at 200 MB."""
    _check_warm_admin_key(request.headers.get("x-admin-key"))

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body — POST a tar(.gz) of vibe/ + vibe_manifest.json")
    if len(body) > _VIBE_BUNDLE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"bundle too large ({len(body)} bytes > {_VIBE_BUNDLE_MAX_BYTES})",
        )

    import io as _io
    import tarfile as _tarfile
    import shutil as _shutil

    DEFAULT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target_root = DEFAULT_CACHE_DIR.resolve()
    extracted = []
    rejected = []

    # Open tar in read-mode auto-detecting gzip vs plain. Stream from
    # memory so we don't write the upload to disk twice.
    try:
        with _tarfile.open(fileobj=_io.BytesIO(body), mode="r:*") as tf:
            for member in tf.getmembers():
                # Path safety: only regular files + dirs; reject links
                # and devices; reject anything that escapes target_root.
                if not (member.isfile() or member.isdir()):
                    rejected.append({"name": member.name, "reason": "not a regular file/dir"})
                    continue
                name = member.name.lstrip("./")
                if not any(name == p or name.startswith(p) for p in _VIBE_BUNDLE_ALLOWED_PREFIXES):
                    rejected.append({"name": member.name, "reason": "path outside vibe/ or vibe_manifest.json"})
                    continue
                dst = (target_root / name).resolve()
                try:
                    dst.relative_to(target_root)
                except ValueError:
                    rejected.append({"name": member.name, "reason": "resolves outside target root"})
                    continue
                if member.isdir():
                    dst.mkdir(parents=True, exist_ok=True)
                    continue
                # Regular file — extract directly.
                dst.parent.mkdir(parents=True, exist_ok=True)
                src = tf.extractfile(member)
                if src is None:
                    rejected.append({"name": member.name, "reason": "extractfile returned None"})
                    continue
                with open(dst, "wb") as out:
                    _shutil.copyfileobj(src, out, length=64 * 1024)
                extracted.append({"name": name, "bytes": dst.stat().st_size})
    except _tarfile.TarError as e:
        raise HTTPException(status_code=400, detail=f"tar error: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"extract failed: {type(e).__name__}: {e}")

    return {
        "ok": True,
        "extracted_count": len(extracted),
        "rejected_count": len(rejected),
        "extracted": extracted,
        "rejected": rejected or None,
        "manifest_url": "/asset/default/vibe_manifest.json",
    }


# ──────────────────────────────────────────────────────────────────────
# HEK "best time of day" — auto-fill the time picker per date.
# Lookup helper + per-date JSON cache live in api/hek_routes.py;
# cache is rooted at the same persistent disk dir as the default-image
# cache so HEK queries (2–10s) survive deploys.
# ──────────────────────────────────────────────────────────────────────
from api.hek_routes import register_hek_routes as _register_hek_routes
_register_hek_routes(app, DEFAULT_CACHE_DIR)


# Legacy /static mount (kept for backward compatibility)
app.mount("/static", StaticFiles(directory=str(app_dir), html=True), name="static_legacy")



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

@app.get("/shopify/launch")
async def shopify_launch():
    """Redirect legacy Shopify launch URL to main frontend."""
    return RedirectResponse(url="/", status_code=302)


@app.get("/redirect_to_shopify")
async def redirect_to_shopify(request: Request):
    """Redirects the user to a Shopify product/collection URL."""
    image_url = request.query_params.get("image_url")
    if not image_url:
        raise HTTPException(status_code=400, detail="image_url parameter is required")
    encoded_image_url = quote_plus(image_url)
    shopify_url = f"https://solar-archive.myshopify.com/apps/solar-render?image_url={encoded_image_url}"
    return RedirectResponse(url=shopify_url, status_code=302)







@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve the main customer-facing index.html."""
    return FileResponse(Path(__file__).parent / "index.html")


# LAUNCH-BLOCKER fix (workflow wx5fi2brl, missing-legal-policies):
# Four static policy pages (Privacy / Terms / Refund / Shipping) so
# Shopify Payments + Stripe will operate without dispute freeze. Drafted
# as boilerplate marked "NOT LEGAL ADVICE — review before launch".
# Explicit routes per slug so /privacy / /terms / /refund / /shipping
# don't conflict with the /{module_name} JS-module dispatcher below.
# Static SEO + discoverability assets — robots.txt, sitemap.xml, favicon.
@app.get("/robots.txt")
async def robots_txt():
    return FileResponse(Path(__file__).parent / "robots.txt", media_type="text/plain")

@app.get("/sitemap.xml")
async def sitemap_xml():
    return FileResponse(Path(__file__).parent / "sitemap.xml", media_type="application/xml")

@app.get("/favicon.svg")
async def favicon_svg():
    return FileResponse(Path(__file__).parent / "favicon.svg", media_type="image/svg+xml")

@app.get("/favicon.ico")
async def favicon_ico():
    # Browsers expect /favicon.ico — serve the SVG and let the browser
    # decide (modern browsers prefer the linked SVG; older ones tolerate
    # the SVG response under .ico mime).
    return FileResponse(Path(__file__).parent / "favicon.svg", media_type="image/svg+xml")


@app.get("/privacy", response_class=HTMLResponse)
async def legal_privacy():
    return FileResponse(Path(__file__).parent / "legal" / "privacy.html")

@app.get("/terms", response_class=HTMLResponse)
async def legal_terms():
    return FileResponse(Path(__file__).parent / "legal" / "terms.html")

@app.get("/refund", response_class=HTMLResponse)
async def legal_refund():
    return FileResponse(Path(__file__).parent / "legal" / "refund.html")

@app.get("/shipping", response_class=HTMLResponse)
async def legal_shipping():
    return FileResponse(Path(__file__).parent / "legal" / "shipping.html")


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
def debug_vso(x_admin_key: Optional[str] = Header(None)):
    """
    Direct VSO connectivity test.
    Forces a fresh VSOClient connection and prints providers + results.

    LAUNCH-READINESS fix (workflow wx5fi2brl, debug-routes-unauth):
    every /debug/* route now requires X-Admin-Key so an outsider can't
    enumerate the server's environment or filesystem.
    """
    _check_warm_admin_key(x_admin_key)
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
def debug_vso_download_test(x_admin_key: Optional[str] = Header(None)):
    """
    Attempts to download a small file from VSO (using the same query as /debug/vso).
    Returns success if a file is downloaded to the temp directory.

    Admin-only (X-Admin-Key) — debug-routes-unauth fix.
    """
    _check_warm_admin_key(x_admin_key)
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
def debug_env(x_admin_key: Optional[str] = Header(None)):
    """Admin-only (X-Admin-Key) — debug-routes-unauth fix."""
    _check_warm_admin_key(x_admin_key)
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
    time: Optional[str] = Field("12:00", description="HH:MM (UTC). Defaults to 12:00 for back-compat.")
    mission: Optional[Literal["SDO", "SOHO-EIT", "SOHO-LASCO"]] = "SDO"
    wavelength: Optional[int] = Field(None, description="Angstroms for AIA/EIT (e.g., 211 or 195)")
    detector: Optional[Literal["AIA", "C2", "C3"]] = "AIA"
    dry_run: bool = False
    annotate: bool = True
    png_dpi: int = 300
    png_size_inches: float = 10.0  # square figure size; 10in at 300dpi → 3000px
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
async def list_output(x_admin_key: Optional[str] = Header(None)):
    """Admin-only (X-Admin-Key) — debug-routes-unauth fix."""
    _check_warm_admin_key(x_admin_key)
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

    # Small search window to find nearest frame on that date. Anchored to
    # noon UTC so SOHO-EIT / LASCO queries land on the same instant as
    # the SDO/AIA path (and the Helioviewer JPG preview), keeping all
    # backends consistent for a date-only request.
    t0 = dt.replace(hour=12, minute=0, second=0, microsecond=0)
    t1 = t0 + timedelta(minutes=2)

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
        dl = get_downloader()
        log_to_queue("[fetch][AIA] Using get_downloader() (parfive 2.2.0 compatible, non-zero timeouts).")

        # from sunpy.net.vso import VSOClient

        # Enforce HTTPS for VSO URL

        # Honour the user-picked time if `dt` already carries hours/
        # minutes; otherwise fall back to noon UTC (the historical
        # default — keeps API callers without a time field aligned with
        # the JPG preview, which also still defaults to noon).
        if dt.hour == 0 and dt.minute == 0 and dt.second == 0:
            dt_query = dt.replace(hour=12, minute=0, second=0, microsecond=0)
        else:
            dt_query = dt.replace(second=0, microsecond=0)
        _VSO_LIMITER.wait()
        qr = client.search(
                a.Time(dt_query, dt_query + timedelta(minutes=2)),
                a.Detector("AIA"),
                a.Wavelength(wavelength * u.angstrom),
                a.Source("SDO"),
        )

        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            log_to_queue(f"[fetch] [AIA] No VSO results found in ±1min, retrying ±10min...")
            _VSO_LIMITER.wait()
            qr = Fido.search(
                a.Time(dt_query - timedelta(minutes=10), dt_query + timedelta(minutes=10)),
                a.Detector("AIA"), a.Provider("VSO"),
                a.Source("SDO"),
                a.Wavelength(wl * u.angstrom),
            )
        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            log_to_queue(f"[fetch] [AIA] No VSO results in ±10min, retrying ±1 day...")
            _VSO_LIMITER.wait()
            qr = Fido.search(
                a.Time(dt_query - timedelta(days=1), dt_query + timedelta(days=1)),
                a.Detector("AIA"), a.Provider("VSO"),
                a.Source("SDO"),
                a.Wavelength(wl * u.angstrom),
            )
        if len(qr) == 0 or all(len(resp) == 0 for resp in qr):
            log_to_queue(f"[fetch] [AIA] No VSO results in ±1 day. SDO/AIA coverage: 2010-06 to present.")
            raise HTTPException(
                status_code=502,
                detail="No VSO data available for this date. SDO/AIA coverage is from mid-2010 to present; try a date in that range.",
            )
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
        # Note: Map is imported at module scope. Do NOT re-import it here — a local
        # re-import would make `Map` a function-local name throughout fido_fetch_map,
        # and the earlier references at lines ~1369/1372 would then raise
        # UnboundLocalError before reaching this point.
        import numpy as np
        import gc
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
    # Noon-anchored to match the JPG preview and the rest of the FITS
    # query paths in this module — see _generate_preview_sync and
    # fido_fetch_map for the same convention.
    t0 = dt.replace(hour=12, minute=0, second=0, microsecond=0)
    t1 = t0 + timedelta(minutes=2)
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
# Dedicated endpoint to serve image assets (preview RHE + HQ) so Render serves correctly
# -------------------------------------------------------------------
@app.get("/asset/preview/{filename:path}")
async def serve_preview_asset(filename: str):
    """Serve RHE preview PNGs from PREVIEW_DIR. Used when StaticFiles mount is not enough (e.g. Render)."""
    safe_path = os.path.normpath(filename)
    if ".." in safe_path or os.path.isabs(safe_path):
        raise HTTPException(status_code=400, detail="Invalid path")
    file_path = os.path.join(PREVIEW_DIR, safe_path)
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Preview not found")
    return FileResponse(
        file_path,
        media_type="image/png",
        headers={**CORS_HEADERS, "Cache-Control": "public, max-age=300"},
    )


@app.get("/asset/{subpath:path}")
async def serve_asset(subpath: str):
    """Serve any file under OUTPUT_DIR, including previews and HQ renders."""
    file_path = os.path.join(OUTPUT_DIR, subpath)
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(file_path, media_type="image/png", headers={**CORS_HEADERS, "Cache-Control": "no-cache"})


# -------------------------------------------------------------------
# LAUNCH-BLOCKER fix (workflow wx5fi2brl, static-assets-no-cache):
# JS + CSS get a long-lived cache + content-hash query-string version
# busting (the index.html ?v=... links). Cuts ~215 KB gzip of repeated
# downloads per page load against the cold-start origin. index.html
# still gets no-cache so deploys propagate immediately.
# -------------------------------------------------------------------
_NO_CACHE_HEADERS = {"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache"}
_LONG_CACHE_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}

def _asset_cache_headers(request) -> dict:
    """If the URL carries a ?v=<hash> query the file is content-versioned →
    return long-cache headers. Without a version it's a direct fetch →
    no-cache so dev edits don't get stuck."""
    if request.query_params.get("v"):
        return _LONG_CACHE_HEADERS
    return _NO_CACHE_HEADERS

@app.get("/solar-archive.js")
async def serve_js(request: Request):
    return FileResponse(
        Path(__file__).parent / "solar-archive.js",
        media_type="application/javascript",
        headers=_asset_cache_headers(request),
    )

@app.get("/solar-archive.css")
async def serve_css(request: Request):
    return FileResponse(
        Path(__file__).parent / "solar-archive.css",
        media_type="text/css",
        headers=_asset_cache_headers(request),
    )

# ES-module siblings of solar-archive.js. The module's `import "./foo.js"`
# resolves to `/foo.js`, so each extracted module needs its own route at
# the root path. Whitelisted (rather than a catch-all on /{name}.js) to
# avoid serving arbitrary files under api/ if a path-traversal sneaks in.
_FRONTEND_MODULES = {
    "state.js",
    "products.js",
    "colors.js",
    "mockups.js",
    "feedback.js",
    "stats.js",
    "bundler.js",
}

@app.get("/{module_name}")
async def serve_frontend_module(module_name: str, request: Request):
    if module_name not in _FRONTEND_MODULES:
        raise HTTPException(status_code=404)
    return FileResponse(
        Path(__file__).parent / module_name,
        media_type="application/javascript",
        headers=_asset_cache_headers(request),
    )