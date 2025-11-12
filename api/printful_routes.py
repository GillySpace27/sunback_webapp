from fastapi import APIRouter, UploadFile, Form
from fastapi.responses import JSONResponse
import requests, time, os

router = APIRouter(prefix="/printful", tags=["printful"])

PRINTFUL_API_KEY = os.getenv("PRINTFUL_API_KEY")
PRINTFUL_BASE = "https://api.printful.com"

def _headers():
    if not PRINTFUL_API_KEY:
        # Late binding so hot-reloads pick up env changes
        raise RuntimeError("PRINTFUL_API_KEY is not set in the environment")
    return {"Authorization": f"Bearer {PRINTFUL_API_KEY}"}


# ────────────────────────────────────────────────
# 1️⃣  Upload image to Printful File Library
# ────────────────────────────────────────────────
@router.post("/upload")
async def upload_image(file: UploadFile):
    """Uploads a solar image (PNG/JPG) to the Printful File Library."""
    try:
        _ = _headers()  # validates key
        files = {"file": (file.filename, await file.read(), file.content_type)}
        data = {"purpose": "preview"}
        r = requests.post(f"{PRINTFUL_BASE}/files", headers=_headers(), files=files, data=data)
        r.raise_for_status()
        file_id = r.json()["result"]["id"]
        return {"file_id": file_id}
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Printful upload failed: {e}"})


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