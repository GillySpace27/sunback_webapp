"""Backend configuration in one place (MH-10).

Every environment variable the origin reads as CONFIGURATION is read through
this module. env() is the one reader (the same result as os.getenv, read on
every call); load() builds a typed snapshot; REQUIRED_ENV names what each tier
must have; missing_required() reports names (never values) for /api/health.
Nothing here raises at import or at startup: a misconfigured deploy must still
come up and say so.

Not settings: the variables the app itself sets for third-party libraries
(SSL_CERT_FILE, REQUESTS_CA_BUNDLE, VSO_URL, SUNPY_CONFIGDIR, SUNPY_DOWNLOADDIR,
MPLBACKEND, PYTHONUNBUFFERED). They are written and read back in place;
api/scripts/test_no_stray_env.py lists them.

Secrets are printed as set or unset, never as values, in the startup log and in
/api/health.
"""
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

PRINTIFY_BASE = "https://api.printify.com/v1"


def env(name: str, default: Optional[str] = None) -> Optional[str]:
    """The current value of an environment variable, read on every call. Same
    result as os.getenv(name, default); this is the only os.getenv-style read
    in api/*.py, so one grep finds every configuration input."""
    return os.environ.get(name, default)


def _flag(name: str, default: bool = False) -> bool:
    raw = (env(name) or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return default


def _int(name: str, default: int, floor: Optional[int] = None) -> int:
    try:
        value = int(env(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(floor, value) if floor is not None else value


@dataclass(frozen=True)
class Settings:
    is_dev: bool              # env IS_DEV, only the exact string "1" (set in fly.dev.toml)
    log_level: str            # env LOG_LEVEL, default "INFO" (consumed by MH-24)
    stdout_mirror: bool       # env SOLAR_ARCHIVE_STDOUT_MIRROR, default True (consumed by MH-24)
    public_base_url: str      # env PUBLIC_BASE_URL, stripped, no trailing "/" ("" when unset)
    feedback_data_dir: str    # env FEEDBACK_DATA_DIR, stripped ("" when unset)
    allowed_origins: str      # env ALLOWED_ORIGINS, stripped ("" when unset)
    beta_mode: bool           # env BETA_MODE
    heavy_concurrency: int    # env SOLAR_ARCHIVE_HEAVY_CONCURRENCY, at least 1


def load() -> Settings:
    return Settings(
        is_dev=env("IS_DEV") == "1",
        log_level=((env("LOG_LEVEL") or "INFO").strip().upper() or "INFO"),
        stdout_mirror=_flag("SOLAR_ARCHIVE_STDOUT_MIRROR", True),
        public_base_url=(env("PUBLIC_BASE_URL") or "").strip().rstrip("/"),
        feedback_data_dir=(env("FEEDBACK_DATA_DIR") or "").strip(),
        allowed_origins=(env("ALLOWED_ORIGINS") or "").strip(),
        beta_mode=_flag("BETA_MODE"),
        heavy_concurrency=_int("SOLAR_ARCHIVE_HEAVY_CONCURRENCY", 1, 1),
    )


# Import-time snapshot. Tests that change the environment after import call
# load() again (or use the per-call helpers below).
SETTINGS: Settings = load()

# Names each tier must have, from the lists in the headers of fly.toml (checked
# against `fly secrets list` on 2026-08-22) and fly.dev.toml, plus the [env]
# values both files set. The dev tier has no Shopify name, by construction
# (Gilly, 2026-08-22): never add one. INTERNAL_AUTH_TOKEN is optional on both.
_COMMON = (
    "PUBLIC_BASE_URL", "FEEDBACK_DATA_DIR", "FEEDBACK_ADMIN_KEY", "ALLOWED_ORIGINS",
    "PRINTIFY_API_KEY", "PRINTIFY_SHOP_ID", "SOLAR_ARCHIVE_JSOC_EMAIL",
)
REQUIRED_ENV = {
    "prod": _COMMON + (
        "SHOPIFY_STORE_DOMAIN", "SHOPIFY_STOREFRONT_ACCESS_TOKEN",
        "SHOPIFY_ADMIN_CLIENT_ID", "SHOPIFY_ADMIN_CLIENT_SECRET",
    ),
    "dev": _COMMON,
}

# Printed as set or unset only.
SECRET_NAMES = (
    "FEEDBACK_ADMIN_KEY", "INTERNAL_AUTH_TOKEN", "PRINTIFY_API_KEY", "PRINTIFY_API_TOKEN",
    "PRINTIFY_SHOP_ID", "SOLAR_ARCHIVE_JSOC_EMAIL", "SHOPIFY_STOREFRONT_ACCESS_TOKEN",
    "SHOPIFY_ADMIN_ACCESS_TOKEN", "SHOPIFY_ADMIN_CLIENT_ID", "SHOPIFY_ADMIN_CLIENT_SECRET",
    "RESEND_API_KEY", "FEEDBACK_WEBHOOK_URL", "FEEDBACK_NOTIFY_EMAIL",
)

# Printed with their values.
LOGGED_NAMES = (
    "IS_DEV", "PUBLIC_BASE_URL", "FEEDBACK_DATA_DIR", "ALLOWED_ORIGINS", "SHOPIFY_STORE_DOMAIN",
    "SOLAR_ARCHIVE_HEAVY_CONCURRENCY", "LOG_LEVEL", "BETA_MODE", "PRINTIFY_SSL_VERIFY", "GIT_SHA",
)


def tier() -> str:
    """"dev" where fly.dev.toml sets IS_DEV=1, else "prod". Read per call."""
    return "dev" if env("IS_DEV") == "1" else "prod"


def missing_required(t: Optional[str] = None) -> list:
    """Required names of tier `t` (default: this process's tier) that are unset
    or blank. Names only, in REQUIRED_ENV order; never a value."""
    names = REQUIRED_ENV[t or tier()]
    return [n for n in names if not (env(n) or "").strip()]


def public_base_url() -> str:
    """PUBLIC_BASE_URL without whitespace or a trailing "/"; "" when unset.
    Read per call so tests and ops can flip it without a restart."""
    return (env("PUBLIC_BASE_URL") or "").strip().rstrip("/")


def data_dir() -> Path:
    """Where durable data files live: FEEDBACK_DATA_DIR (a mounted volume, for
    example /var/data), else the webapp root. A directory that cannot be created
    falls back to the webapp root, so a bad mount never 500s an endpoint."""
    default = Path(__file__).resolve().parent.parent
    raw = (env("FEEDBACK_DATA_DIR") or "").strip()
    d = Path(raw) if raw else default
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError:
        d = default
    return d


def config_lines() -> list:
    lines = []
    for name in LOGGED_NAMES:
        value = env(name)
        lines.append(f"[config] {name}={value if value not in (None, '') else 'unset'}")
    for name in SECRET_NAMES:
        lines.append(f"[config] {name}={'set' if (env(name) or '').strip() else 'unset'}")
    lines.append(f"[config] tier={tier()}")
    lines.append(f"[config] missing={missing_required()}")
    return lines


def log_startup() -> None:
    for line in config_lines():
        print(line, flush=True)
