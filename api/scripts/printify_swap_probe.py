#!/usr/bin/env python3
"""Printify image-swap probe: does updating a product's print image reflect on an
order that was already placed but NOT yet sent to production?

This is the one de-risking test for the "checkout decouple" plan. It creates a
throwaway product + a single ON-HOLD order, swaps the product's print image,
dumps the order + product JSON before and after, then CANCELS the order and
DELETES the product.

SAFETY (read this):
  - It NEVER calls send_to_production, so nothing is manufactured.
  - Printify bills the merchant only when an order goes to production; an
    on-hold order that we cancel is free.
  - It refuses to run unless you pass --confirm-manual-approval, asserting your
    Printify shop's order-approval is set to MANUAL. With automatic approval an
    API order could route itself to production before we cancel it. Set it to
    manual in the Printify dashboard first (Settings -> Orders -> order approval).
  - Right after creating the order it checks the status; if the order looks like
    it is heading to production (not on-hold) it aborts and tries to cancel.

What it proves:
  - The product print image can be swapped via PUT product (print_areas).
  - An order can be created, held on-hold, and cancelled with no charge.
  - Whether the order's own JSON / preview reference changes after the swap
    (dumped for you to eyeball). If Printify resolves print files live from the
    product, the post-swap order preview reflects image B.

What it cannot fully prove without a real production proof:
  - The exact file a factory receives. The final gate is one real Shopify order
    you hold and inspect the production proof for before approving (see PLAN).

Usage:
  PRINTIFY_API_KEY=... PRINTIFY_SHOP_ID=... \
  python3 api/scripts/printify_swap_probe.py --confirm-manual-approval \
      [--blueprint 785 --provider 41 --variant 74934] [--keep]

Defaults target the greeting-card single (cheap, known-good config from
products.js). Override for a different blueprint/provider/variant.
"""
import argparse
import base64
import io
import json
import os
import sys
import time

import requests

BASE = "https://api.printify.com/v1"


def _key() -> str:
    k = os.getenv("PRINTIFY_API_KEY", "")
    if not k:
        sys.exit("ERROR: PRINTIFY_API_KEY not set")
    return k


def _shop() -> str:
    s = os.getenv("PRINTIFY_SHOP_ID", "")
    if not s:
        sys.exit("ERROR: PRINTIFY_SHOP_ID not set (GET /v1/shops.json to find it)")
    return s


def _h() -> dict:
    return {"Authorization": f"Bearer {_key()}", "Content-Type": "application/json; charset=utf-8"}


def _req(method: str, path: str, **kw) -> requests.Response:
    url = f"{BASE}{path}"
    r = requests.request(method, url, headers=_h(), timeout=180, **kw)
    print(f"  {method} {path} -> {r.status_code}")
    if r.status_code >= 400:
        print(f"    body: {r.text[:500]}")
    return r


def _solid_png_b64(rgb) -> str:
    """A 1000x1000 solid-colour PNG, base64 (no PIL dependency assumptions:
    fall back to a tiny hand-built PNG if Pillow is missing)."""
    try:
        from PIL import Image  # noqa
        im = Image.new("RGB", (1000, 1000), rgb)
        buf = io.BytesIO()
        im.save(buf, "PNG")
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        sys.exit("ERROR: Pillow (PIL) required for the probe image. pip install pillow")


def _upload(name: str, rgb) -> str:
    print(f"[upload] {name} {rgb}")
    r = _req("POST", "/uploads/images.json", json={"file_name": name, "contents": _solid_png_b64(rgb)})
    r.raise_for_status()
    return r.json()["id"]


TEST_ADDRESS = {
    "first_name": "Swap",
    "last_name": "Probe",
    "email": "probe@example.com",
    "phone": "0000000000",
    "country": "US",
    "region": "CO",
    "address1": "1 Test St",
    "city": "Boulder",
    "zip": "80301",
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--confirm-manual-approval", action="store_true",
                    help="Assert your Printify shop order-approval is set to MANUAL.")
    ap.add_argument("--blueprint", type=int, default=785)
    ap.add_argument("--provider", type=int, default=41)
    ap.add_argument("--variant", type=int, default=74934)
    ap.add_argument("--position", default="front")
    ap.add_argument("--keep", action="store_true", help="Do not delete the product at the end.")
    args = ap.parse_args()

    if not args.confirm_manual_approval:
        sys.exit(
            "REFUSING TO RUN. Set your Printify shop to MANUAL order approval first "
            "(Settings -> Orders), then re-run with --confirm-manual-approval. This "
            "keeps the created order on-hold so it is never produced or charged."
        )

    shop = _shop()
    product_id = None
    order_id = None
    try:
        # 1) two distinguishable images
        img_a = _upload("probe_A_red.png", (200, 30, 30))
        img_b = _upload("probe_B_blue.png", (30, 60, 200))

        # 2) product with image A
        print("[product] create with image A (red)")
        prod_payload = {
            "title": "[SWAP-PROBE] delete me",
            "description": "Temporary product for the image-swap probe. Safe to delete.",
            "blueprint_id": args.blueprint,
            "print_provider_id": args.provider,
            "variants": [{"id": args.variant, "price": 999, "is_enabled": True}],
            "print_areas": [{
                "variant_ids": [args.variant],
                "placeholders": [{"position": args.position, "images": [
                    {"id": img_a, "x": 0.5, "y": 0.5, "scale": 1.0, "angle": 0}
                ]}],
            }],
        }
        r = _req("POST", f"/shops/{shop}/products.json", json=prod_payload)
        r.raise_for_status()
        product_id = r.json()["id"]
        print(f"  product_id = {product_id}")

        # 3) create ON-HOLD order (NO send_to_production). external_id keeps it
        #    idempotent-ish and easy to spot in the dashboard.
        print("[order] create on-hold order for the product")
        order_payload = {
            "external_id": f"swap-probe-{int(time.time())}",
            "label": "[SWAP-PROBE] delete me",
            "line_items": [{"product_id": product_id, "variant_id": args.variant, "quantity": 1}],
            "shipping_method": 1,
            "send_shipping_notification": False,
            "address_to": TEST_ADDRESS,
        }
        r = _req("POST", f"/shops/{shop}/orders.json", json=order_payload)
        r.raise_for_status()
        order_id = r.json().get("id") or r.json().get("order", {}).get("id")
        print(f"  order_id = {order_id}")

        # 4) SAFETY: confirm on-hold, never in-production
        time.sleep(2)
        o1 = _req("GET", f"/shops/{shop}/orders/{order_id}.json").json()
        status1 = o1.get("status")
        print(f"  order status after create: {status1!r}")
        if status1 and "production" in str(status1).lower():
            print("!! ABORT: order appears to be heading to production. Cancelling.")
            _req("POST", f"/shops/{shop}/orders/{order_id}/cancel.json")
            return 2

        print("\n===== ORDER JSON (before swap) =====")
        print(json.dumps(o1, indent=2)[:4000])

        # 5) swap the PRODUCT image to B
        print("\n[product] PUT update print_areas -> image B (blue)")
        put_payload = {"print_areas": [{
            "variant_ids": [args.variant],
            "placeholders": [{"position": args.position, "images": [
                {"id": img_b, "x": 0.5, "y": 0.5, "scale": 1.0, "angle": 0}
            ]}],
        }]}
        r = _req("PUT", f"/shops/{shop}/products/{product_id}.json", json=put_payload)
        r.raise_for_status()

        # 6) re-fetch order + product; dump for eyeballing
        time.sleep(3)
        o2 = _req("GET", f"/shops/{shop}/orders/{order_id}.json").json()
        p2 = _req("GET", f"/shops/{shop}/products/{product_id}.json").json()

        print("\n===== ORDER JSON (after swap) =====")
        print(json.dumps(o2, indent=2)[:4000])

        # 7) verdict heuristics: did the product print image change, and did any
        #    order-side reference/preview move with it?
        def _image_ids_in_product(p):
            ids = set()
            for area in p.get("print_areas", []) or []:
                for ph in area.get("placeholders", []) or []:
                    for im in ph.get("images", []) or []:
                        if im.get("id"):
                            ids.add(im["id"])
            return ids

        prod_ids = _image_ids_in_product(p2)
        print("\n===== VERDICT =====")
        print(f"product print image ids after swap: {sorted(prod_ids)}")
        print(f"  image_a={img_a}\n  image_b={img_b}")
        print(f"product now uses image B: {img_b in prod_ids and img_a not in prod_ids}")
        print("order preview/print refs before vs after: compare the two ORDER JSON dumps above.")
        print("  - If the order's line_item/preview references or preview URLs changed to")
        print("    track image B, print files resolve LIVE from the product => decouple is safe.")
        print("  - If the order still pins image A, the Shopify-sync path may snapshot at")
        print("    order-creation; the plan's real-order gate becomes mandatory.")

        return 0
    finally:
        # ALWAYS clean up: cancel the order (free while on-hold), delete product.
        if order_id:
            print("\n[cleanup] cancel order")
            _req("POST", f"/shops/{shop}/orders/{order_id}/cancel.json")
        if product_id and not args.keep:
            print("[cleanup] delete product")
            _req("DELETE", f"/shops/{shop}/products/{product_id}.json")


if __name__ == "__main__":
    sys.exit(main())
