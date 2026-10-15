#!/usr/bin/env python3
"""Self-check for the MH-16 error envelope (api/errors.py).

Run: python3 api/scripts/test_errors.py

A buyer-visible refusal keeps its status and its operator ``detail`` string
and gains a stable ``code``; main.py routes ApiError through the handler that
returns {"code", "detail"}.
"""
import asyncio
import json
import os
import sys
import tempfile

_d = tempfile.mkdtemp(prefix="errors-test-")
os.environ["SOLAR_ARCHIVE_OUTPUT_DIR"] = os.path.join(_d, "output")
os.environ["FEEDBACK_DATA_DIR"] = os.path.join(_d, "data")
os.makedirs(os.environ["SOLAR_ARCHIVE_OUTPUT_DIR"], exist_ok=True)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("SOLAR_ARCHIVE_SKIP_HEAVY_IMPORTS", "1")
os.environ.pop("ALLOWED_ORIGINS", None)
os.environ.pop("INTERNAL_AUTH_TOKEN", None)

from fastapi import HTTPException  # noqa: E402
from starlette.requests import Request  # noqa: E402

import api.main as m  # noqa: E402
from api import errors, security  # noqa: E402


def _request(origin):
    headers = [(b"origin", origin.encode())] if origin else []
    return Request({"type": "http", "method": "POST", "path": "/api/generate",
                    "headers": headers, "query_string": b""})


def _body(exc):
    resp = asyncio.run(errors.api_error_handler(_request(""), exc))
    return resp.status_code, json.loads(resp.body), resp.headers


def test_foreign_origin_gets_the_envelope():
    try:
        security.enforce_origin(_request("https://evil.example"))
    except errors.ApiError as exc:
        status, body, _ = _body(exc)
        assert status == 403, status
        assert body["code"] == errors.E_ORIGIN_FORBIDDEN, body
        assert isinstance(body["detail"], str) and "Origin not allowed" in body["detail"], body
        assert set(body) == {"code", "detail"}, body
    else:
        raise AssertionError("a foreign Origin was accepted")


def test_allowed_origin_passes():
    security.enforce_origin(_request("https://myheliograph.com"))


def test_api_error_is_still_an_httpexception_and_keeps_headers():
    try:
        errors.api_error(429, errors.E_RATE_LIMITED, "Rate limit exceeded. Try again in 5s.",
                         headers={"Retry-After": "5"})
    except HTTPException as exc:  # existing `except HTTPException: raise` sites still see it
        status, body, headers = _body(exc)
        assert status == 429 and body["code"] == "rate_limited", (status, body)
        assert headers.get("retry-after") == "5", dict(headers)
    else:
        raise AssertionError("api_error did not raise")


def test_main_registers_the_handler():
    assert m.app.exception_handlers.get(errors.ApiError) is errors.api_error_handler


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok  %s" % name)
    print("all error envelope checks passed")
