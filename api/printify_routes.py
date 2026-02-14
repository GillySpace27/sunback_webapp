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
    }


def _shop_id():
    sid = PRINTIFY_SHOP_ID or os.getenv("PRINTIFY_SHOP_ID", "")
    if not sid:
        raise RuntimeError(
            "PRINTIFY_SHOP_ID is not set. "
            "Run GET https://api.printify.com/v1/shops.json with your token to find it."
        )
    return sid


# ────────────────────────────────────────────────
# 1.  Upload image to Printify media library
# ────────────────────────────────────────────────
@router.post("/upload")
async def upload_image(request: Request):
    """
    Proxies an image upload to Printify.
    Expects JSON body: { "file_name": "...", "url": "https://..." }
    Returns the Printify image object including its 'id'.
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

        resp = requests.post(
            f"{PRINTIFY_BASE}/uploads/images.json",
            headers=_headers(),
            json=payload,
            verify=certifi.where(),
            timeout=120,
        )

        _log(f"[printify][upload] Response {resp.status_code}: {resp.text[:500]}")

        if resp.status_code not in (200, 201):
            raise Exception(f"Printify upload failed ({resp.status_code}): {resp.text}")

        result = resp.json()

        # result should contain { id, file_name, height, width, size, ... }
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
# 2.  Create a product in the Printify shop
# ────────────────────────────────────────────────
@router.post("/product")
async def create_product(request: Request):
    """
    Creates a product in the merchant's Printify shop.
    Expects JSON body matching the Printify product creation schema:
    {
        "title": "...",
        "description": "...",
        "blueprint_id": 68,
        "print_provider_id": 16,
        "variants": [ { "id": 17791, "price": 0, "is_enabled": true } ],
        "print_areas": [ {
            "variant_ids": [17791],
            "placeholders": [ {
                "position": "front",
                "images": [ { "id": "...", "x": 0.5, "y": 0.5, "scale": 1, "angle": 0 } ]
            }]
        }]
    }
    """
    try:
        body = await request.json()
        shop_id = _shop_id()

        _log(f"[printify][product] POST /v1/shops/{shop_id}/products.json")

        resp = requests.post(
            f"{PRINTIFY_BASE}/shops/{shop_id}/products.json",
            headers=_headers(),
            json=body,
            verify=certifi.where(),
            timeout=120,
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
# 3.  List shops (helper to find shop_id)
# ────────────────────────────────────────────────
@router.get("/shops")
async def list_shops():
    """Returns all shops associated with the Printify API key."""
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
# 4.  List blueprints (catalog browser)
# ────────────────────────────────────────────────
@router.get("/blueprints")
async def list_blueprints():
    """Returns the full Printify blueprint catalog."""
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
# 5.  List variants for a blueprint + provider
# ────────────────────────────────────────────────
@router.get("/blueprints/{blueprint_id}/providers/{provider_id}/variants")
async def list_variants(blueprint_id: int, provider_id: int):
    """Returns all variants for a given blueprint + print provider combo."""
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
# 6.  Publish a product to the connected store
# ────────────────────────────────────────────────
@router.post("/product/{product_id}/publish")
async def publish_product(product_id: str):
    """
    Publishes a product that was created via the API.
    This pushes it to the connected sales channel (e.g. Shopify).
    """
    try:
        shop_id = _shop_id()
        payload = {
            "title": True,
            "description": True,
            "images": True,
            "variants": True,
            "tags": True,
        }
        resp = requests.post(
            f"{PRINTIFY_BASE}/shops/{shop_id}/products/{product_id}/publish.json",
            headers=_headers(),
            json=payload,
            verify=certifi.where(),
            timeout=120,
        )
        _log(f"[printify][publish] Response {resp.status_code}: {resp.text[:500]}")
        if resp.status_code not in (200, 201):
            raise Exception(f"Publish failed ({resp.status_code}): {resp.text}")
        return JSONResponse(content={"success": True})
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Publish failed: {e}"})
