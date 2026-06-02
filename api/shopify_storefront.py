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
    # Exact SKU match first; some Printify products use suffixed SKUs
    # (e.g. "MUG-WHITE-11OZ" vs "MUG-WHITE-11OZ-DEFAULT") — fall back
    # to case-insensitive substring match if no exact hit.
    for e in edges:
        node = e.get("node") or {}
        if node.get("sku") == sku:
            return _numeric_variant_id(node.get("id") or "")
    sku_lower = sku.lower()
    for e in edges:
        node = e.get("node") or {}
        ns = (node.get("sku") or "").lower()
        if ns and (ns == sku_lower or sku_lower in ns or ns in sku_lower):
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
