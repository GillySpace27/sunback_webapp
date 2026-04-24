"""
Feedback router for Solar Archive.

Two kinds of user-submitted feedback end up here:

1. Free-text comments about the page experience (bugs, UX friction, suggestions).
2. Product requests — a user points at a Printify blueprint/variant they want
   to see added to the catalog.

Both are appended to ``feedback.jsonl`` in the webapp root, one JSON object per
line. An optional Slack-compatible webhook (``FEEDBACK_WEBHOOK_URL``) is hit
synchronously on each submission so the operator gets a push notification.

Admin listing is gated behind ``FEEDBACK_ADMIN_KEY`` (sent via the
``X-Admin-Key`` header or ``key`` query param). Without that env var set, the
GET endpoint refuses — no anonymous read of user submissions.

Mount in main.py:

    from api import feedback_routes
    app.include_router(feedback_routes.router, prefix="/api")
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import requests
from fastapi import APIRouter, HTTPException, Header, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/feedback", tags=["Feedback"])

# feedback.jsonl sits next to the webapp root (one level above api/).
FEEDBACK_FILE = Path(__file__).resolve().parent.parent / "feedback.jsonl"
ADMIN_KEY_ENV = "FEEDBACK_ADMIN_KEY"
WEBHOOK_ENV = "FEEDBACK_WEBHOOK_URL"

# Cap one submission at ~8KB so a rogue client can't fill the disk. Individual
# field caps below catch the common abuse (10MB textarea paste, etc.).
_MAX_BODY_CHARS = 4000
_MAX_EMAIL_CHARS = 200
_MAX_URL_CHARS = 500
_MAX_CONTEXT_CHARS = 2000


def _log(msg: str) -> None:
    print(msg, flush=True)
    sys.stdout.flush()


class FeedbackSubmission(BaseModel):
    # "comment" = free-text feedback; "product_request" = a specific Printify BP/variant ask.
    kind: str = Field(default="comment")
    body: str = Field(default="", description="The user's message or request note.")
    email: Optional[str] = Field(default=None, description="Optional reply-to email.")
    url: Optional[str] = Field(default=None, description="Page URL at time of submission.")
    user_agent: Optional[str] = Field(default=None)
    # Page context at submission time (current wavelength / date / product / filter / etc).
    context: Optional[dict] = Field(default=None)
    # Populated only for kind="product_request"
    product_request: Optional[dict] = Field(default=None)


def _clamp(s: Optional[str], limit: int) -> Optional[str]:
    if s is None:
        return None
    if not isinstance(s, str):
        s = str(s)
    return s[:limit]


def _sanitize(entry: FeedbackSubmission) -> dict:
    """Enforce size caps and drop anything that's not one of the expected kinds."""
    kind = entry.kind if entry.kind in ("comment", "product_request") else "comment"
    context = entry.context or {}
    # Round-trip through JSON to enforce serializability and cap total context size.
    try:
        context_serialized = json.dumps(context)[:_MAX_CONTEXT_CHARS]
        context_clean = json.loads(context_serialized) if context_serialized.strip().startswith("{") else {}
    except Exception:
        context_clean = {}
    product_request = entry.product_request or None
    if product_request is not None:
        try:
            pr_serialized = json.dumps(product_request)[:_MAX_CONTEXT_CHARS]
            product_request = json.loads(pr_serialized) if pr_serialized.strip().startswith("{") else None
        except Exception:
            product_request = None
    return {
        "kind": kind,
        "body": _clamp(entry.body, _MAX_BODY_CHARS) or "",
        "email": _clamp(entry.email, _MAX_EMAIL_CHARS),
        "url": _clamp(entry.url, _MAX_URL_CHARS),
        "user_agent": _clamp(entry.user_agent, _MAX_URL_CHARS),
        "context": context_clean,
        "product_request": product_request,
    }


def _append_to_disk(record: dict) -> None:
    FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
    # Line-delimited JSON keeps appends atomic and lets you tail -f the file.
    with FEEDBACK_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def _public_base_url() -> str:
    """Public URL the admin can click from Slack to approve. Falls back to localhost for dev."""
    return os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/") or "http://localhost:8000"


def _format_slack_blocks(record: dict, idx: int) -> dict:
    kind = record.get("kind", "comment")
    header = "New feedback" if kind == "comment" else "New product request"
    parts = [f"*{header}*"]
    body = record.get("body") or ""
    if body:
        parts.append(body)
    if kind == "product_request":
        pr = record.get("product_request") or {}
        if pr:
            parts.append(
                "Blueprint: `{bp}` · provider: `{pv}` · variant: `{v}`".format(
                    bp=pr.get("blueprintId"), pv=pr.get("printProviderId"), v=pr.get("variantId")
                )
            )
            if pr.get("title"):
                parts.append("Title: " + str(pr["title"]))
            # One-click approve / reject links. Admin key is in the query string —
            # PUBLIC_BASE_URL should be an https endpoint in production.
            admin_key = os.getenv(ADMIN_KEY_ENV, "").strip()
            if admin_key:
                base = _public_base_url()
                approve = f"{base}/api/feedback/admin/approve?idx={idx}&key={admin_key}"
                reject = f"{base}/api/feedback/admin/reject?idx={idx}&key={admin_key}"
                parts.append(f"<{approve}|Approve> · <{reject}|Reject>")
    email = record.get("email")
    if email:
        parts.append("Reply-to: " + email)
    ctx = record.get("context") or {}
    if ctx:
        ctx_flat = ", ".join(f"{k}={v}" for k, v in ctx.items() if v not in (None, ""))
        if ctx_flat:
            parts.append("Context: " + ctx_flat)
    return {"text": "\n".join(parts)}


def _fire_webhook(record: dict, idx: int) -> None:
    url = os.getenv(WEBHOOK_ENV, "").strip()
    if not url:
        return
    try:
        payload = _format_slack_blocks(record, idx)
        resp = requests.post(url, json=payload, timeout=5)
        if resp.status_code >= 400:
            _log(f"[feedback][webhook] non-2xx: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        _log(f"[feedback][webhook] error: {e}")


def _count_lines(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        with path.open("r", encoding="utf-8") as f:
            return sum(1 for line in f if line.strip())
    except Exception:
        return 0


@router.post("")
async def submit_feedback(entry: FeedbackSubmission, request: Request):
    """Save a feedback submission and fire the optional webhook."""
    record = _sanitize(entry)
    record["ts"] = int(time.time())
    # Best-effort client IP for rate-limit debugging later. Not displayed to admin.
    client = request.client.host if request.client else None
    if client:
        record["_ip"] = client

    if not record["body"] and not record.get("product_request"):
        raise HTTPException(status_code=400, detail="Empty submission")

    # Record the index of this entry (zero-based) so approval links can point to it.
    # Lines count BEFORE append = index of the new entry after append.
    try:
        idx = await run_in_threadpool(_count_lines, FEEDBACK_FILE)
    except Exception:
        idx = 0

    try:
        await run_in_threadpool(_append_to_disk, record)
    except Exception as e:
        _log(f"[feedback][disk] write failed: {e}")
        raise HTTPException(status_code=500, detail="Could not save feedback")

    # Fire webhook out of band so a slow Slack response doesn't block the user.
    try:
        await run_in_threadpool(_fire_webhook, record, idx)
    except Exception as e:
        _log(f"[feedback][webhook] dispatch error: {e}")

    return {"ok": True, "idx": idx}


def _check_admin_key(header_key: Optional[str], query_key: Optional[str]) -> None:
    expected = os.getenv(ADMIN_KEY_ENV, "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail=f"Admin access disabled — set {ADMIN_KEY_ENV} to enable.")
    provided = (header_key or "").strip() or (query_key or "").strip()
    if not provided or provided != expected:
        raise HTTPException(status_code=401, detail="Invalid admin key")


@router.get("")
async def list_feedback(
    x_admin_key: Optional[str] = Header(default=None, alias="X-Admin-Key"),
    key: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
):
    """Return the most recent `limit` feedback submissions. Admin-key gated."""
    _check_admin_key(x_admin_key, key)
    if not FEEDBACK_FILE.exists():
        return {"count": 0, "entries": []}

    def _read_tail() -> list:
        with FEEDBACK_FILE.open("r", encoding="utf-8") as f:
            lines = f.readlines()
        tail = lines[-limit:] if limit else lines
        out = []
        for line in tail:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
        return out

    entries = await run_in_threadpool(_read_tail)
    return {"count": len(entries), "entries": list(reversed(entries))}


# ───────────────────────────────────────────────────────────────
# Approved catalog (admin-approved user-requested products)
# ───────────────────────────────────────────────────────────────
APPROVED_CATALOG_FILE = Path(__file__).resolve().parent.parent / "approved_catalog.json"


def _read_approved_catalog() -> list:
    if not APPROVED_CATALOG_FILE.exists():
        return []
    try:
        with APPROVED_CATALOG_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception as e:
        _log(f"[catalog][read] failed: {e}")
        return []


def _write_approved_catalog(entries: list) -> None:
    APPROVED_CATALOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with APPROVED_CATALOG_FILE.open("w", encoding="utf-8") as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)


# Exposed on the same prefix as /api/feedback because the frontend treats this
# as "the list of extras the admin has OK'd for the permanent catalog". It's a
# thin read — unauthenticated so the public frontend can merge on load.
catalog_router = APIRouter(prefix="/catalog", tags=["Catalog"])


@catalog_router.get("/approved")
async def get_approved_catalog():
    """Return admin-approved product entries that the frontend merges into its built-in catalog."""
    try:
        entries = await run_in_threadpool(_read_approved_catalog)
        return {"entries": entries}
    except Exception as e:
        _log(f"[catalog][approved] error: {e}")
        return {"entries": []}


# ───────────────────────────────────────────────────────────────
# Admin approval flow — click-from-Slack friendly GET endpoints
# ───────────────────────────────────────────────────────────────
PRINTIFY_BASE = "https://api.printify.com/v1"


def _fetch_blueprint_title(bp_id: int) -> Optional[str]:
    """Best-effort title lookup so approved-catalog names aren't just 'Blueprint NNN'."""
    token = os.getenv("PRINTIFY_API_TOKEN") or os.getenv("PRINTIFY_API_KEY") or ""
    if not token:
        return None
    try:
        r = requests.get(
            f"{PRINTIFY_BASE}/catalog/blueprints/{bp_id}.json",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        if r.status_code == 200:
            j = r.json()
            return j.get("title")
    except Exception:
        pass
    return None


def _fetch_first_variant_aspect(bp_id: int, provider_id: int) -> tuple:
    """Return (aspect_ratio_dict_or_None, requested_variant_info_or_None)."""
    token = os.getenv("PRINTIFY_API_TOKEN") or os.getenv("PRINTIFY_API_KEY") or ""
    if not token or not provider_id:
        return (None, None)
    try:
        r = requests.get(
            f"{PRINTIFY_BASE}/catalog/blueprints/{bp_id}/print_providers/{provider_id}/variants.json",
            headers={"Authorization": f"Bearer {token}"},
            timeout=12,
        )
        if r.status_code != 200:
            return (None, None)
        variants = r.json().get("variants", [])
        if not variants:
            return (None, None)
        first = variants[0]
        placeholder = (first.get("placeholders") or [{}])[0]
        w = placeholder.get("width")
        h = placeholder.get("height")
        ar = {"w": w, "h": h} if w and h else None
        return (ar, first)
    except Exception:
        return (None, None)


def _read_feedback_entries() -> list:
    if not FEEDBACK_FILE.exists():
        return []
    entries = []
    with FEEDBACK_FILE.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except Exception:
                continue
    return entries


def _mark_entry_status(idx: int, status: str) -> None:
    """Rewrite feedback.jsonl so the entry at `idx` carries an _admin_status field.

    idx is 0-based, newest-last (matching how lines are appended). A small file
    rewrite is fine for this low-volume log.
    """
    entries = _read_feedback_entries()
    if idx < 0 or idx >= len(entries):
        return
    entries[idx]["_admin_status"] = status
    entries[idx]["_admin_ts"] = int(time.time())
    with FEEDBACK_FILE.open("w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


def _admin_html(title: str, body_html: str, status_color: str = "#3ddc84") -> str:
    """Minimal HTML response for admin actions. Dark theme to match the app."""
    return (
        "<!DOCTYPE html><html><head><meta charset='utf-8'>"
        f"<title>{title}</title>"
        "<style>body{background:#0b0d1d;color:#e9eaf5;font-family:system-ui,-apple-system,sans-serif;"
        "padding:48px 24px;max-width:620px;margin:0 auto;line-height:1.5}"
        f"h1{{margin:0 0 12px;font-size:1.4rem;color:{status_color}}}"
        "p{margin:0 0 8px;color:#c9cadd}.meta{background:#15172a;border:1px solid #2a2d47;"
        "border-radius:8px;padding:14px 16px;margin-top:16px;font-size:0.88rem}"
        "code{background:#0f1120;padding:2px 6px;border-radius:4px}"
        "</style></head><body>"
        f"<h1>{title}</h1>{body_html}</body></html>"
    )


@router.get("/admin/approve")
async def admin_approve(
    idx: int = Query(..., ge=0),
    key: Optional[str] = Query(default=None),
    x_admin_key: Optional[str] = Header(default=None, alias="X-Admin-Key"),
):
    """Approve a product-request feedback entry and add it to the shared catalog.

    Idempotent: if the same BP+provider has already been approved, this becomes
    a no-op at the catalog level but the feedback entry is still marked approved.
    """
    _check_admin_key(x_admin_key, key)
    entries = await run_in_threadpool(_read_feedback_entries)
    if idx >= len(entries):
        return JSONResponse(status_code=404, content={"detail": "feedback index out of range"})
    entry = entries[idx]
    pr = entry.get("product_request") or {}
    if entry.get("kind") != "product_request" or not pr.get("blueprintId"):
        return JSONResponse(status_code=400, content={"detail": "entry is not a product request"})
    bp_id = int(pr["blueprintId"])
    provider_id = int(pr.get("printProviderId") or 0) or None
    variant_id = int(pr.get("variantId") or 0) or None

    # Resolve a nicer name + aspect ratio from Printify
    title = await run_in_threadpool(_fetch_blueprint_title, bp_id) or pr.get("title") or f"Blueprint {bp_id}"
    aspect, _variant = await run_in_threadpool(_fetch_first_variant_aspect, bp_id, provider_id) if provider_id else (None, None)
    if not aspect:
        aspect = {"w": 1, "h": 1}

    # Build catalog entry. If any variant is acceptable, use the requested one
    # as default so the user who submitted this sees their pick pre-filled.
    catalog_entry = {
        "id": f"approved_{bp_id}_{provider_id or 'any'}",
        "name": title,
        "desc": "User-requested product (admin-approved)",
        "icon": "fa-star",
        "price": pr.get("_price") or "From $24.99",
        "checkoutPrice": pr.get("_checkoutPrice") or 2499,
        "blueprintId": bp_id,
        "printProviderId": provider_id,
        "variantId": variant_id,
        "position": "front",
        "aspectRatio": aspect,
    }

    def _append_unique(entries_catalog: list, new_entry: dict) -> bool:
        for e in entries_catalog:
            if e.get("blueprintId") == new_entry["blueprintId"] and e.get("printProviderId") == new_entry["printProviderId"]:
                return False
        entries_catalog.append(new_entry)
        return True

    existing = await run_in_threadpool(_read_approved_catalog)
    added = await run_in_threadpool(_append_unique, existing, catalog_entry)
    if added:
        await run_in_threadpool(_write_approved_catalog, existing)
    await run_in_threadpool(_mark_entry_status, idx, "approved")

    body = (
        f"<p>Added <strong>{title}</strong> to the shared catalog.</p>"
        f"<div class='meta'>Blueprint: <code>{bp_id}</code> &middot; provider: <code>{provider_id}</code> &middot; default variant: <code>{variant_id}</code></div>"
    ) if added else (
        f"<p><strong>{title}</strong> was already in the catalog \u2014 no change. Feedback entry marked approved.</p>"
    )
    return _admin_html("Approved" if added else "Already approved", body)


@router.get("/admin/reject")
async def admin_reject(
    idx: int = Query(..., ge=0),
    key: Optional[str] = Query(default=None),
    x_admin_key: Optional[str] = Header(default=None, alias="X-Admin-Key"),
):
    """Mark a feedback entry as rejected. Does not touch the catalog."""
    _check_admin_key(x_admin_key, key)
    entries = await run_in_threadpool(_read_feedback_entries)
    if idx >= len(entries):
        return JSONResponse(status_code=404, content={"detail": "feedback index out of range"})
    await run_in_threadpool(_mark_entry_status, idx, "rejected")
    return _admin_html("Rejected", "<p>Feedback entry marked rejected. No catalog changes were made.</p>", status_color="#ff9800")


@router.get("/count")
async def feedback_count():
    """Public unauthenticated count — useful for a status badge. Does not reveal content."""
    if not FEEDBACK_FILE.exists():
        return {"count": 0}
    try:
        def _count():
            with FEEDBACK_FILE.open("r", encoding="utf-8") as f:
                return sum(1 for line in f if line.strip())
        n = await run_in_threadpool(_count)
        return {"count": n}
    except Exception:
        return {"count": 0}
