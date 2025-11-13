from fastapi import APIRouter, UploadFile, Form, Request, File
from typing import List
from fastapi.responses import JSONResponse
import requests, time, os

router = APIRouter(prefix="/printful", tags=["printful"])

PRINTFUL_API_KEY = os.getenv("PRINTFUL_API_KEY")
PRINTFUL_BASE = "https://api.printful.com"

# Curated product templates used by the frontend picker.
# NOTE: Replace product_id and variant_id with real IDs from your Printful dashboard.
TEMPLATES = [
    {
        "key": "poster_matte_12x18",
        "label": 'Poster — 12×18" Premium Matte',
        "product_id": 0,
        "variant_id": 0,
        "thumbnail": None,
        "description": "Example poster template. Replace IDs with real Printful product/variant.",
    },
    {
        "key": "canvas_16x20",
        "label": 'Canvas — 16×20" Gallery Wrap',
        "product_id": 0,
        "variant_id": 0,
        "thumbnail": None,
        "description": "Example canvas template. Replace IDs with real Printful product/variant.",
    },
]

def _headers():
    if not PRINTFUL_API_KEY:
        # Late binding so hot-reloads pick up env changes
        raise RuntimeError("PRINTFUL_API_KEY is not set in the environment")
    return {"Authorization": f"Bearer {PRINTFUL_API_KEY}"}



# ────────────────────────────────────────────────
# 1️⃣  Upload image to Printful File Library (JSON URL-based method)
# ────────────────────────────────────────────────
from fastapi import HTTPException
import os

ASSET_BASE_URL = os.getenv("SOLAR_ARCHIVE_ASSET_BASE_URL", "http://127.0.0.1:8000/asset")

@router.post("/upload")
async def upload_image(request: Request):
    """
    Uploads a solar image to Printful using JSON URL-based method.
    Expects JSON:
    {
        "image_path": "hq_SDO_171_2025-11-09.png",
        "filename": "optional_custom.png"
    }
    """
    try:
        data = await request.json()
        image_path = data.get("image_path")
        custom_filename = data.get("filename")

        if not image_path:
            raise HTTPException(status_code=400, detail="image_path is required")

        # Idempotency check: avoid duplicate uploads if the same file already exists
        basename = os.path.basename(image_path)
        try:
            check = requests.get(f"{PRINTFUL_BASE}/files", headers={"Authorization": f"Bearer {PRINTFUL_API_KEY}"})
            if check.ok:
                existing = check.json().get("result", {}).get("items", [])
                for item in existing:
                    if item.get("filename") == basename:
                        return {
                            "status": "success",
                            "file_id": item.get("id"),
                            "file_url": item.get("url"),
                            "raw": item
                        }
        except Exception:
            pass

        # Handle relative paths under /tmp/output
        if not image_path.startswith("http://") and not image_path.startswith("https://"):
            if not os.path.isabs(image_path):
                image_path = os.path.join("/tmp/output", image_path)
            if not os.path.exists(image_path):
                raise HTTPException(status_code=400, detail=f"File not found: {image_path}")

            # Convert to public URL
            basename = os.path.basename(image_path)
            public_url = f"{ASSET_BASE_URL.rstrip('/')}/{basename}"
        else:
            public_url = image_path

        filename = custom_filename or os.path.basename(public_url)

        payload = {
            "type": "default",
            "url": public_url,
            "options": [
                {"id": "template_type", "value": "native"}
            ],
            "filename": filename,
            "visible": True
        }

        headers = {
            "Authorization": f"Bearer {PRINTFUL_API_KEY}",
            "Content-Type": "application/json"
        }

        r = requests.post(
            f"{PRINTFUL_BASE}/files",
            headers=headers,
            json=payload
        )

        if r.status_code >= 400:
            raise HTTPException(
                status_code=r.status_code,
                detail=r.text
            )

        result = r.json().get("result", {})
        return {
            "status": "success",
            "file_id": result.get("id"),
            "file_url": result.get("url"),
            "raw": result
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {e}")



# ────────────────────────────────────────────────
# List curated product templates for frontend picker
# ────────────────────────────────────────────────
@router.get("/templates")
async def list_templates():
    """
    Return curated Printful product templates for use in the Solar Archive UI.

    Each template packs the product_id + variant_id needed for automatic mockups.
    """
    return TEMPLATES


# ────────────────────────────────────────────────
# List live product templates from Printful
# ────────────────────────────────────────────────
@router.get("/templates/live")
async def list_live_templates():
    try:
        hdr = _headers()
        r = requests.get(f"{PRINTFUL_BASE}/product-templates", headers=hdr)
        r.raise_for_status()
        raw = r.json().get("result", [])
        templates = []
        for t in raw:
            tpl = {
                "template_id": t.get("id"),
                "product_id": t.get("product_id"),
                "name": t.get("name") or t.get("title") or "Untitled Template",
                "thumbnail": t.get("thumbnail_url") or t.get("preview_url"),
                "variants": []
            }
            for v in t.get("variants", []):
                tpl["variants"].append({
                    "variant_id": v.get("id"),
                    "name": v.get("name") or v.get("title"),
                    "size": v.get("size"),
                    "color": v.get("color")
                })
            templates.append(tpl)
        return templates
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to fetch templates: {e}"})

# ────────────────────────────────────────────────
# 2️⃣  Generate live product mockup
# ────────────────────────────────────────────────
@router.post("/mockup")
async def create_mockup(
    product_id: int = Form(...),
    variant_id: int = Form(...),
    file_id: int = Form(...)
):
    """
    Requests a Printful mockup for a given product + uploaded image.
    Returns a mockup_url to display in the frontend.
    """
    try:
        _ = _headers()  # validates key
        payload = {
            "variant_ids": [variant_id],
            "format": "png",
            "files": [{"placement": "default", "image_id": file_id}],
        }
        r = requests.post(
            f"{PRINTFUL_BASE}/mockup-generator/create-task/{product_id}",
            headers=_headers(),
            json=payload,
        )
        r.raise_for_status()
        task_key = r.json()["result"]["task_key"]

        # Poll until ready (timeout ~60s)
        deadline = time.time() + 60
        while time.time() < deadline:
            t = requests.get(f"{PRINTFUL_BASE}/mockup-generator/task", params={"task_key": task_key}, headers=_headers())
            t.raise_for_status()
            data = t.json().get("result", {})
            status = data.get("status")
            if status == "failed":
                return JSONResponse(status_code=500, content={"error": "Mockup generation failed"})
            if status == "completed":
                # Try several shapes Printful may return
                urls = []
                if "mockups" in data:
                    for m in data["mockups"]:
                        if isinstance(m, dict):
                            if m.get("mockup_url"):
                                urls.append(m["mockup_url"])
                            # Some responses nest files or extra
                            if "extra" in m and isinstance(m["extra"], dict):
                                if m["extra"].get("mockup_url"):
                                    urls.append(m["extra"]["mockup_url"])
                if not urls and isinstance(data.get("task_result"), dict):
                    # Fallback older shape
                    u = data["task_result"].get("mockup_url")
                    if u: urls.append(u)
                if urls:
                    return {"mockup_url": urls[0]}
                return JSONResponse(status_code=502, content={"error": "No mockup URL returned by Printful"})
            time.sleep(1)
        return JSONResponse(status_code=504, content={"error": "Mockup task polling timed out"})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Mockup request failed: {e}"})


@router.get("/products")
async def list_products():
    """Returns a simple list of Printful products for the frontend picker."""
    try:
        _ = _headers()
        r = requests.get(f"{PRINTFUL_BASE}/products", headers=_headers())
        r.raise_for_status()
        result = r.json().get("result", {})
        raw_products = result.get("products", result)  # Handle both old and new shapes
        products = []
        for p in raw_products:
            products.append({
                "id": p.get("id"),
                "name": p.get("name") or p.get("title") or "Unnamed",
                "thumbnail": p.get("image"),
                "type": p.get("type"),
            })
        return products
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to list products: {e}"})


# ────────────────────────────────────────────────
# 3️⃣  Place a manual Printful order
# ────────────────────────────────────────────────
@router.post("/order")
async def create_order(
    variant_id: int = Form(...),
    file_id: int = Form(...),
    name: str = Form(...),
    address1: str = Form(...),
    city: str = Form(...),
    state_code: str = Form(...),
    country_code: str = Form(...),
    zip: str = Form(...),
    email: str = Form(...),
):
    """Creates a one-off Printful order for the given variant/image."""
    recipient = {
        "name": name,
        "address1": address1,
        "city": city,
        "state_code": state_code,
        "country_code": country_code,
        "zip": zip,
        "email": email,
    }

    payload = {
        "recipient": recipient,
        "items": [{
            "variant_id": variant_id,
            "files": [{"id": file_id}],
            "quantity": 1,
        }],
    }
    r = requests.post(f"{PRINTFUL_BASE}/orders", headers=_headers(), json=payload)
    r.raise_for_status()
    return {"order_id": r.json()["result"]["id"]}