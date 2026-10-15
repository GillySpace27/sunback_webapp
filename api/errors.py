"""One error envelope for buyer-visible routes (MH-16).

A route raises ``api_error(status, code, detail)``. The response body is
``{"code": <code>, "detail": <detail>}``: ``detail`` stays the operator
string it always was (store code that reads ``detail`` keeps working), and
``code`` is a stable key the store maps to buyer text in ``api/messages.js``.
The status code is unchanged from before the conversion.

Every ``E_*`` constant below must have a key in ``BUYER_MESSAGES`` in
``api/messages.js``; ``infra/scripts/check.sh`` (error_codes) fails otherwise.
"""

from typing import NoReturn, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

E_ORIGIN_FORBIDDEN = "origin_forbidden"
E_RATE_LIMITED = "rate_limited"
E_BETA_MODE_BLOCKED = "beta_mode_blocked"
E_SERVER_BUSY = "server_busy"
E_BAD_REQUEST = "bad_request"
E_PREVIEW_FAILED = "preview_failed"


class ApiError(HTTPException):
    """An HTTPException that also carries a stable error code."""

    def __init__(self, status: int, code: str, detail: str,
                 headers: Optional[dict] = None):
        super().__init__(status_code=status, detail=detail, headers=headers)
        self.code = code


def api_error(status: int, code: str, detail: str,
              headers: Optional[dict] = None) -> NoReturn:
    """Raise an ApiError. ``detail`` is operator text and stays a string."""
    raise ApiError(status, code, str(detail), headers=headers)


async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    """Registered in main.py: returns {"code", "detail"} with the same status."""
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.code, "detail": exc.detail},
        headers=getattr(exc, "headers", None),
    )
