"""
Printify API proxy routes for Solar Archive.

Drop this file into your webapp/api/ directory alongside printful_routes.py,
then add these two lines to main.py (near where printful_routes is imported):

    from api import printify_routes
    app.include_router(printify_routes.router, prefix="/api")

Environment variables required:
    PRINTIFY_API_KEY  — your Printify personal access token
    PRINTIFY_SHOP_ID  — your Printify shop ID (find via GET /v1/shops.json)
"""

import os
import time
import requests
import certifi
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
import sys
import logging

router = APIRouter(prefix="/printify", tags=["Printify"])

PRINTIFY_API_KEY = os.getenv("PRINTIFY_API_KEY", "")
PRINTIFY_SHOP_ID = os.getenv("PRINTIFY_SHOP_ID", "")
PRINTIFY_BASE = "https://api.printify.com/v1"


def _log(msg: str):
    print(msg, flush=True)
    sys.stdout.flush()


def _headers():
    key = PRINTIFY_API_KEY or os.getenv("PRINTIFY_API_KEY", "")
    if not key:
        raise RuntimeError("PRINTIFY_API_KEY is not set in the environment")
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "SolarArchive/1.0",
    }


def _shop_id():
    sid = PRINTIFY_SHOP_ID or os.getenv("PRINTIFY_SHOP_ID", "")
    if not sid:
        raise RuntimeError(
            "PRINTIFY_SHOP_ID is not set. "
            "Run GET https://api.printify.com/v1/shops.json with your token to find it."
        )
    return sid


def _post_with_retry(url, payload, timeout=120, max_retries=3):
    """POST to Printify with retry on timeout/connection errors."""
    last_err = None
    for attempt in range(max_retries):
        try:
            resp = requests.post(
                url,
                headers=_headers(),
                json=payload,
                verify=certifi.where(),
                timeout=timeout,
            )
            return resp
        except (requests.exceptions.ReadTimeout,
                requests.exceptions.ConnectionError) as e:
            last_err = e
            wait = 3 * (attempt + 1)
            _log(f"[printify] Retry {attempt+1}/{max_retries} after {type(e).__name__}, waiting {wait}s...")
            if attempt < max_retries - 1:
                time.sleep(wait)
                continue
            raise last_err


# ────────────────────────────────────────────────
# 1a.  Upload image via URL
# ────────────────────────────────────────────────
@router.post("/upload")
async def upload_image(request: Request):
    """
    Proxies an image upload to Printify via URL.
    Expects JSON body: { "file_name": "...", "url": "https://..." }
    """
    try:
        body = await request.json()
        url = body.get("url")
        file_name = body.get("file_name") or "solar_image.png"

        if not url:
            raise HTTPException(status_code=400, detail="Missing 'url' field.")

        # Rewrite localhost URLs to Render domain when deployed
        render_env = os.getenv("RENDER")
        if render_env or url.startswith("http://127.0.0.1") or url.startswith("http://localhost"):
            import re
            url = re.sub(
                r"^http://(127\.0\.0\.1|localhost)(:\d+)?",
                "https://solar-archive.onrender.com",
                url,
            )
            _log(f"[printify][upload] Rewrote URL -> {url}")

        payload = {"file_name": file_name, "url": url}
        _log(f"[printify][upload] POST /v1/uploads/images.json  payload={payload}")

        resp = _post_with_retry(
            f"{PRINTIFY_BASE}/uploads/images.json",
            payload,
            timeout=120,
            max_retries=3,
        )

        _log(f"[printify][upload] Response {resp.status_code}: {resp.text[:500]}")

        if resp.status_code not in (200, 201):
            raise Exception(f"Printify upload failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        if not result.get("id"):
            raise Exception("No 'id' in Printify upload response")

        return JSONResponse(content=result)

    except HTTPException:
        raise
    except Exception as e:
        err = f"Upload failed: {e}"
        _log(f"[printify][upload] ERROR: {err}")
        return JSONResponse(status_code=500, content={"detail": err})


# ────────────────────────────────────────────────
# 1b.  Upload image via base64 (more reliable)
# ────────────────────────────────────────────────
@router.post("/upload-base64")
async def upload_image_base64(request: Request):
    """
    Proxies a base64 image upload to Printify.
    Expects JSON body: { "file_name": "...", "contents": "<base64-string>" }
    This avoids Printify needing to download from our server (which may be sleeping).
    """
    try:
        body = await request.json()
        contents = body.get("contents")
        file_name = body.get("file_name") or "solar_image.png"

        if not contents:
            raise HTTPException(status_code=400, detail="Missing 'contents' field.")

        approx_mb = len(contents) * 3 / 4 / 1024 / 1024
        _log(f"[printify][upload-base64] file={file_name} ~{approx_mb:.1f}MB decoded")

        if approx_mb > 20:
            raise HTTPException(
                status_code=400,
                detail=f"Image too large for base64 upload (~{approx_mb:.0f}MB). Use URL upload instead."
            )

        payload = {"file_name": file_name, "contents": contents}

        resp = _post_with_retry(
            f"{PRINTIFY_BASE}/uploads/images.json",
            payload,
            timeout=180,
            max_retries=2,
        )

        _log(f"[printify][upload-base64] Response {resp.status_code}: {resp.text[:500]}")

        if resp.status_code not in (200, 201):
            raise Exception(f"Printify base64 upload failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        if not result.get("id"):
            raise Exception("No 'id' in Printify upload response")

        return JSONResponse(content=result)

    except HTTPException:
        raise
    except Exception as e:
        err = f"Base64 upload failed: {e}"
        _log(f"[printify][upload-base64] ERROR: {err}")
        return JSONResponse(status_code=500, content={"detail": err})


# ────────────────────────────────────────────────
# 2.  Create a product in the Printify shop
# ────────────────────────────────────────────────
@router.post("/product")
async def create_product(request: Request):
    """
    Creates a product in the merchant's Printify shop.
    Returns the product including generated mockup images.
    """
    try:
        body = await request.json()
        shop_id = _shop_id()

        _log(f"[printify][product] POST /v1/shops/{shop_id}/products.json")

        resp = _post_with_retry(
            f"{PRINTIFY_BASE}/shops/{shop_id}/products.json",
            body,
            timeout=120,
            max_retries=2,
        )

        _log(f"[printify][product] Response {resp.status_code}: {resp.text[:500]}")

        if resp.status_code not in (200, 201):
            raise Exception(f"Product creation failed ({resp.status_code}): {resp.text}")

        result = resp.json()
        return JSONResponse(content=result)

    except HTTPException:
        raise
    except Exception as e:
        err = f"Product creation failed: {e}"
        _log(f"[printify][product] ERROR: {err}")
        return JSONResponse(status_code=500, content={"detail": err})


# ────────────────────────────────────────────────
# 3.  List shops
# ────────────────────────────────────────────────
@router.get("/shops")
async def list_shops():
    try:
        resp = requests.get(
            f"{PRINTIFY_BASE}/shops.json",
            headers=_headers(),
            verify=certifi.where(),
            timeout=60,
        )
        resp.raise_for_status()
        return JSONResponse(content=resp.json())
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Failed to list shops: {e}"})


# ────────────────────────────────────────────────
# 4.  List blueprints
# ────────────────────────────────────────────────
@router.get("/blueprints")
async def list_blueprints():
    try:
        resp = requests.get(
            f"{PRINTIFY_BASE}/catalog/blueprints.json",
            headers=_headers(),
            verify=certifi.where(),
            timeout=60,
        )
        resp.raise_for_status()
        return JSONResponse(content=resp.json())
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Failed to list blueprints: {e}"})


# ────────────────────────────────────────────────
# 5.  List variants for blueprint + provider
# ────────────────────────────────────────────────
@router.get("/blueprints/{blueprint_id}/providers/{provider_id}/variants")
async def list_variants(blueprint_id: int, provider_id: int):
    try:
        resp = requests.get(
            f"{PRINTIFY_BASE}/catalog/blueprints/{blueprint_id}/print_providers/{provider_id}/variants.json",
            headers=_headers(),
            verify=certifi.where(),
            timeout=60,
        )
        resp.raise_for_status()
        return JSONResponse(content=resp.json())
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"detail": f"Failed to list variants: {e}"},
        )


# ────────────────────────────────────────────────
# 5b.  List print providers for a blueprint
# ────────────────────────────────────────────────
@router.get("/blueprints/{blueprint_id}/providers")
async def list_providers(blueprint_id: int):
    try:
        resp = requests.get(
            f"{PRINTIFY_BASE}/catalog/blueprints/{blueprint_id}/print_providers.json",
            headers=_headers(),
            verify=certifi.where(),
            timeout=60,
        )
        resp.raise_for_status()
        return JSONResponse(content=resp.json())
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"detail": f"Failed to list providers: {e}"},
        )


# ────────────────────────────────────────────────
# 6.  Publish a product
# ────────────────────────────────────────────────
@router.post("/product/{product_id}/publish")
async def publish_product(product_id: str):
    try:
        shop_id = _shop_id()
        payload = {
            "title": True,
            "description": True,
            "images": True,
            "variants": True,
            "tags": True,
        }
        resp = _post_with_retry(
            f"{PRINTIFY_BASE}/shops/{shop_id}/products/{product_id}/publish.json",
            payload,
            timeout=120,
            max_retries=2,
        )
        _log(f"[printify][publish] Response {resp.status_code}: {resp.text[:500]}")
        if resp.status_code not in (200, 201):
            raise Exception(f"Publish failed ({resp.status_code}): {resp.text}")
        return JSONResponse(content={"success": True})
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Publish failed: {e}"})