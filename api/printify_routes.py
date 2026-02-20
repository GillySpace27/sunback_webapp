"""
Printify API proxy routes for Solar Archive.

Import and mount in main.py:

    from api import printify_routes
    app.include_router(printify_routes.router, prefix="/api")

Environment variables required:
    PRINTIFY_API_KEY   — your Printify personal access token
    PRINTIFY_SHOP_ID   — your Printify shop ID (find via GET /v1/shops.json)
    SHOPIFY_STORE_DOMAIN — your Shopify store domain (default: solar-archive.myshopify.com)
"""

import os
import re
import time
import requests
import certifi
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
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


def _printify_request(method: str, url: str, **kwargs):
    """Run a requests call to Printify. In production (RENDER set) use certifi.
    Locally, skip SSL verify by default to avoid 'unable to get local issuer
    certificate'. Set PRINTIFY_SSL_VERIFY=1 to force verification when local.
    """
    in_production = os.getenv("RENDER") is not None
    explicit = os.getenv("PRINTIFY_SSL_VERIFY", "").strip().lower()
    if explicit in ("0", "false", "no"):
        skip_verify = True
    elif explicit in ("1", "true", "yes"):
        skip_verify = False
    else:
        skip_verify = not in_production
    saved_ca = os.environ.pop("REQUESTS_CA_BUNDLE", None)
    saved_ssl = os.environ.pop("SSL_CERT_FILE", None)
    try:
        if skip_verify:
            kwargs["verify"] = False
        else:
            ca_bundle = certifi.where()
            kwargs["verify"] = ca_bundle
            os.environ["REQUESTS_CA_BUNDLE"] = ca_bundle
            os.environ["SSL_CERT_FILE"] = ca_bundle
        return requests.request(method, url, **kwargs)
    finally:
        if saved_ca is not None:
            os.environ["REQUESTS_CA_BUNDLE"] = saved_ca
        elif "REQUESTS_CA_BUNDLE" in os.environ and not skip_verify:
            del os.environ["REQUESTS_CA_BUNDLE"]
        if saved_ssl is not None:
            os.environ["SSL_CERT_FILE"] = saved_ssl
        elif "SSL_CERT_FILE" in os.environ and not skip_verify:
            del os.environ["SSL_CERT_FILE"]


# ────────────────────────────────────────────────
# 1.  Upload image to Printify media library
# ────────────────────────────────────────────────
def _upload_image_sync(payload: dict) -> dict:
    """Blocking upload — runs in a thread via run_in_threadpool."""
    resp = _printify_request(
        "POST",
        f"{PRINTIFY_BASE}/uploads/images.json",
        headers=_headers(),
        json=payload,
        timeout=120,
    )
    _log(f"[printify][upload] Response {resp.status_code}: {resp.text[:500]}")
    if resp.status_code not in (200, 201):
        raise Exception(f"Printify upload failed ({resp.status_code}): {resp.text}")
    result = resp.json()
    if not result.get("id"):
        raise Exception("No 'id' in Printify upload response")
    return result


@router.post("/upload")
async def upload_image(request: Request):
    """
    Proxies an image upload to Printify.
    Accepts JSON body with EITHER:
      { "file_name": "...", "contents": "<base64-encoded-image>" }   (preferred, direct upload)
      { "file_name": "...", "url": "https://..." }                   (fallback, Printify fetches URL)
    Returns the Printify image object including its 'id'.
    """
    try:
        body = await request.json()
        url = body.get("url")
        contents = body.get("contents")
        file_name = body.get("file_name") or "solar_image.png"

        if not url and not contents:
            raise HTTPException(status_code=400, detail="Missing 'url' or 'contents' field.")

        if contents:
            payload = {"file_name": file_name, "contents": contents}
            _log(f"[printify][upload] POST /v1/uploads/images.json  base64 upload, {len(contents)} chars")
        else:
            # Rewrite localhost URLs to the public domain when deployed
            render_env = os.getenv("RENDER")
            if render_env or url.startswith("http://127.0.0.1") or url.startswith("http://localhost"):
                url = re.sub(
                    r"^http://(127\.0\.0\.1|localhost)(:\d+)?",
                    "https://solar-archive.onrender.com",
                    url,
                )
                _log(f"[printify][upload] Rewrote URL -> {url}")
            payload = {"file_name": file_name, "url": url}
            _log(f"[printify][upload] POST /v1/uploads/images.json  url-based upload: {url}")

        result = await run_in_threadpool(_upload_image_sync, payload)
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
def _create_product_sync(body: dict) -> dict:
    """Blocking product creation — runs in a thread via run_in_threadpool."""
    shop_id = _shop_id()
    _log(f"[printify][product] POST /v1/shops/{shop_id}/products.json")
    resp = _printify_request(
        "POST",
        f"{PRINTIFY_BASE}/shops/{shop_id}/products.json",
        headers=_headers(),
        json=body,
        timeout=120,
    )
    _log(f"[printify][product] Response {resp.status_code}: {resp.text[:500]}")
    if resp.status_code not in (200, 201):
        raise Exception(f"Product creation failed ({resp.status_code}): {resp.text}")
    return resp.json()


@router.post("/product")
async def create_product(request: Request):
    """Creates a product in the merchant's Printify shop."""
    try:
        body = await request.json()
        result = await run_in_threadpool(_create_product_sync, body)
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
def _list_shops_sync() -> list:
    resp = _printify_request("GET", f"{PRINTIFY_BASE}/shops.json", headers=_headers(), timeout=60)
    resp.raise_for_status()
    return resp.json()


@router.get("/shops")
async def list_shops():
    """Returns all shops associated with the Printify API key."""
    try:
        result = await run_in_threadpool(_list_shops_sync)
        return JSONResponse(content=result)
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Failed to list shops: {e}"})


# ────────────────────────────────────────────────
# 4.  List blueprints (catalog browser)
# ────────────────────────────────────────────────
def _list_blueprints_sync() -> list:
    resp = _printify_request("GET", f"{PRINTIFY_BASE}/catalog/blueprints.json", headers=_headers(), timeout=60)
    resp.raise_for_status()
    return resp.json()


@router.get("/blueprints")
async def list_blueprints():
    """Returns the full Printify blueprint catalog."""
    try:
        result = await run_in_threadpool(_list_blueprints_sync)
        return JSONResponse(content=result)
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Failed to list blueprints: {e}"})


# ────────────────────────────────────────────────
# 5.  List variants for a blueprint + provider
# ────────────────────────────────────────────────
def _list_variants_sync(blueprint_id: int, provider_id: int) -> dict:
    resp = _printify_request(
        "GET",
        f"{PRINTIFY_BASE}/catalog/blueprints/{blueprint_id}/print_providers/{provider_id}/variants.json",
        headers=_headers(),
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


@router.get("/blueprints/{blueprint_id}/providers/{provider_id}/variants")
async def list_variants(blueprint_id: int, provider_id: int):
    """Returns all variants for a given blueprint + print provider combo."""
    try:
        result = await run_in_threadpool(_list_variants_sync, blueprint_id, provider_id)
        return JSONResponse(content=result)
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Failed to list variants: {e}"})


# ────────────────────────────────────────────────
# 6.  Publish a product to the connected store
# ────────────────────────────────────────────────
def _publish_product_sync(product_id: str) -> None:
    shop_id = _shop_id()
    payload = {"title": True, "description": True, "images": True, "variants": True, "tags": True}
    resp = _printify_request(
        "POST",
        f"{PRINTIFY_BASE}/shops/{shop_id}/products/{product_id}/publish.json",
        headers=_headers(),
        json=payload,
        timeout=120,
    )
    _log(f"[printify][publish] Response {resp.status_code}: {resp.text[:500]}")
    if resp.status_code not in (200, 201):
        raise Exception(f"Publish failed ({resp.status_code}): {resp.text}")


@router.post("/product/{product_id}/publish")
async def publish_product(product_id: str):
    """Publishes a product to the connected sales channel (e.g. Shopify)."""
    try:
        await run_in_threadpool(_publish_product_sync, product_id)
        return JSONResponse(content={"success": True})
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Publish failed: {e}"})


# ────────────────────────────────────────────────
# 7.  Store config (returns Shopify domain)
# ────────────────────────────────────────────────
SHOPIFY_STORE_DOMAIN = os.getenv("SHOPIFY_STORE_DOMAIN", "solar-archive.myshopify.com")


@router.get("/store-config")
async def store_config():
    """Returns the Shopify store domain for frontend redirects."""
    return JSONResponse(content={"shopify_store_domain": SHOPIFY_STORE_DOMAIN})


# ────────────────────────────────────────────────
# 8.  Checkout: upload + create product + publish
# ────────────────────────────────────────────────
def _do_checkout_sync(
    image_base64: str,
    file_name: str,
    title: str,
    description: str,
    blueprint_id: int,
    print_provider_id: int,
    variant_id: int,
    price: int,
    position: str,
    tags: list,
) -> dict:
    """Blocking checkout logic — runs in a thread via run_in_threadpool."""
    shop_id = _shop_id()

    # ── Step 1: Upload image ──
    _log(f"[checkout] Step 1: uploading image ({len(image_base64)} chars)")
    upload_resp = _printify_request(
        "POST",
        f"{PRINTIFY_BASE}/uploads/images.json",
        headers=_headers(),
        json={"file_name": file_name, "contents": image_base64},
        timeout=120,
    )
    if upload_resp.status_code not in (200, 201):
        raise Exception(f"Image upload failed ({upload_resp.status_code}): {upload_resp.text[:300]}")

    image_data = upload_resp.json()
    image_id = image_data.get("id")
    if not image_id:
        raise Exception("No image ID in upload response")
    _log(f"[checkout] Image uploaded: {image_id}")

    # ── Step 2: Create product ──
    _log(f"[checkout] Step 2: creating product (blueprint={blueprint_id}, provider={print_provider_id})")
    product_payload = {
        "title": title,
        "description": description,
        "blueprint_id": blueprint_id,
        "print_provider_id": print_provider_id,
        "variants": [
            {"id": variant_id, "price": price, "is_enabled": True}
        ],
        "print_areas": [
            {
                "variant_ids": [variant_id],
                "placeholders": [
                    {
                        "position": position,
                        "images": [
                            {
                                "id": image_id,
                                "x": 0.5,
                                "y": 0.5,
                                "scale": 1,
                                "angle": 0,
                            }
                        ],
                    }
                ],
            }
        ],
        "tags": tags,
    }

    create_resp = _printify_request(
        "POST",
        f"{PRINTIFY_BASE}/shops/{shop_id}/products.json",
        headers=_headers(),
        json=product_payload,
        timeout=120,
    )
    if create_resp.status_code not in (200, 201):
        raise Exception(f"Product creation failed ({create_resp.status_code}): {create_resp.text[:300]}")

    product_data = create_resp.json()
    product_id = product_data.get("id")
    if not product_id:
        raise Exception("No product ID in creation response")
    _log(f"[checkout] Product created: {product_id}")

    # ── Step 3: Publish to Shopify ──
    _log(f"[checkout] Step 3: publishing product {product_id}")
    publish_resp = _printify_request(
        "POST",
        f"{PRINTIFY_BASE}/shops/{shop_id}/products/{product_id}/publish.json",
        headers=_headers(),
        json={
            "title": True,
            "description": True,
            "images": True,
            "variants": True,
            "tags": True,
        },
        timeout=120,
    )
    if publish_resp.status_code not in (200, 201):
        _log(f"[checkout] Publish warning ({publish_resp.status_code}): {publish_resp.text[:300]}")

    _log(f"[checkout] Complete: product={product_id}, image={image_id}")
    return {
        "printify_product_id": product_id,
        "printify_image_id": image_id,
        "status": "published",
    }


@router.post("/checkout")
async def checkout(request: Request):
    """
    All-in-one checkout: uploads image, creates product, publishes to Shopify.
    Blocking Printify API calls are offloaded to a thread pool.
    """
    try:
        body = await request.json()

        image_base64 = body.get("image_base64", "")
        file_name = body.get("file_name", "solar_image.png")
        title = body.get("title", "Solar Archive Custom Product")
        description = body.get("description", "")
        blueprint_id = body.get("blueprint_id")
        print_provider_id = body.get("print_provider_id")
        variant_id = body.get("variant_id")
        price = body.get("price", 0)
        position = body.get("position", "front")
        tags = body.get("tags", [])

        if not image_base64:
            raise HTTPException(status_code=400, detail="Missing image_base64")
        if not blueprint_id or not print_provider_id or not variant_id:
            raise HTTPException(status_code=400, detail="Missing blueprint_id, print_provider_id, or variant_id")

        result = await run_in_threadpool(
            _do_checkout_sync,
            image_base64, file_name, title, description,
            blueprint_id, print_provider_id, variant_id,
            price, position, tags,
        )
        return JSONResponse(content=result)

    except HTTPException:
        raise
    except Exception as e:
        err = f"Checkout failed: {e}"
        _log(f"[checkout] ERROR: {err}")
        return JSONResponse(status_code=500, content={"detail": err})


# ────────────────────────────────────────────────
# 9.  Get Shopify URL for a published product
# ────────────────────────────────────────────────
# Printify product IDs are 24-char hex strings (MongoDB ObjectId format).
_PRINTIFY_ID_RE = re.compile(r"^[a-f0-9]{24}$")


def _fetch_shopify_url_sync(product_id: str) -> dict:
    """Blocking lookup — runs in a thread via run_in_threadpool."""
    shop_id = _shop_id()
    resp = _printify_request(
        "GET",
        f"{PRINTIFY_BASE}/shops/{shop_id}/products/{product_id}.json",
        headers=_headers(),
        timeout=30,
    )
    if resp.status_code != 200:
        return {"status": "pending"}

    product = resp.json()
    external = product.get("external") or {}
    handle = external.get("handle")
    external_id = external.get("id")

    def slug_only(value):
        """Use value as product slug; if it looks like a full URL, extract the slug after /products/."""
        if not value or not isinstance(value, str):
            return None
        s = value.strip()
        if s.startswith("http://") or s.startswith("https://"):
            # e.g. https://0b1wyw-tz.myshopify.com/products/solar-193a-2026-02-12-metal-art-sign
            if "/products/" in s:
                s = s.split("/products/", 1)[-1].split("/")[0].split("?")[0]
            else:
                s = s.rstrip("/").split("/")[-1].split("?")[0]
        return s if s else None

    slug = slug_only(handle) or slug_only(external_id)
    if slug:
        return {"status": "ready", "shopify_url": f"https://{SHOPIFY_STORE_DOMAIN}/products/{slug}"}
    return {"status": "pending"}


@router.get("/product/{product_id}/shopify-url")
async def get_shopify_url(product_id: str):
    """
    Checks if a Printify product has been synced to Shopify and returns the URL.
    The frontend polls this after publishing.
    """
    # Validate product_id format to prevent SSRF — only allow Printify ObjectId hex strings
    if not _PRINTIFY_ID_RE.match(product_id):
        raise HTTPException(status_code=400, detail="Invalid product_id format")
    try:
        result = await run_in_threadpool(_fetch_shopify_url_sync, product_id)
        return JSONResponse(content=result)
    except Exception as e:
        _log(f"[shopify-url] Error checking product {product_id}: {e}")
        return JSONResponse(content={"status": "pending"})
