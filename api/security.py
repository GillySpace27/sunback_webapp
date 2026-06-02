"""
Cross-cutting request hardening for Solar Archive.

Centralises three concerns the round-2 security audit (Mira Sokolov)
flagged as P0 on the Printify and feedback endpoints:

1. **Origin allowlist** — `enforce_origin(request)` rejects POSTs whose
   `Origin` (or, fallback, `Referer`) header isn't in the allowlist.
   Backstop against the CORS-`*` exposure: even if a future middleware
   change re-opens CORS, server-side checks still refuse the request.
2. **Per-IP rate-limit** — `enforce_rate_limit(request, key, max, window)`
   trips a 429 when one IP fires more than `max` requests against `key`
   inside a rolling `window` (seconds). In-memory token bucket; we run
   one Render instance, so per-process state is fine.
3. **Beta-mode mutation block** — `enforce_beta_mode_block(reason)`
   refuses calls when `BETA_MODE` is on. The Printify mutating routes
   bill the operator the moment they fire, so during beta the server
   refuses them outright (the client-side BETA banner already swaps
   the button, but the round-2 audit pointed out the endpoint itself
   was wide open).

The allowlist defaults to the production Shopify storefront +
solar-archive.onrender.com + localhost dev origins. Override with the
`ALLOWED_ORIGINS` env var (comma-separated). For Slack-link callbacks
and other server-initiated entry points, callers can opt out per route.
"""

import os
import time
import threading
from typing import Iterable, Optional
from urllib.parse import urlparse

from fastapi import HTTPException, Request


# ────────────────────────────────────────────────
# Origin allowlist
# ────────────────────────────────────────────────

_DEFAULT_ALLOWED_ORIGINS = (
    "https://solar-archive.myshopify.com",
    "https://solar-archive.onrender.com",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


def _allowed_origins() -> tuple[str, ...]:
    raw = os.getenv("ALLOWED_ORIGINS", "").strip()
    if not raw:
        return _DEFAULT_ALLOWED_ORIGINS
    parts = tuple(o.strip().rstrip("/") for o in raw.split(",") if o.strip())
    return parts or _DEFAULT_ALLOWED_ORIGINS


def _origin_of(value: str) -> Optional[str]:
    """Reduce a URL or origin string to scheme://host[:port], lowercased."""
    if not value:
        return None
    try:
        p = urlparse(value)
    except Exception:
        return None
    if not p.scheme or not p.netloc:
        return None
    return f"{p.scheme.lower()}://{p.netloc.lower()}"


def enforce_origin(request: Request) -> None:
    """Reject the request if Origin (or Referer fallback) is not in the
    allowlist. Raises HTTPException(403) on rejection.

    Browsers always send Origin on cross-site POST/fetch. Server-to-server
    callers won't have Origin/Referer; for those, set the
    `X-Internal-Auth` header (matching `INTERNAL_AUTH_TOKEN` env) to
    bypass — used by the Slack approve/reject callbacks.
    """
    internal_token = os.getenv("INTERNAL_AUTH_TOKEN", "").strip()
    if internal_token and request.headers.get("x-internal-auth", "").strip() == internal_token:
        return

    allowed = set(_allowed_origins())
    origin = _origin_of(request.headers.get("origin", ""))
    referer_origin = _origin_of(request.headers.get("referer", ""))

    if origin and origin in allowed:
        return
    if referer_origin and referer_origin in allowed:
        return

    raise HTTPException(
        status_code=403,
        detail="Origin not allowed. This endpoint only accepts requests from the Solar Archive frontend.",
    )


# ────────────────────────────────────────────────
# Per-IP rate-limit (in-memory token bucket)
# ────────────────────────────────────────────────

_rate_state: dict[tuple[str, str], list[float]] = {}
_rate_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    # LAUNCH-BLOCKER fix (workflow wx5fi2brl, xff-rate-limit-bypass):
    # Render APPENDS to X-Forwarded-For rather than replacing it, so the
    # LEFTMOST hop in the header is whatever the CLIENT supplied — easily
    # spoofed to evade rate limits. Read RIGHTMOST instead: Render's edge
    # appends the true peer IP last, and any client-supplied earlier
    # entries are now ignored.
    #
    # Prefer Render's CF-Connecting-IP / Fly-Client-IP equivalent header
    # if present (more reliable than parsing XFF), then fall back to the
    # rightmost XFF hop, then the direct peer.
    cf = request.headers.get("cf-connecting-ip") or request.headers.get("fly-client-ip")
    if cf:
        return cf.strip()
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        # Rightmost entry = the last (most-trusted) proxy hop.
        return xff.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def enforce_rate_limit(
    request: Request,
    key: str,
    max_calls: int,
    window_seconds: float,
) -> None:
    """Sliding-window per-IP rate-limit. Raises HTTPException(429)
    when the caller has exceeded `max_calls` against `key` inside the
    last `window_seconds`.
    """
    ip = _client_ip(request)
    bucket_key = (ip, key)
    now = time.time()
    cutoff = now - window_seconds
    with _rate_lock:
        bucket = _rate_state.setdefault(bucket_key, [])
        # Drop expired hits
        i = 0
        for ts in bucket:
            if ts >= cutoff:
                break
            i += 1
        if i:
            del bucket[:i]
        if len(bucket) >= max_calls:
            retry_after = max(1, int(bucket[0] + window_seconds - now))
            raise HTTPException(
                status_code=429,
                detail=f"Rate limit exceeded. Try again in {retry_after}s.",
                headers={"Retry-After": str(retry_after)},
            )
        bucket.append(now)
        # Opportunistic cleanup so the dict doesn't grow without bound
        # in a long-lived process. Run when this bucket is cheap to
        # touch (i.e., we're already holding the lock).
        if len(_rate_state) > 5000:
            for k in list(_rate_state.keys()):
                v = _rate_state[k]
                if not v or v[-1] < cutoff:
                    _rate_state.pop(k, None)


# ────────────────────────────────────────────────
# Beta-mode mutation block
# ────────────────────────────────────────────────

def _is_beta_mode() -> bool:
    raw = os.getenv("BETA_MODE", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def enforce_beta_mode_block(reason: str = "BETA_MODE is active") -> None:
    """Refuse user-visible monetary paths (Printify publish + checkout)
    while BETA_MODE is on. The frontend already hides the buttons; this
    backstops a direct-API caller (which is exactly what billing-abuse
    looks like).

    Narrowed 2026-05-25: /upload and /product are no longer gated, so
    the "Generate real mockup" flow (upload → create draft → read
    mockup URL → delete draft) works for beta testers. No money or
    shipping is involved in that pipeline. /publish (makes a draft a
    real Shopify listing) and /checkout (initiates the actual sale)
    remain blocked.
    """
    if _is_beta_mode():
        raise HTTPException(
            status_code=403,
            detail=f"This endpoint is disabled during beta. {reason}",
        )
