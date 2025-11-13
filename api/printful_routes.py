import os
import ssl
import certifi
import requests
from fastapi import APIRouter, UploadFile, File, Form, Request, HTTPException
# from fastapi import FastAPI, , Query, Request

from fastapi.responses import JSONResponse
import sys
import asyncio
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
router = APIRouter(prefix="/printful", tags=["Printful"])

PRINTFUL_API_KEY = os.getenv("PRINTFUL_API_KEY", "")
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
# ────────────────────────────────────────────────
# 1️⃣  Upload image to Printful File Library (JSON URL-based method)
# ────────────────────────────────────────────────



# --- New: Upload to Printful using URL-based JSON upload (per new Printful API spec) ---
@router.post("/upload")
async def upload_to_printful(request: Request):
    """
    Upload a file to Printful's file library using the URL-based JSON method.
    Expects a JSON body like:
    {
        "type": "preview",
        "url": "https://solar-archive.onrender.com/asset/hq_SDO_171_2024-09-15.png",
        "filename": "hq_SDO_171_2024-09-15.png"
    }
    Before sending to Printful, rewrites local asset URLs to Render domain if running on Render.
    """
    try:
        body = await request.json()
        url = body.get("url")
        filename = body.get("filename") or (os.path.basename(url) if url else None)
        upload_type = body.get("type", "default")

        if not url:
            raise HTTPException(status_code=400, detail="Missing 'url' field in JSON body.")

        # Rewrite local URLs to Render domain if needed
        render_env = os.getenv("RENDER")
        is_local_url = False
        local_bases = [
            "http://127.0.0.1",
            "http://localhost"
        ]
        new_url = url
        for base in local_bases:
            if url.startswith(base):
                is_local_url = True
                break
        if render_env or is_local_url:
            # Replace base with Render domain
            import re
            # Accept possible port and path, replace with Render domain
            new_url = re.sub(r"^http://(127\.0\.0\.1|localhost)(:\d+)?", "https://solar-archive.onrender.com", url)
            log_to_queue(f"[printful][upload] Rewriting asset URL for Printful: {url} -> {new_url}")
        url = new_url

        import tempfile, shutil
        # Create clean temporary cert file and ensure it is closed before use
        tmp_clean_cert_path = None
        try:
            tmp_clean_cert_path = certifi.where()
            log_to_queue(f"[printful][upload] Using isolated cert bundle for Printful: {tmp_clean_cert_path}")
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to create clean cert file: {e}")

        headers = {"Authorization": f"Bearer {PRINTFUL_API_KEY}", "Content-Type": "application/json"}
        payload = {
            # "type": upload_type,
            "url": url,
            # "filename": filename
        }
        log_to_queue(f"[printful][upload] Sending JSON payload: {payload}")
        log_to_queue(f"[printful][upload] Sending JSON headers: {headers}")
        log_to_queue(f"[printful][upload] Sending verification: {tmp_clean_cert_path}")

        response = requests.post(
            f"https://api.printful.com/v2/files",
            headers=headers,
            json=payload,
            verify=tmp_clean_cert_path
        )

        if response.status_code != 200:
            raise Exception(f"Inner Upload failed: {response.text}")

        result = response.json()
        log_to_queue(f"[printful][upload] Success: {result}")
        return JSONResponse(content=result)
    except Exception as e:
        err = f"Upload failed: {e}"
        log_to_queue(err)
        return JSONResponse(status_code=500, content={"detail": err})



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