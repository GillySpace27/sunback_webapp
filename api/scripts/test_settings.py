#!/usr/bin/env python3
"""Self-check for api/settings.py (MH-10).

Run: python3 api/scripts/test_settings.py

settings.py is the one place the origin reads its configuration from the
environment. These checks pin: env() behaves exactly like os.getenv, the
tier and the public base URL are read per call, REQUIRED_ENV has no Shopify
name for dev, missing_required() returns names only, and the startup lines
never show a secret value.
"""
import contextlib
import dataclasses
import os
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

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


def test_env_matches_getenv():
    with with_env(MH10_PROBE=None):
        assert settings.env("MH10_PROBE") is None
        assert settings.env("MH10_PROBE", "d") == "d"
    with with_env(MH10_PROBE=""):
        assert settings.env("MH10_PROBE", "d") == "", "an empty value is a value, as with os.getenv"
    with with_env(MH10_PROBE="v"):
        assert settings.env("MH10_PROBE", "d") == "v"


def test_flag_words():
    for word, want in (("1", True), ("true", True), ("YES", True), (" on ", True),
                       ("0", False), ("false", False), ("No", False), ("off", False),
                       ("maybe", None), ("", None)):
        with with_env(MH10_FLAG=word):
            got_true = settings._flag("MH10_FLAG", True)
            got_false = settings._flag("MH10_FLAG", False)
            if want is None:
                assert (got_true, got_false) == (True, False), (word, got_true, got_false)
            else:
                assert got_true is want and got_false is want, (word, got_true, got_false)


def test_load_defaults_and_overrides():
    with with_env(IS_DEV=None, LOG_LEVEL=None, SOLAR_ARCHIVE_STDOUT_MIRROR=None, BETA_MODE=None,
                  SOLAR_ARCHIVE_HEAVY_CONCURRENCY=None, PUBLIC_BASE_URL=None):
        s = settings.load()
        assert s.is_dev is False and s.log_level == "INFO" and s.stdout_mirror is True
        assert s.beta_mode is False and s.heavy_concurrency == 1 and s.public_base_url == ""
    with with_env(IS_DEV="1", LOG_LEVEL=" debug ", SOLAR_ARCHIVE_STDOUT_MIRROR="0", BETA_MODE="On",
                  SOLAR_ARCHIVE_HEAVY_CONCURRENCY="3", PUBLIC_BASE_URL="https://x.example/"):
        s = settings.load()
        assert s.is_dev is True and s.log_level == "DEBUG" and s.stdout_mirror is False
        assert s.beta_mode is True and s.heavy_concurrency == 3 and s.public_base_url == "https://x.example"
    with with_env(SOLAR_ARCHIVE_HEAVY_CONCURRENCY="zero", IS_DEV="true"):
        s = settings.load()
        assert s.heavy_concurrency == 1, "an unparsable concurrency falls back to 1, as main.py L205-207 did"
        assert s.is_dev is False, 'IS_DEV counts only when it is exactly "1", as main.py L4242 did'


def test_settings_is_frozen():
    try:
        settings.SETTINGS.log_level = "X"
    except dataclasses.FrozenInstanceError:
        return
    raise AssertionError("Settings must be frozen")


def test_tier_and_public_base_url_are_read_per_call():
    with with_env(IS_DEV="1"):
        assert settings.tier() == "dev"
    with with_env(IS_DEV=None):
        assert settings.tier() == "prod"
    with with_env(IS_DEV="0"):
        assert settings.tier() == "prod"
    with with_env(PUBLIC_BASE_URL="https://a.example///"):
        assert settings.public_base_url() == "https://a.example"
    with with_env(PUBLIC_BASE_URL=None):
        assert settings.public_base_url() == ""


def test_data_dir_override_and_fallback():
    default = pathlib.Path(settings.__file__).resolve().parent.parent
    d = tempfile.mkdtemp(prefix="settings-data-")
    with with_env(FEEDBACK_DATA_DIR=d + "/sub"):
        assert settings.data_dir() == pathlib.Path(d + "/sub") and pathlib.Path(d, "sub").is_dir()
    with with_env(FEEDBACK_DATA_DIR=None):
        assert settings.data_dir() == default
    with with_env(FEEDBACK_DATA_DIR="/dev/null/not-a-dir"):
        assert settings.data_dir() == default, "an unusable mount must fall back, never raise"


def test_required_env_shape():
    assert set(settings.REQUIRED_ENV) == {"prod", "dev"}
    dev_shopify = [n for n in settings.REQUIRED_ENV["dev"] if n.startswith("SHOPIFY_")]
    assert not dev_shopify, f"the dev tier has no Shopify credentials by construction: {dev_shopify}"
    prod_shopify = [n for n in settings.REQUIRED_ENV["prod"] if n.startswith("SHOPIFY_")]
    assert len(prod_shopify) >= 3, prod_shopify
    for tier, names in settings.REQUIRED_ENV.items():
        assert len(set(names)) == len(names) and all(n.isupper() or "_" in n for n in names), (tier, names)
    assert "PUBLIC_BASE_URL" in settings.REQUIRED_ENV["prod"] and "PUBLIC_BASE_URL" in settings.REQUIRED_ENV["dev"]


def test_required_env_is_covered_by_secrets_names_or_fly_env():
    """Every REQUIRED_ENV name is either a secret listed for that tier's app in
    infra/secrets.names (MH-6) or set in the [env] table of its Fly config, so a
    name cannot be required here yet configured nowhere."""
    try:
        import tomllib
    except ImportError:
        print("     (tomllib needs Python 3.11: UNCHECKED)")
        return
    secrets = {}
    for line in (ROOT / "infra" / "secrets.names").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            app, _, name = line.partition(" ")
            secrets.setdefault(app, set()).add(name.strip())
    for tier, app, toml in (("prod", "myheliograph-api", "fly.toml"), ("dev", "myheliograph-api-dev", "fly.dev.toml")):
        env_names = set(tomllib.loads((ROOT / toml).read_text()).get("env", {}))
        uncovered = [n for n in settings.REQUIRED_ENV[tier] if n not in secrets.get(app, set()) and n not in env_names]
        assert not uncovered, f"{tier}: required but neither a secret of {app} nor in {toml} [env]: {uncovered}"


def test_missing_required_returns_names_only():
    names = settings.REQUIRED_ENV["dev"]
    cleared = {n: None for n in names}
    with with_env(**cleared):
        assert settings.missing_required("dev") == list(names)
    partial = dict(cleared)
    partial["PUBLIC_BASE_URL"] = "https://dev.example"
    partial["FEEDBACK_ADMIN_KEY"] = "   "
    with with_env(**partial):
        got = settings.missing_required("dev")
        assert "PUBLIC_BASE_URL" not in got and "FEEDBACK_ADMIN_KEY" in got, got
        assert all(n in names for n in got), "only required names may appear, never values"
    with with_env(IS_DEV="1", **cleared):
        assert settings.missing_required() == list(names), "default tier follows IS_DEV"


def test_startup_lines_never_show_a_secret():
    secret = "sekret-VALUE-ABC123"
    with with_env(FEEDBACK_ADMIN_KEY=secret, PRINTIFY_API_KEY=secret, SHOPIFY_ADMIN_CLIENT_SECRET=secret,
                  SOLAR_ARCHIVE_JSOC_EMAIL="someone@example.invalid", PUBLIC_BASE_URL="https://pub.example",
                  FEEDBACK_WEBHOOK_URL="https://hooks.example/" + secret, INTERNAL_AUTH_TOKEN=None):
        lines = settings.config_lines()
    text = "\n".join(lines)
    assert secret not in text and "someone@example.invalid" not in text, "a secret value was printed"
    assert "[config] FEEDBACK_ADMIN_KEY=set" in lines, lines
    assert "[config] INTERNAL_AUTH_TOKEN=unset" in lines, lines
    assert "[config] PUBLIC_BASE_URL=https://pub.example" in lines, lines
    assert any(l.startswith("[config] tier=") for l in lines) and any(l.startswith("[config] missing=") for l in lines)


def main():
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
        print(f"test_settings: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_settings: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
