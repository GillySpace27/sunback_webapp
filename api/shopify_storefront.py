"""Shopify Storefront API helpers.

Used by the cart-permalink endpoint to map a Printify variant (which is
all we know on the order-creation side) to a Shopify variant ID
(which is what the cart URL needs).

Why not just hit Printify's API for the Shopify variant ID? Printify's
publish-to-Shopify creates the product but doesn't reliably expose the
Shopify variant IDs back to us — `external.variants` is empty for some
blueprint/provider combos. Storefront API is the source of truth.

Env:
- SHOPIFY_STORE_DOMAIN — e.g. "solar-archive.myshopify.com"
- SHOPIFY_STOREFRONT_ACCESS_TOKEN — public Storefront API token. NOT
  the Admin API key. Generated under
  Shopify Admin → Apps → Develop apps → <your app> → Storefront API
  access tokens. Read-only `unauthenticated_read_product_listings`
  is the only scope needed for the cart-permalink flow.
"""
from __future__ import annotations

import os
import re
import time
from typing import Optional

import requests


SHOPIFY_STORE_DOMAIN = os.getenv(
    "SHOPIFY_STORE_DOMAIN", "solar-archive.myshopify.com"
)
SHOPIFY_STOREFRONT_API_VERSION = os.getenv(
    "SHOPIFY_STOREFRONT_API_VERSION", "2024-10"
)
SHOPIFY_STOREFRONT_ACCESS_TOKEN = os.getenv("SHOPIFY_STOREFRONT_ACCESS_TOKEN")

_STOREFRONT_TIMEOUT_SECONDS = 12


def _storefront_url() -> str:
    return (
        f"https://{SHOPIFY_STORE_DOMAIN}"
        f"/api/{SHOPIFY_STOREFRONT_API_VERSION}/graphql.json"
    )


def _storefront_headers() -> dict:
    token = SHOPIFY_STOREFRONT_ACCESS_TOKEN
    if not token:
        raise RuntimeError(
            "SHOPIFY_STOREFRONT_ACCESS_TOKEN env var not set. "
            "Generate one in Shopify Admin → Apps → Develop apps → Storefront API tokens."
        )
    return {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
    }


# Shopify variant GIDs look like 'gid://shopify/ProductVariant/45123456789'.
# The cart-permalink URL takes just the numeric tail.
_VARIANT_GID_TAIL_RE = re.compile(r"/ProductVariant/(\d+)$")


def _numeric_variant_id(gid: str) -> Optional[str]:
    if not gid:
        return None
    m = _VARIANT_GID_TAIL_RE.search(gid)
    return m.group(1) if m else None


def lookup_variant_id_by_sku(handle: str, sku: str) -> Optional[str]:
    """Return the numeric Shopify variant ID matching `sku` on the
    product `handle`, or None if not found.

    `handle` is the URL-slug Shopify assigns when Printify publishes
    (e.g. "solar-193a-2026-02-12-metal-art-sign"). We derive it from
    the existing /api/printify/product/{id}/shopify-url flow.
    """
    if not handle or not sku:
        return None
    query = """
    query ($handle: String!) {
      product(handle: $handle) {
        id
        variants(first: 100) {
          edges { node { id sku title } }
        }
      }
    }
    """
    variables = {"handle": handle}
    try:
        resp = requests.post(
            _storefront_url(),
            json={"query": query, "variables": variables},
            headers=_storefront_headers(),
            timeout=_STOREFRONT_TIMEOUT_SECONDS,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    data = resp.json()
    if not isinstance(data, dict):
        return None
    product = (data.get("data") or {}).get("product")
    if not product:
        return None
    edges = (product.get("variants") or {}).get("edges") or []
    # Exact SKU match only. Printify mirrors the variant SKU verbatim onto
    # Shopify at publish, so an exact match is the correct Printify→Shopify
    # bridge. A previous loose containment fallback (`sku in ns or ns in sku`)
    # could resolve to the WRONG variant — a different size/material/price —
    # and send the buyer straight to a one-tap cart for a product they never
    # selected. On no exact match we return None so the caller falls back to
    # the product page, where the customer picks the variant themselves.
    for e in edges:
        node = e.get("node") or {}
        if node.get("sku") == sku:
            return _numeric_variant_id(node.get("id") or "")
    sku_lower = sku.lower()
    for e in edges:
        node = e.get("node") or {}
        ns = (node.get("sku") or "").lower()
        if ns and ns == sku_lower:
            return _numeric_variant_id(node.get("id") or "")
    return None


def cart_permalink(variant_id_numeric: str, quantity: int = 1) -> str:
    """Build the Shopify cart-permalink URL. Navigating to this URL
    adds the variant to the customer's cart and lands them on the
    cart page (or directly on checkout, depending on the shop's
    "after add to cart" setting).
    """
    qty = max(1, int(quantity))
    return f"https://{SHOPIFY_STORE_DOMAIN}/cart/{variant_id_numeric}:{qty}"


def storefront_configured() -> bool:
    """Convenience check the routes use to fail loud when the
    operator hasn't set up the Storefront token yet."""
    return bool(SHOPIFY_STOREFRONT_ACCESS_TOKEN)


# ────────────────────────────────────────────────────────────────
# Admin API: post-publish patch for per-order products
# ────────────────────────────────────────────────────────────────
# Printify's publish-to-Shopify creates every per-order product with
# inventoryPolicy DENY + tracked inventory (the setting that cancelled
# order #1001 with cancelReason INVENTORY) and publishes it only to the
# Online Store channel, which the headless Storefront API token cannot
# see — so the one-tap cart permalink silently degrades to the
# product-page fallback. Both are fixed here, right after publish,
# via the Admin API.
#
# Env — either auth style works; client credentials is the one the new
# Dev Dashboard actually offers for own-store apps:
# - SHOPIFY_ADMIN_CLIENT_ID + SHOPIFY_ADMIN_CLIENT_SECRET — the app's
#   API credentials from dev.shopify.com. Admin tokens minted from
#   these EXPIRE AFTER 24 H, so we mint on demand and cache with a
#   5-minute early-refresh margin. The token's scopes come from the
#   app's configured Admin API scopes: read_products, write_products,
#   write_inventory, write_publications.
# - SHOPIFY_ADMIN_ACCESS_TOKEN — a static token (legacy custom-app
#   shpat_…). Takes precedence when set.
# With neither set this module is a no-op and checkout keeps working
# exactly as before (DENY inventory, product-page fallback) — same
# graceful pattern as the Storefront token above.
SHOPIFY_ADMIN_ACCESS_TOKEN = os.getenv("SHOPIFY_ADMIN_ACCESS_TOKEN")
SHOPIFY_ADMIN_CLIENT_ID = os.getenv("SHOPIFY_ADMIN_CLIENT_ID")
SHOPIFY_ADMIN_CLIENT_SECRET = os.getenv("SHOPIFY_ADMIN_CLIENT_SECRET")
SHOPIFY_ADMIN_API_VERSION = os.getenv("SHOPIFY_ADMIN_API_VERSION", "2024-10")

# Minted-token cache for the client-credentials flow.
_admin_token_cache = {"token": None, "expires_at": 0.0}


def _admin_configured() -> bool:
    return bool(
        SHOPIFY_ADMIN_ACCESS_TOKEN
        or (SHOPIFY_ADMIN_CLIENT_ID and SHOPIFY_ADMIN_CLIENT_SECRET)
    )


def _admin_token() -> Optional[str]:
    """Current Admin API token: the static one if set, else a minted
    client-credentials token (cached ~24 h, refreshed 5 min early).
    Returns None when unconfigured or minting fails."""
    if SHOPIFY_ADMIN_ACCESS_TOKEN:
        return SHOPIFY_ADMIN_ACCESS_TOKEN
    if not (SHOPIFY_ADMIN_CLIENT_ID and SHOPIFY_ADMIN_CLIENT_SECRET):
        return None
    now = time.time()
    if _admin_token_cache["token"] and now < _admin_token_cache["expires_at"]:
        return _admin_token_cache["token"]
    try:
        resp = requests.post(
            f"https://{SHOPIFY_STORE_DOMAIN}/admin/oauth/access_token",
            data={
                "grant_type": "client_credentials",
                "client_id": SHOPIFY_ADMIN_CLIENT_ID,
                "client_secret": SHOPIFY_ADMIN_CLIENT_SECRET,
            },
            timeout=_STOREFRONT_TIMEOUT_SECONDS,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    body = resp.json() if resp.content else {}
    token = body.get("access_token")
    if not token:
        return None
    # ponytail: worst case under concurrent calls is a duplicate mint —
    # harmless, last writer wins.
    _admin_token_cache["token"] = token
    _admin_token_cache["expires_at"] = now + float(body.get("expires_in", 86399)) - 300
    return token
# ponytail: shop-specific publication GIDs as defaults ("Solar Archive
# Headless" + "…02"); override via env if the store's channels change.
SHOPIFY_HEADLESS_PUBLICATION_IDS = [
    p.strip()
    for p in os.getenv(
        "SHOPIFY_HEADLESS_PUBLICATION_IDS",
        "gid://shopify/Publication/356457185649,"
        "gid://shopify/Publication/356474061169",
    ).split(",")
    if p.strip()
]

# Handles already patched this process lifetime — the patch is called
# from a polling loop, so skip repeat work. Failures are NOT recorded,
# so the next poll retries them.
_pod_patched_handles: set = set()


def _admin_graphql(query: str, variables: dict) -> Optional[dict]:
    """One Admin API GraphQL call. Returns the 'data' dict or None."""
    token = _admin_token()
    if not token:
        return None
    try:
        resp = requests.post(
            f"https://{SHOPIFY_STORE_DOMAIN}"
            f"/admin/api/{SHOPIFY_ADMIN_API_VERSION}/graphql.json",
            json={"query": query, "variables": variables},
            headers={
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": token,
            },
            timeout=_STOREFRONT_TIMEOUT_SECONDS,
        )
    except requests.RequestException:
        return None
    if resp.status_code == 401:
        # Minted token revoked/expired early: drop the cache so the
        # next poll re-mints. (The polling caller retries naturally.)
        _admin_token_cache["token"] = None
        return None
    if resp.status_code != 200:
        return None
    body = resp.json()
    if not isinstance(body, dict) or body.get("errors"):
        return None
    return body.get("data")


def ensure_pod_product_config(handle: str) -> None:
    """Idempotent, best-effort post-publish patch: set every variant to
    inventoryPolicy CONTINUE + untracked, and publish the product to the
    headless publication(s) so the Storefront API can build the one-tap
    cart permalink. Safe to call repeatedly; no-op without admin
    credentials. Never raises."""
    if not _admin_configured() or not handle:
        return
    if handle in _pod_patched_handles:
        return
    try:
        data = _admin_graphql(
            """
            query ($handle: String!) {
              productByHandle(handle: $handle) {
                id
                variants(first: 100) {
                  edges { node { id inventoryPolicy inventoryItem { tracked } } }
                }
              }
            }
            """,
            {"handle": handle},
        )
        product = (data or {}).get("productByHandle")
        if not product:
            return
        product_id = product["id"]

        bad = [
            n["id"]
            for n in (
                e.get("node") or {}
                for e in (product.get("variants") or {}).get("edges") or []
            )
            if n.get("inventoryPolicy") != "CONTINUE"
            or (n.get("inventoryItem") or {}).get("tracked") is not False
        ]
        ok = True
        if bad:
            fixed = _admin_graphql(
                """
                mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                    userErrors { message }
                  }
                }
                """,
                {
                    "productId": product_id,
                    "variants": [
                        {
                            "id": vid,
                            "inventoryPolicy": "CONTINUE",
                            # 0.20 lb, not Printify's 0.22 default: 0.22 sits
                            # exactly on the shipping-band boundary, so a
                            # single-item cart matches two bands and the buyer
                            # sees two identically-named rates at different
                            # prices. 0.20×n stays strictly inside band n for
                            # n ≤ 10, so banded multi-item pricing still works.
                            "inventoryItem": {
                                "tracked": False,
                                "measurement": {
                                    "weight": {"value": 0.2, "unit": "POUNDS"}
                                },
                            },
                        }
                        for vid in bad
                    ],
                },
            )
            ok = bool(fixed) and not (
                fixed.get("productVariantsBulkUpdate") or {}
            ).get("userErrors")

        if SHOPIFY_HEADLESS_PUBLICATION_IDS:
            published = _admin_graphql(
                """
                mutation ($id: ID!, $input: [PublicationInput!]!) {
                  publishablePublish(id: $id, input: $input) {
                    userErrors { message }
                  }
                }
                """,
                {
                    "id": product_id,
                    "input": [
                        {"publicationId": p}
                        for p in SHOPIFY_HEADLESS_PUBLICATION_IDS
                    ],
                },
            )
            ok = ok and bool(published) and not (
                published.get("publishablePublish") or {}
            ).get("userErrors")

        if ok:
            _pod_patched_handles.add(handle)
    except Exception:
        # Best-effort: checkout must never break because of this patch.
        return
