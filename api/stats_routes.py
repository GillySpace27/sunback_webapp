"""
Product popularity stats for Solar Archive.

Two per-product counters, persisted to a JSON file on the same
persistent disk as feedback (FEEDBACK_DATA_DIR → /var/data on Render,
webapp root in local dev), so they survive deploys:

  • buys   — times a product was carried through the finalize action
             ("Create on Shopify" / beta "Download your design").
             Conversion signal.
  • clicks — times a product was committed into the editor
             ("Continue to editor"). Interest signal. (The frontend
             displays clicks MINUS buys as "engaged but didn't convert",
             but we store the raw total here.)

Endpoints (mounted under /api):
  GET  /api/stats          → { "stats": { "<product_id>": {buys, clicks}, … } }
                             public read — the frontend needs it to render
                             the badges + sort the grid.
  POST /api/stats/event    → { "product_id": "...", "kind": "click"|"buy" }
                             Origin-gated + per-IP rate-limited (reuses
                             api.security) so a random internet caller
                             can't inflate the counts.
"""

import json
import os
import re
import threading
import time

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from api.security import enforce_origin, enforce_rate_limit
from api.feedback_routes import _data_dir  # shared persistent-disk resolver

router = APIRouter(prefix="/stats", tags=["Stats"])

STATS_FILE = _data_dir() / "product_stats.json"

# product_id shape: our own ids (snake_case) + user-requested ids.
_PRODUCT_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
_VALID_KINDS = ("click", "buy")

# Single-instance Render service → an in-process lock is enough to keep
# concurrent read-modify-write of the JSON file consistent.
_lock = threading.Lock()

# Rate-limit: events fire at most a couple times per editor session, so
# this is generous headroom for a real user while blocking inflation.
_STATS_LIMIT = 30
_STATS_WINDOW = 60.0


def _read_stats() -> dict:
    if not STATS_FILE.exists():
        return {}
    try:
        with STATS_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_stats(data: dict) -> None:
    STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Write to a temp file then atomically replace, so a crash mid-write
    # can't leave a truncated/corrupt JSON that wipes all counts.
    tmp = STATS_FILE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, STATS_FILE)


def _increment(product_id: str, kind: str) -> dict:
    with _lock:
        data = _read_stats()
        entry = data.get(product_id) or {"buys": 0, "clicks": 0}
        if not isinstance(entry, dict):
            entry = {"buys": 0, "clicks": 0}
        if kind == "buy":
            entry["buys"] = int(entry.get("buys", 0)) + 1
        else:  # "click"
            entry["clicks"] = int(entry.get("clicks", 0)) + 1
        entry["ts"] = int(time.time())  # last-touched, for debugging
        data[product_id] = entry
        _write_stats(data)
        return entry


@router.get("")
async def get_stats():
    """Public read of all product counters (for badges + sort)."""
    data = await run_in_threadpool(_read_stats)
    # Strip the internal ts field from the public payload.
    clean = {
        pid: {"buys": int(v.get("buys", 0)), "clicks": int(v.get("clicks", 0))}
        for pid, v in data.items()
        if isinstance(v, dict)
    }
    return {"stats": clean}


@router.post("/event")
async def record_event(entry: dict, request: Request):
    """Increment a product's buy/click counter. Origin + rate gated."""
    enforce_origin(request)
    enforce_rate_limit(request, "stats_event", _STATS_LIMIT, _STATS_WINDOW)

    product_id = entry.get("product_id") if isinstance(entry, dict) else None
    kind = entry.get("kind") if isinstance(entry, dict) else None
    if not isinstance(product_id, str) or not _PRODUCT_ID_RE.match(product_id):
        raise HTTPException(status_code=400, detail="Invalid product_id")
    if kind not in _VALID_KINDS:
        raise HTTPException(status_code=400, detail="Invalid kind (click|buy)")

    result = await run_in_threadpool(_increment, product_id, kind)
    return {"ok": True, "product_id": product_id, "buys": result.get("buys", 0), "clicks": result.get("clicks", 0)}
