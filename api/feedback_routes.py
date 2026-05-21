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

import hmac
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import re

import requests
from fastapi import APIRouter, HTTPException, Header, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from api.security import enforce_origin, enforce_rate_limit

# Lightweight EmailStr validator wrapper. Pydantic ships EmailStr but
# applying it directly to FeedbackSubmission.email would reject all
# legacy clients posting blank strings. We use this only at the
# reply_to and Slack-context paths to drop spoofy/invalid addresses
# before they reach an outbound email header.
class _EmailValidator(BaseModel):
    e: EmailStr


def _valid_email(value: Optional[str]) -> Optional[str]:
    """Return the address if it parses as a valid email, else None.
    Used to filter `reply_to` so an attacker can't set the From-Reply
    target to `victim@target.com` from a Resend-verified sender."""
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        _EmailValidator(e=s)
        return s
    except ValidationError:
        return None

router = APIRouter(prefix="/feedback", tags=["Feedback"])

# Rate-limit on /feedback POST. The spec values come from the round-2
# audit (Mira Sokolov): even the "free Resend tier blowout" attack
# only needs ~3000 hits/day, so per-IP throttle keeps a single
# attacker from filling the operator's inbox + the disk.
_FEEDBACK_LIMIT = 5
_FEEDBACK_WINDOW = 60.0

# Strict-validate the base64 payload of a `data:image/png;base64,...`
# URI before we splat it into the operator email's <img src="...">.
# Without this check, an attacker can break out of the src attribute
# with a stray quote and inject arbitrary HTML into the operator's
# inbox (XSS in their mail client). We match base64-only chars after
# the prefix.
_BASE64_RE = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")

# Where durable data files live. On Render the default filesystem is
# EPHEMERAL — wiped on every deploy — so feedback.jsonl + the admin-
# approved catalog were silently lost on each redeploy (confirmed:
# /api/feedback/count dropped to 1 after a deploy storm). Point
# FEEDBACK_DATA_DIR at a mounted persistent disk (e.g. /var/data) so
# both files survive deploys. Defaults to the webapp root (one level
# above api/) for local dev, preserving the previous behaviour.
_DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent
def _data_dir() -> Path:
    raw = os.getenv("FEEDBACK_DATA_DIR", "").strip()
    d = Path(raw) if raw else _DEFAULT_DATA_DIR
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        # Mount not ready / not writable — fall back to the default so
        # a misconfigured env var never 500s the feedback endpoint.
        d = _DEFAULT_DATA_DIR
    return d

FEEDBACK_FILE = _data_dir() / "feedback.jsonl"
ADMIN_KEY_ENV = "FEEDBACK_ADMIN_KEY"
WEBHOOK_ENV = "FEEDBACK_WEBHOOK_URL"
# Resend (https://resend.com) email notification — solo operators need
# real-time feedback in their inbox, not a Slack channel. Two env vars:
#   RESEND_API_KEY        — issued at resend.com → API Keys
#   FEEDBACK_NOTIFY_EMAIL — your inbox; comma-separated for multiple
# If either is unset, email notifications are silently skipped — JSONL
# append + Slack webhook still run regardless.
RESEND_API_KEY_ENV = "RESEND_API_KEY"
FEEDBACK_EMAIL_ENV = "FEEDBACK_NOTIFY_EMAIL"
RESEND_FROM_ENV = "RESEND_FROM"  # optional override; default works on Resend's free tier

# Cap one submission at ~8KB so a rogue client can't fill the disk. Individual
# field caps below catch the common abuse (10MB textarea paste, etc.).
_MAX_BODY_CHARS = 4000
_MAX_EMAIL_CHARS = 200
_MAX_NAME_CHARS = 120
_MAX_URL_CHARS = 500
_MAX_CONTEXT_CHARS = 2000


def _log(msg: str) -> None:
    print(msg, flush=True)
    sys.stdout.flush()


class FeedbackSubmission(BaseModel):
    # "comment" = free-text feedback; "product_request" = a specific Printify BP/variant ask.
    # `max_length` on every field rejects huge pastes at the Pydantic
    # parse step (returns 422 to the client) instead of letting them
    # propagate to the email backend or the feedback.jsonl file. The
    # _clamp() pass below is belt-and-suspenders for the legacy clients
    # but new submissions never reach it because Pydantic refuses
    # over-length values up front. A QA beta tester flagged this
    # specifically — "Emoji + 50k-char paste into name/comment".
    kind: str = Field(default="comment", max_length=32)
    body: str = Field(default="", description="The user's message or request note.", max_length=_MAX_BODY_CHARS)
    # Submitter contact info — collected by both feedback tabs so the
    # operator can reply. Optional at the wire level because the
    # background "[Beta design save]" auto-fire from _saveDesignLocally
    # has no human typing into a form; the modal UI requires both.
    name: Optional[str] = Field(default=None, description="Submitter's display name.", max_length=_MAX_NAME_CHARS)
    email: Optional[str] = Field(default=None, description="Reply-to email.", max_length=_MAX_EMAIL_CHARS)
    url: Optional[str] = Field(default=None, description="Page URL at time of submission.", max_length=_MAX_URL_CHARS)
    user_agent: Optional[str] = Field(default=None, max_length=_MAX_URL_CHARS)
    # Page context at submission time (current wavelength / date / product / filter / etc).
    context: Optional[dict] = Field(default=None)
    # Populated only for kind="product_request"
    product_request: Optional[dict] = Field(default=None)
    # Optional base64 PNG data-URI of the editor canvas at submission
    # time. Sent by the frontend when the user hasn't unchecked the
    # "Include a snapshot" checkbox. Embedded in the operator email
    # (as <img src="data:…">) but intentionally NOT persisted to
    # feedback.jsonl — keeps the log file readable and bounded.
    canvas_image: Optional[str] = Field(default=None)


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
    # canvas_image is intentionally NOT clamped to _MAX_BODY_CHARS — a
    # downscaled 800px PNG base64-encodes to ~50-200KB which exceeds the
    # 4KB body cap by a lot. We do enforce an outer cap to keep a rogue
    # client from posting a 50MB payload, and we validate the data-URI
    # prefix so only PNG data sneaks through.
    canvas_image = entry.canvas_image
    if isinstance(canvas_image, str):
        prefix = "data:image/png;base64,"
        if not canvas_image.startswith(prefix):
            canvas_image = None
        elif len(canvas_image) > 2_500_000:  # ~1.8 MB raw PNG
            canvas_image = None
        else:
            # Strict-validate the base64 payload after the prefix.
            # Without this, an attacker can sneak `">` through and
            # break out of the operator email's <img src="..."> ->
            # XSS in the operator's inbox. Audit finding (round 2,
            # Mira Sokolov, P0 HIGH).
            payload = canvas_image[len(prefix):]
            if not _BASE64_RE.match(payload):
                canvas_image = None
    else:
        canvas_image = None
    return {
        "kind": kind,
        "body": _clamp(entry.body, _MAX_BODY_CHARS) or "",
        "name": _clamp(entry.name, _MAX_NAME_CHARS),
        "email": _clamp(entry.email, _MAX_EMAIL_CHARS),
        "url": _clamp(entry.url, _MAX_URL_CHARS),
        "user_agent": _clamp(entry.user_agent, _MAX_URL_CHARS),
        "context": context_clean,
        "product_request": product_request,
        # Held in-memory only — _append_to_disk strips this before writing.
        "canvas_image": canvas_image,
    }


def _append_to_disk(record: dict) -> None:
    FEEDBACK_FILE.parent.mkdir(parents=True, exist_ok=True)
    # canvas_image is sent inline in the operator email but isn't
    # persisted — keeps feedback.jsonl readable + bounded. Strip a
    # copy so the in-memory record still has the image for the email
    # path that runs next.
    persisted = {k: v for k, v in record.items() if k != "canvas_image"}
    with FEEDBACK_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(persisted, ensure_ascii=False) + "\n")


def _public_base_url() -> str:
    """Public URL the admin can click from Slack to approve. Falls back to localhost for dev."""
    return os.getenv("PUBLIC_BASE_URL", "").strip().rstrip("/") or "http://localhost:8000"


def _slack_safe(s) -> str:
    """Neutralise the Slack mrkdwn characters that let an attacker
    inject @channel pings, link syntax, or break formatting from
    user-controlled fields. We strip rather than escape because Slack
    has no canonical mrkdwn escape — backslash isn't honoured.

    Round-2 audit (Mira Sokolov, P1 MEDIUM): the context dict was
    str-concatenated into mrkdwn text with no escape, so
    `context={'<!channel>': 'go'}` pinged the whole channel and link
    syntax `[evil](https://phish)` produced live phishing links.
    """
    if s is None:
        return ""
    return (
        str(s)
        .replace("<", "")
        .replace(">", "")
        .replace("|", "")
        .replace("&", "")
        .replace("*", "")
        .replace("_", "")
        .replace("`", "")
    )


def _format_slack_blocks(record: dict, idx: int) -> dict:
    kind = record.get("kind", "comment")
    header = "New feedback" if kind == "comment" else "New product request"
    parts = [f"*{header}*"]
    body = record.get("body") or ""
    if body:
        parts.append(_slack_safe(body))
    if kind == "product_request":
        pr = record.get("product_request") or {}
        if pr:
            parts.append(
                "Blueprint: `{bp}` · provider: `{pv}` · variant: `{v}`".format(
                    bp=pr.get("blueprintId"), pv=pr.get("printProviderId"), v=pr.get("variantId")
                )
            )
            if pr.get("title"):
                parts.append("Title: " + _slack_safe(pr["title"]))
            # One-click approve / reject links. Admin key is in the query string —
            # PUBLIC_BASE_URL should be an https endpoint in production.
            admin_key = os.getenv(ADMIN_KEY_ENV, "").strip()
            if admin_key:
                base = _public_base_url()
                approve = f"{base}/api/feedback/admin/approve?idx={idx}&key={admin_key}"
                reject = f"{base}/api/feedback/admin/reject?idx={idx}&key={admin_key}"
                parts.append(f"<{approve}|Approve> · <{reject}|Reject>")
    name = record.get("name")
    email = record.get("email")
    if name and email:
        parts.append("From: " + _slack_safe(name) + " <" + _slack_safe(email) + ">")
    elif email:
        parts.append("From: " + _slack_safe(email))
    elif name:
        parts.append("From: " + _slack_safe(name))
    ctx = record.get("context") or {}
    if ctx:
        # Escape both keys AND values — an attacker could set context
        # keys as well, and `<!channel>` works as a key just fine.
        ctx_flat = ", ".join(
            f"{_slack_safe(k)}={_slack_safe(v)}"
            for k, v in ctx.items()
            if v not in (None, "")
        )
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


def _format_email_html(record: dict, idx: int) -> tuple[str, str]:
    """Return (subject, html_body) for the notification email.

    The body lays out the user's message first (what the operator
    actually cares about), then the structured context (date, wave-
    length, product, IP) underneath, then a blueprint-detail block
    when the submission is a product request. Inline CSS is used so
    Gmail/Apple Mail render it cleanly without external assets.
    """
    kind = record.get("kind", "comment")
    body = (record.get("body") or "").strip()
    pr = record.get("product_request") or {}
    # Subject-line prefixes: pick one bracket-tag per submission type so
    # inbox triage is a glance, not a read. Three categories today:
    #   [Product Request]    — explicit "make this product" asks
    #   [Beta Design Save]   — background auto-fire from the download
    #                          button (kind=comment, body starts with
    #                          the literal "[Beta design save] " marker
    #                          set by the client in solar-archive.js)
    #   [Feedback]           — everything else from the comment tab
    if kind == "product_request":
        pr_title = pr.get("title") or f"Blueprint {pr.get('blueprintId')}"
        subject = f"[Product Request] {pr_title}"
        header = "New product request"
    else:
        # Match the client-side marker case-insensitively so a typo
        # ("Beta Design Save", "beta design save") still classifies.
        BETA_MARKER = "[beta design save]"
        if body[: len(BETA_MARKER)].lower() == BETA_MARKER:
            rest = body[len(BETA_MARKER):].strip()
            snippet = rest[:60].replace("\n", " ").strip()
            if len(rest) > 60:
                snippet += "…"
            subject = "[Beta Design Save] " + (snippet or "design")
            header = "Beta design save"
        else:
            # First sentence of the body makes a useful subject preview.
            snippet = body[:60].replace("\n", " ").strip()
            if len(body) > 60:
                snippet += "…"
            subject = "[Feedback] " + (snippet or "New feedback")
            header = "New feedback"

    def _esc(s):
        return (str(s)
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace('"', "&quot;"))

    rows = []
    if body:
        rows.append(
            f'<div style="background:#f5f3ff;border-left:3px solid #7b61ff;'
            f'padding:12px 14px;margin:0 0 16px;border-radius:4px;'
            f'white-space:pre-wrap;font:15px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;'
            f'color:#1f1f2e;">{_esc(body)}</div>'
        )
    # Canvas snapshot — sent inline as a data-URI so the operator sees
    # exactly what the tester was looking at. Gmail/Apple Mail render
    # data: image sources inline; Outlook strips them, but operators
    # using Outlook can still copy-paste the URI into a browser bar.
    canvas_image = record.get("canvas_image")
    if isinstance(canvas_image, str) and canvas_image.startswith("data:image/png;base64,"):
        rows.append(
            f'<div style="margin:0 0 16px;">'
            f'<div style="font:12px -apple-system,sans-serif;color:#9898b8;'
            f'margin:0 0 6px;text-transform:uppercase;letter-spacing:0.04em;">'
            f'Tester’s canvas at submission</div>'
            f'<img src="{canvas_image}" alt="Editor canvas snapshot" '
            f'style="max-width:100%;border-radius:6px;border:1px solid #e2e2ec;display:block;">'
            f'</div>'
        )
    if kind == "product_request" and pr:
        pr_lines = []
        if pr.get("title"):
            pr_lines.append(f"<strong>Title:</strong> {_esc(pr['title'])}")
        if pr.get("brand"):
            pr_lines.append(f"<strong>Brand:</strong> {_esc(pr['brand'])}")
        if pr.get("blueprintId") is not None:
            pr_lines.append(f"<strong>Blueprint ID:</strong> {_esc(pr['blueprintId'])}")
        if pr.get("printProviderId") is not None:
            pr_lines.append(f"<strong>Print provider:</strong> {_esc(pr['printProviderId'])}")
        if pr.get("variantId") is not None:
            pr_lines.append(f"<strong>Variant ID:</strong> {_esc(pr['variantId'])}")
        if pr.get("variantTitle"):
            pr_lines.append(f"<strong>Variant:</strong> {_esc(pr['variantTitle'])}")
        if pr.get("printShape"):
            pr_lines.append(f"<strong>Print shape:</strong> {_esc(pr['printShape'])}")
        if pr_lines:
            rows.append(
                '<div style="font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;'
                'color:#3a3a52;margin:0 0 16px;">'
                + "<br>".join(pr_lines)
                + "</div>"
            )
    name = record.get("name")
    email = record.get("email")
    if name or email:
        # Render From: as one combined line so the operator can hit
        # Reply and the mail client auto-fills with the tester's name.
        # mailto with name uses the standard "Name <addr>" form.
        if name and email:
            mailto = f'mailto:{_esc(email)}?to=' + _esc(name) + ' <' + _esc(email) + '>'
            who = (f'<a href="{mailto}" style="color:#7b61ff;">'
                   f'{_esc(name)}</a> &lt;<a href="mailto:{_esc(email)}" style="color:#7b61ff;">'
                   f'{_esc(email)}</a>&gt;')
        elif email:
            who = (f'<a href="mailto:{_esc(email)}" style="color:#7b61ff;">'
                   f'{_esc(email)}</a>')
        else:
            who = _esc(name)
        rows.append(
            f'<div style="font:14px/1.5 -apple-system,sans-serif;color:#3a3a52;margin:0 0 8px;">'
            f'<strong>From:</strong> {who}</div>'
        )
    ctx = record.get("context") or {}
    if ctx:
        ctx_items = [f"<strong>{_esc(k)}:</strong> {_esc(v)}"
                     for k, v in ctx.items() if v not in (None, "")]
        if ctx_items:
            rows.append(
                '<div style="font:13px/1.6 -apple-system,sans-serif;'
                'color:#6a6a8a;margin:8px 0 16px;">'
                "<br>".join(ctx_items)
                + "</div>"
            )
    if record.get("url"):
        rows.append(
            f'<div style="font:13px/1.5 -apple-system,sans-serif;color:#6a6a8a;margin:0 0 8px;">'
            f'<strong>Page:</strong> <a href="{_esc(record["url"])}" '
            f'style="color:#7b61ff;">{_esc(record["url"])}</a></div>'
        )
    if record.get("ts"):
        from datetime import datetime as _dt, timezone as _tz
        ts_str = _dt.fromtimestamp(int(record["ts"]), tz=_tz.utc).strftime("%Y-%m-%d %H:%M UTC")
        rows.append(
            f'<div style="font:12px -apple-system,sans-serif;color:#9898b8;margin:8px 0 0;">'
            f'#{idx} · {ts_str}</div>'
        )

    html = (
        '<div style="max-width:560px;margin:0 auto;padding:24px;'
        'background:#fff;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">'
        f'<div style="font:600 16px -apple-system,sans-serif;color:#7b61ff;'
        f'letter-spacing:0.04em;text-transform:uppercase;margin:0 0 16px;">{header}</div>'
        + "".join(rows)
        + "</div>"
    )
    return subject, html


def _fire_email_notification(record: dict, idx: int) -> None:
    api_key = os.getenv(RESEND_API_KEY_ENV, "").strip()
    to_raw = os.getenv(FEEDBACK_EMAIL_ENV, "").strip()
    if not api_key or not to_raw:
        return
    to_list = [a.strip() for a in to_raw.split(",") if a.strip()]
    if not to_list:
        return
    # Resend's free tier ships from "onboarding@resend.dev" without any
    # domain verification. If the operator has set up their own verified
    # domain they can override via RESEND_FROM (e.g. "Solar Archive
    # <noreply@solar-archive.com>").
    from_addr = os.getenv(RESEND_FROM_ENV, "").strip() or "Solar Archive <onboarding@resend.dev>"
    try:
        subject, html = _format_email_html(record, idx)
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": from_addr,
                "to": to_list,
                "subject": subject,
                "html": html,
                # If the user filled in their email, set Reply-To so the
                # operator can hit Reply in their mail client and respond
                # directly. Resend also supports an array here.
                # Round-2 audit (Mira Sokolov, P1 MEDIUM): the address
                # was previously passed through unchecked, letting an
                # attacker set reply_to=victim@target.com and turn the
                # operator's Reply into phishing-from-a-verified-sender.
                # `_valid_email` returns None for anything that doesn't
                # parse as a real email; Resend then omits Reply-To.
                "reply_to": _valid_email(record.get("email")),
            },
            timeout=8,
        )
        if resp.status_code >= 400:
            _log(f"[feedback][email] non-2xx: {resp.status_code} {resp.text[:300]}")
    except Exception as e:
        _log(f"[feedback][email] error: {e}")


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
    enforce_origin(request)
    enforce_rate_limit(request, "feedback_submit", _FEEDBACK_LIMIT, _FEEDBACK_WINDOW)
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

    # Same for email — runs in the thread pool so a slow Resend POST
    # doesn't keep the user staring at a spinner. Both notifiers fire
    # independently; either, both, or neither can be configured.
    try:
        await run_in_threadpool(_fire_email_notification, record, idx)
    except Exception as e:
        _log(f"[feedback][email] dispatch error: {e}")

    return {"ok": True, "idx": idx}


def _check_admin_key(header_key: Optional[str], query_key: Optional[str]) -> None:
    expected = os.getenv(ADMIN_KEY_ENV, "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail=f"Admin access disabled — set {ADMIN_KEY_ENV} to enable.")
    provided = (header_key or "").strip() or (query_key or "").strip()
    # Constant-time compare. Round-2 audit (Mira Sokolov, P1 HIGH):
    # the previous `provided != expected` is timing-observable; a
    # determined attacker can recover the key byte-by-byte off the
    # response latency. compare_digest reads both operands fully.
    if not provided or not hmac.compare_digest(provided, expected):
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
# Same persistent-disk treatment as FEEDBACK_FILE — admin-approved
# catalog entries were also ephemeral and lost on every deploy.
APPROVED_CATALOG_FILE = _data_dir() / "approved_catalog.json"


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
