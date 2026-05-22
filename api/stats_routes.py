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
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request
from starlette.concurrency import run_in_threadpool

from api.security import enforce_origin, enforce_rate_limit, _client_ip
from api.feedback_routes import _data_dir, _check_admin_key  # shared disk + admin gate

router = APIRouter(prefix="/stats", tags=["Stats"])


def _excluded_ips() -> set:
    """IPs whose events are accepted (200) but NOT counted — the operator's
    own networks + automated testing. Comma-separated env var."""
    raw = os.getenv("STATS_EXCLUDE_IPS", "").strip()
    if not raw:
        return set()
    return {ip.strip() for ip in raw.split(",") if ip.strip()}

STATS_FILE = _data_dir() / "product_stats.json"
SEED_FILE = _data_dir() / "stats_seed.json"

# Default CLICK seeds applied on reset, so a fresh start sorts the
# operator's suspected-popular items to the top instead of a flat zero
# grid. Buys are NEVER seeded — faking sales would be dishonest. The
# operator can override these by editing stats_seed.json on the disk
# (written automatically the first time seeds are read).
_DEFAULT_SEED = {
    "wall_clock": 5,
    "mug_15oz": 3,
    "mug_15oz_black": 3,
    "phone_case": 1,
    "throw_pillow": 1,
    "sherpa_blanket": 1,
    "puzzle_1000": 1,
    "sticker_kiss": 1,
    "journal_hardcover": 1,
}


def _seed_values() -> dict:
    """Click seeds: the disk override (stats_seed.json) if present + valid,
    else the code default — which is then written to disk so the operator
    can edit it. Returns {product_id: click_seed}."""
    if SEED_FILE.exists():
        try:
            with SEED_FILE.open("r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                return {k: int(v) for k, v in d.items()
                        if isinstance(v, (int, float)) and int(v) > 0}
        except (OSError, ValueError):
            pass
    try:
        SEED_FILE.parent.mkdir(parents=True, exist_ok=True)
        with SEED_FILE.open("w", encoding="utf-8") as f:
            json.dump(_DEFAULT_SEED, f, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return dict(_DEFAULT_SEED)


def _seeded_stats() -> dict:
    """A fresh stats dict with seeded clicks (buys 0) per the seed file."""
    return {pid: {"buys": 0, "clicks": int(c)} for pid, c in _seed_values().items() if int(c) > 0}

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
async def get_stats(request: Request):
    """Public read of all product counters (for badges + sort).
    Also reports whether THIS caller's IP is excluded, so the frontend
    can decide to show the (operator-only) popularity badge."""
    data = await run_in_threadpool(_read_stats)
    # Strip the internal ts field from the public payload.
    clean = {
        pid: {"buys": int(v.get("buys", 0)), "clicks": int(v.get("clicks", 0))}
        for pid, v in data.items()
        if isinstance(v, dict)
    }
    return {"stats": clean, "viewer_excluded": _client_ip(request) in _excluded_ips()}


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

    # Operator / automated-testing IP exclusion: accept the request so the
    # client sees success, but don't move the counters.
    if _client_ip(request) in _excluded_ips():
        return {"ok": True, "excluded": True}

    result = await run_in_threadpool(_increment, product_id, kind)
    return {"ok": True, "product_id": product_id, "buys": result.get("buys", 0), "clicks": result.get("clicks", 0)}


@router.get("/whoami")
async def whoami(request: Request):
    """Return the IP the server sees for this caller + whether it's already
    excluded. Lets the operator find the value to put in STATS_EXCLUDE_IPS."""
    ip = _client_ip(request)
    return {"ip": ip, "excluded": ip in _excluded_ips()}


@router.post("/reset")
async def reset_stats(
    request: Request,
    product_id: Optional[str] = Query(default=None),
    x_admin_key: Optional[str] = Header(default=None, alias="X-Admin-Key"),
    key: Optional[str] = Query(default=None),
):
    """Reset counters. Admin-key gated (same key as feedback admin).
    Pass ?product_id=<id> to zero a single product; omit to reset all."""
    _check_admin_key(x_admin_key, key)

    def _do_reset():
        with _lock:
            if product_id:
                data = _read_stats()
                seed = _seed_values().get(product_id, 0)
                if seed > 0:
                    data[product_id] = {"buys": 0, "clicks": int(seed)}
                elif product_id in data:
                    del data[product_id]
                _write_stats(data)
                return {"reset": "product", "product_id": product_id, "seeded_clicks": int(seed)}
            # Reset everything → seeded baseline (clicks only; buys zeroed).
            seeded = _seeded_stats()
            _write_stats(seeded)
            return {"reset": "all", "seeded": seeded}

    if product_id and not _PRODUCT_ID_RE.match(product_id):
        raise HTTPException(status_code=400, detail="Invalid product_id")
    result = await run_in_threadpool(_do_reset)
    return {"ok": True, **result}
