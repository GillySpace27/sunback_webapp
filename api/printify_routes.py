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

    Works across three network shapes without configuration:
      1. External / home wifi: no proxy in use, direct connection succeeds.
      2. Corporate network (dev): outbound direct is blocked, HTTPS_PROXY env
         points at an internal filter proxy.
      3. Deployed (Render): no proxy, direct connection succeeds.

    Strategy: try direct first (bypassing any HTTPS_PROXY env var). If direct
    refuses with a ConnectionError, retry letting requests honor the env
    proxy. That way external-wifi users aren't trapped by a stale corp-
    network HTTPS_PROXY in their shell profile, and corp-network users still
    reach the API via the filter.
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
        # Try direct first — bypass any env proxy. Works on external wifi and
        # in deployed envs. Fails fast on corp networks with "Connection refused."
        # Use a short connect timeout on the direct probe (5s) so corp-network
        # clients fail fast and fall back to the env proxy instead of blocking
        # on a full-length upstream timeout.
        direct_kwargs = dict(kwargs)
        direct_kwargs["proxies"] = {"http": None, "https": None}
        original_timeout = kwargs.get("timeout")
        if isinstance(original_timeout, (int, float)):
            direct_kwargs["timeout"] = (5, original_timeout)
        else:
            direct_kwargs["timeout"] = (5, 60)
        try:
            return requests.request(method, url, **direct_kwargs)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout):
            # Direct refused or timed out — retry via HTTPS_PROXY env proxy.
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
# 4b. List print providers for a blueprint
# ────────────────────────────────────────────────
def _list_providers_sync(blueprint_id: int) -> list:
    resp = _printify_request(
        "GET",
        f"{PRINTIFY_BASE}/catalog/blueprints/{blueprint_id}/print_providers.json",
        headers=_headers(),
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


@router.get("/blueprints/{blueprint_id}/providers")
async def list_providers(blueprint_id: int):
    """Returns all print providers available for a given blueprint."""
    try:
        result = await run_in_threadpool(_list_providers_sync, blueprint_id)
        return JSONResponse(content=result)
    except Exception as e:
        _log(f"[printify][providers] blueprint={blueprint_id} error: {e}")
        return JSONResponse(status_code=500, content={"detail": f"Failed to list providers: {e}"})


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
        _log(f"[printify][variants] blueprint={blueprint_id} provider={provider_id} error: {e}")
        return JSONResponse(status_code=500, content={"detail": f"Failed to list variants: {e}"})


# ────────────────────────────────────────────────
# Variant pricing — Printify catalog endpoint does NOT include variant cost
# (only id/title/options/placeholders), so the only way to surface per-variant
# pricing is to scan the shop's existing products and read the cost+price
# fields off matching variants. We page through all shop products once and
# build an index keyed by (blueprint_id, print_provider_id, variant_id).
# Cached for 30 minutes — pricing changes are rare and a 12-request scan is
# slow on a cold cache (1k+ products at 100/page).
# ────────────────────────────────────────────────
_pricing_cache: dict = {}     # {(bp, pp): {variant_id: {"cost": cents, "price": cents}}}
_pricing_index_built_at: float = 0.0
_PRICING_TTL = 30 * 60         # seconds

def _build_pricing_index_sync() -> None:
    """Scan all shop products, populate _pricing_cache. Idempotent — replaces
    the whole cache on each rebuild so deleted/edited products are reflected."""
    global _pricing_cache, _pricing_index_built_at
    shop_id = _shop_id()
    new_cache: dict = {}
    page = 1
    # Printify caps shop products list at limit=50 (validation error 8150 above).
    limit = 50
    pages_walked = 0
    total_products = 0
    while True:
        resp = _printify_request(
            "GET",
            f"{PRINTIFY_BASE}/shops/{shop_id}/products.json?limit={limit}&page={page}",
            headers=_headers(),
            timeout=60,
        )
        resp.raise_for_status()
        body = resp.json()
        items = body.get("data") or []
        total_products = body.get("total", total_products)
        if not items:
            break
        for prod in items:
            bp = prod.get("blueprint_id")
            pp = prod.get("print_provider_id")
            if bp is None or pp is None:
                continue
            key = (int(bp), int(pp))
            bucket = new_cache.setdefault(key, {})
            for v in (prod.get("variants") or []):
                vid = v.get("id")
                if vid is None:
                    continue
                # Keep the cheapest cost we've seen per variant — different
                # products with the same blueprint may have set retail prices
                # differently, but Printify's `cost` (their charge to us) is
                # consistent across products. We display cost preferentially.
                existing = bucket.get(int(vid))
                cost = v.get("cost")
                price = v.get("price")
                if existing is None or (cost is not None and (existing.get("cost") is None or cost < existing["cost"])):
                    bucket[int(vid)] = {"cost": cost, "price": price}
        pages_walked += 1
        if len(items) < limit:
            break
        # Hard safety cap so a runaway pagination doesn't hammer Printify.
        # 50 pages × 50 = 2500 products covers any reasonable shop.
        if pages_walked > 50:
            _log(f"[printify][pricing] stopped at {pages_walked} pages (safety cap)")
            break
        page += 1
    _pricing_cache = new_cache
    _pricing_index_built_at = time.time()
    _log(f"[printify][pricing] index built: {pages_walked} pages, "
         f"{total_products} products, {len(new_cache)} (bp, pp) combos")


def _ensure_pricing_index_sync() -> None:
    if (time.time() - _pricing_index_built_at) > _PRICING_TTL or not _pricing_cache:
        _build_pricing_index_sync()


@router.get("/blueprints/cheapest_costs")
async def blueprints_cheapest_costs():
    """Returns {blueprint_id: cheapest_cost_cents} for blueprints the shop
    has at least one product for. Catalogue blueprints the shop has never
    sold are absent — we have no pricing for those without a costly per-
    blueprint provider+variant scan, and the feedback search list is OK
    showing "Pricing on request" for those rows.

    Built from the same _pricing_cache the per-variant pricing endpoint
    uses, so this is essentially free after the index is warm.
    """
    try:
        await run_in_threadpool(_ensure_pricing_index_sync)
        # _pricing_cache is keyed by (bp, pp); flatten across all variants
        # within each (bp, pp) and keep the global min per blueprint id.
        cheapest: dict = {}
        for (bp, _pp), bucket in _pricing_cache.items():
            for _vid, entry in bucket.items():
                cost = entry.get("cost") if entry else None
                if cost is None:
                    continue
                prev = cheapest.get(int(bp))
                if prev is None or cost < prev:
                    cheapest[int(bp)] = int(cost)
        return JSONResponse(content={"costs": cheapest, "built_at": _pricing_index_built_at})
    except Exception as e:
        _log(f"[printify][cheapest_costs] error: {e}")
        return JSONResponse(status_code=500, content={"detail": f"Failed: {e}"})


@router.get("/blueprints/{blueprint_id}/providers/{provider_id}/pricing")
async def variant_pricing(blueprint_id: int, provider_id: int):
    """Returns per-variant cost+price for a blueprint+provider. Sourced from
    the shop's existing products (the catalog API doesn't expose costs)."""
    try:
        await run_in_threadpool(_ensure_pricing_index_sync)
        bucket = _pricing_cache.get((int(blueprint_id), int(provider_id)), {})
        return JSONResponse(content={
            "blueprint_id": blueprint_id,
            "print_provider_id": provider_id,
            "variants": bucket,
            "built_at": _pricing_index_built_at,
        })
    except Exception as e:
        _log(f"[printify][pricing] blueprint={blueprint_id} provider={provider_id} error: {e}")
        return JSONResponse(status_code=500, content={"detail": f"Failed to load pricing: {e}"})


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
    variant_ids: list,
    price: int,
    position: str,
    tags: list,
) -> dict:
    """Blocking checkout logic — runs in a thread via run_in_threadpool.

    variant_ids is a list of all Printify variant IDs to enable on the product,
    so customers can choose their preferred size/color on the Shopify storefront.
    """
    shop_id = _shop_id()
    if not variant_ids:
        raise Exception("No variant IDs provided")

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

    # ── Step 2: Create product with all requested variants enabled ──
    _log(
        f"[checkout] Step 2: creating product (blueprint={blueprint_id}, "
        f"provider={print_provider_id}, variants={len(variant_ids)})"
    )
    product_payload = {
        "title": title,
        "description": description,
        "blueprint_id": blueprint_id,
        "print_provider_id": print_provider_id,
        # Enable every requested variant at the same price
        "variants": [
            {"id": vid, "price": price, "is_enabled": True}
            for vid in variant_ids
        ],
        # Apply the same print area / image placement to all variants
        "print_areas": [
            {
                "variant_ids": variant_ids,
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

    _log(f"[checkout] Complete: product={product_id}, image={image_id}, variants={len(variant_ids)}")
    return {
        "printify_product_id": product_id,
        "printify_image_id": image_id,
        "variant_count": len(variant_ids),
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
        # Accept either variant_ids (list) or legacy variant_id (single int)
        variant_ids = body.get("variant_ids")
        if not variant_ids:
            legacy_id = body.get("variant_id")
            variant_ids = [legacy_id] if legacy_id else []
        # Ensure all entries are ints
        variant_ids = [int(v) for v in variant_ids if v is not None]
        price = body.get("price", 0)
        position = body.get("position", "front")
        tags = body.get("tags", [])

        if not image_base64:
            raise HTTPException(status_code=400, detail="Missing image_base64")
        if not blueprint_id or not print_provider_id or not variant_ids:
            raise HTTPException(status_code=400, detail="Missing blueprint_id, print_provider_id, or variant_ids")

        _log(f"[checkout] Received: blueprint={blueprint_id} provider={print_provider_id} variants={len(variant_ids)}")
        result = await run_in_threadpool(
            _do_checkout_sync,
            image_base64, file_name, title, description,
            blueprint_id, print_provider_id, variant_ids,
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
