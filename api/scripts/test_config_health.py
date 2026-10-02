#!/usr/bin/env python3
"""Self-check: /api/health reports missing configuration by name, the startup
log shows the configuration, and CORS and the Origin check share one list (MH-10).

Run: python3 api/scripts/test_config_health.py
"""
import asyncio
import contextlib
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("SOLAR_ARCHIVE_SKIP_HEAVY_IMPORTS", "1")

from api import settings  # noqa: E402


@contextlib.contextmanager
def with_env(**kv):
    old = {k: os.environ.get(k) for k in kv}
    try:
        for k, v in kv.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def health():
    from api.main import api_health
    return json.loads(asyncio.run(api_health()).body)


def test_health_lists_missing_names_only():
    names = settings.REQUIRED_ENV["dev"]
    secret = "sekret-VALUE-XYZ789"
    cleared = {n: None for n in names}
    with with_env(IS_DEV="1", **cleared):
        body = health()
        assert body.get("config", {}).get("missing") == list(names), body
        assert body["status"] == "ok", body
    with with_env(IS_DEV="1", **{**cleared, "PUBLIC_BASE_URL": "https://dev.example", "FEEDBACK_ADMIN_KEY": secret}):
        body = health()
        assert "PUBLIC_BASE_URL" not in body["config"]["missing"], body
        assert "FEEDBACK_ADMIN_KEY" not in body["config"]["missing"], body
        assert secret not in json.dumps(body), "a secret value reached /api/health"
        assert "https://dev.example" not in json.dumps(body), "a value reached /api/health"


def test_health_never_asks_dev_for_shopify():
    with with_env(IS_DEV="1", SHOPIFY_STORE_DOMAIN=None, SHOPIFY_STOREFRONT_ACCESS_TOKEN=None):
        assert not [n for n in health()["config"]["missing"] if n.startswith("SHOPIFY_")]


def test_cors_and_origin_check_share_one_allowlist():
    from api import main, security
    with with_env(ALLOWED_ORIGINS=None):
        assert main.allowed_origins == list(security._allowed_origins())
    text = (ROOT / "api" / "main.py").read_text(encoding="utf-8")
    assert "_DEFAULT_ALLOWED = [" not in text.replace("# _DEFAULT_ALLOWED = [", ""), \
        "main.py still holds its own literal allowlist"
    assert "_allowed_origins" in text, "main.py must build allowed_origins from api/security.py"


def test_startup_log_is_wired():
    text = (ROOT / "api" / "main.py").read_text(encoding="utf-8")
    assert "settings.log_startup()" in text, "main.py does not log the configuration at startup"


def run():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except Exception as ex:  # noqa: BLE001 - report every failure, then exit 1
            failed += 1
            print("FAIL", name, "-", type(ex).__name__, ex)
    if failed:
        print(f"test_config_health: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_config_health: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
