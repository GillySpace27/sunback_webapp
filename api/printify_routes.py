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

from api.security import (
    enforce_origin,
    enforce_rate_limit,
    enforce_beta_mode_block,
)

router = APIRouter(prefix="/printify", tags=["Printify"])

# Per-IP rate-limits for the mutating Printify endpoints. These all
# fan out to api.printify.com under the operator's API key, so abuse =
# real wholesale + shipping cost. Limits are deliberately tight; a
# legitimate session triggers maybe 1-2 uploads, 1 checkout, 1 publish.
_PRINTIFY_WRITE_LIMIT = 8         # max calls
_PRINTIFY_WRITE_WINDOW = 60.0     # ...per 60s per IP
_PRINTIFY_CHECKOUT_LIMIT = 3      # checkout is the only one that
_PRINTIFY_CHECKOUT_WINDOW = 300.0 # actually publishes — even tighter

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

    SECURITY NOTE (Mira Sokolov round-2 audit, P3 INFO): defaulting
    SSL verify off when not on Render means a dev on an untrusted
    network could be MITMed on outbound api.printify.com calls. The
    operator key would leak. Mitigation in practice: only the
    operator runs this locally, on their own laptop; production
    (Render) DOES verify against certifi. If you ever run this
    server publicly outside Render, set `PRINTIFY_SSL_VERIFY=1` to
    force verification.

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
    enforce_origin(request)
    enforce_rate_limit(request, "printify_upload", _PRINTIFY_WRITE_LIMIT, _PRINTIFY_WRITE_WINDOW)
    # Beta-mode policy (2026-05-25 change): /upload + /product are
    # required for the "Generate real mockup" flow, which creates a
    # throwaway draft product and deletes it after reading back the
    # auto-generated mockup URLs. No money or shipping changes hands.
    # The user-visible money paths (/publish + /checkout) keep their
    # beta block. Without unblocking here, testers couldn't preview
    # what their design actually looks like as a real product photo.
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
# ── Catalog-aware placeholder expansion ───────────────────────────
# Some blueprints (all-over sublimation socks, leggings, mugs with
# "default" wraps, etc.) DO NOT expose a "front" placeholder. Crew
# socks for example only have front_left_leg / front_right_leg /
# back_left_leg / back_right_leg. The client hardcodes
# `position: "front"` for every product, so without expansion
# Printify rejects those requests with a position-mismatch error
# and the user sees a silent mockup failure.
#
# This helper introspects the catalog for the target variant, then
# rewrites the print_areas placeholder list to use positions that
# actually exist on the variant. Resolution order per requested
# position:
#   1. exact name match     ("front" matches "front")
#   2. substring match      ("front" matches {"front_left_leg",
#                            "front_right_leg"})   →   fan out
#   3. fall back to ALL valid positions — best effort so the user
#      gets SOMETHING printed on every panel rather than nothing.

# Small in-process cache so we don't hit the catalog endpoint every
# time the user generates a mockup. Catalog placeholder geometry is
# effectively static, so a long TTL is fine. Keyed by (bp, pp).
_variant_positions_cache: dict = {}
_VARIANT_POS_TTL = 60 * 60  # 1 hour


def _get_variant_positions(bp_id: int, pp_id: int, variant_id: int) -> list:
    """Return the list of placeholder position names for one variant,
    or [] if we can't look it up."""
    try:
        bp_id_i = int(bp_id)
        pp_id_i = int(pp_id)
        variant_id_i = int(variant_id)
    except (TypeError, ValueError):
        return []
    key = (bp_id_i, pp_id_i)
    now = time.time()
    cached = _variant_positions_cache.get(key)
    if cached and (now - cached[0]) < _VARIANT_POS_TTL:
        variants_by_id = cached[1]
    else:
        try:
            data = _list_variants_sync(bp_id_i, pp_id_i)
        except Exception as e:
            _log(f"[printify][expand-placeholders] catalog lookup failed bp={bp_id_i} pp={pp_id_i}: {e}")
            return []
        variants_by_id = {}
        for v in (data.get("variants") or []):
            vid = v.get("id")
            if vid is None:
                continue
            positions = [
                p.get("position")
                for p in (v.get("placeholders") or [])
                if p.get("position")
            ]
            variants_by_id[vid] = positions
        _variant_positions_cache[key] = (now, variants_by_id)
    return list(variants_by_id.get(variant_id_i) or [])


def _expand_print_areas(body: dict) -> dict:
    """Rewrite body['print_areas'] so every placeholder targets a
    position that actually exists on the variant. Returns a NEW body
    dict (does not mutate the input).
    """
    print_areas = body.get("print_areas") or []
    if not print_areas:
        return body
    bp_id = body.get("blueprint_id")
    pp_id = body.get("print_provider_id")
    variants = body.get("variants") or []
    # Use the first variant to look up valid positions. Printify
    # requires that every variant in a single print_area share the
    # same placeholder geometry, so any of them works.
    primary_vid = variants[0].get("id") if variants else None
    if not (bp_id and pp_id and primary_vid):
        return body
    valid_positions = _get_variant_positions(bp_id, pp_id, primary_vid)
    if not valid_positions:
        return body
    valid_set = set(valid_positions)

    new_print_areas = []
    rewrote = False
    for area in print_areas:
        new_placeholders = []
        for ph in (area.get("placeholders") or []):
            pos = ph.get("position")
            if pos in valid_set:
                new_placeholders.append(ph)
                continue
            # Try a substring match — "front" → ["front_left_leg",
            # "front_right_leg"]. Sock-shaped products want the same
            # design on each matching panel.
            substr_matches = [vp for vp in valid_positions if pos and pos in vp]
            if not substr_matches:
                # Last resort: stamp the design on every valid
                # position. The user gets a working all-over preview
                # instead of nothing.
                substr_matches = valid_positions
            for m in substr_matches:
                clone = dict(ph)
                clone["position"] = m
                new_placeholders.append(clone)
            rewrote = True
        new_area = dict(area)
        new_area["placeholders"] = new_placeholders
        new_print_areas.append(new_area)

    if not rewrote:
        return body
    out = dict(body)
    out["print_areas"] = new_print_areas
    requested = sorted({ph.get("position") for area in print_areas for ph in (area.get("placeholders") or [])})
    final = sorted({ph.get("position") for area in new_print_areas for ph in (area.get("placeholders") or [])})
    _log(
        f"[printify][expand-placeholders] bp={bp_id} pp={pp_id} variant={primary_vid} "
        f"requested={requested} → final={final}"
    )
    return out


def _create_product_sync(body: dict) -> dict:
    """Blocking product creation — runs in a thread via run_in_threadpool."""
    shop_id = _shop_id()
    # Auto-expand placeholders before posting so all-over products
    # (socks, leggings, mugs with non-"front" placeholders) succeed
    # even though the client hardcodes position="front".
    try:
        body = _expand_print_areas(body)
    except Exception as e:
        _log(f"[printify][product] placeholder-expansion skipped (continuing): {e}")
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
    enforce_origin(request)
    enforce_rate_limit(request, "printify_product", _PRINTIFY_WRITE_LIMIT, _PRINTIFY_WRITE_WINDOW)
    # Beta-mode allowed (see /upload for rationale): /product is the
    # second half of the mockup-retrieval pipeline. Drafts get created
    # then deleted; no listing, no order, no money. /publish remains
    # blocked so a draft never becomes a real Shopify listing in beta.
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
async def publish_product(product_id: str, request: Request):
    """Publishes a product to the connected sales channel (e.g. Shopify)."""
    enforce_origin(request)
    enforce_rate_limit(request, "printify_publish", _PRINTIFY_WRITE_LIMIT, _PRINTIFY_WRITE_WINDOW)
    enforce_beta_mode_block("Product publish is paused while BETA_MODE is on.")
    if not _PRINTIFY_ID_RE.match(product_id):
        raise HTTPException(status_code=400, detail="Invalid product_id format")
    try:
        await run_in_threadpool(_publish_product_sync, product_id)
        return JSONResponse(content={"success": True})
    except Exception as e:
        return JSONResponse(status_code=500, content={"detail": f"Publish failed: {e}"})


# ────────────────────────────────────────────────
# 7.  Store config (returns Shopify domain)
# ────────────────────────────────────────────────
SHOPIFY_STORE_DOMAIN = os.getenv("SHOPIFY_STORE_DOMAIN", "solar-archive.myshopify.com")


def _is_beta_mode() -> bool:
    """Beta mode disables real Shopify checkout in favour of a local
    PNG download — keeps the operator from eating Printify wholesale +
    shipping cost on every test order. Toggled by the BETA_MODE env var
    (any truthy string: "1", "true", "yes" — case-insensitive)."""
    raw = os.getenv("BETA_MODE", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


@router.get("/store-config")
async def store_config():
    """Returns store config + beta-mode flag for the frontend.

    Frontend reads `beta_mode`; when true, the editor's "Create on
    Shopify" button is swapped for "Download Your Design" so testers
    can run through the full editor flow without triggering real
    Printify orders (each of which would bill the operator the
    wholesale cost + shipping)."""
    return JSONResponse(content={
        "shopify_store_domain": SHOPIFY_STORE_DOMAIN,
        "beta_mode": _is_beta_mode(),
    })


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

    # Same placeholder-expansion pass used by /api/printify/product —
    # otherwise crew socks (and any other all-over blueprint without a
    # bare "front" position) fail at checkout the same way they fail
    # at mockup time.
    try:
        product_payload = _expand_print_areas(product_payload)
    except Exception as e:
        _log(f"[checkout] placeholder-expansion skipped (continuing): {e}")

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
    enforce_origin(request)
    enforce_rate_limit(
        request,
        "printify_checkout",
        _PRINTIFY_CHECKOUT_LIMIT,
        _PRINTIFY_CHECKOUT_WINDOW,
    )
    enforce_beta_mode_block(
        "Checkout is paused while BETA_MODE is on. Use the local download instead."
    )
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
