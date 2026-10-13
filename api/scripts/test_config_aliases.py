#!/usr/bin/env python3
"""Self-check: the old helper names are aliases of api/settings.py (MH-10).

Run: python3 api/scripts/test_config_aliases.py

PRINTIFY_BASE, _public_base_url and the data-directory helper had separate
copies. They now delegate to settings.py; the old names stay (other modules
import them). Only api/feedback_routes.py is converted so far. PENDING lists
the other copies and why they wait (the same reasons as test_no_stray_env.py:
api/main.py is a FREEZE file; api/printify_routes.py waits for BRANCHES.md
Decisions on the two branches that also edit it). Each pending copy is checked
to still be the old one, so converting it forces a test update.
"""
import contextlib
import os
import pathlib
import re
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


def src(name):
    return (ROOT / "api" / name).read_text(encoding="utf-8")


def test_feedback_printify_base_is_an_alias():
    assert re.search(r"(?m)^PRINTIFY_BASE = settings\.PRINTIFY_BASE\b", src("feedback_routes.py")), \
        "feedback_routes.py must alias PRINTIFY_BASE = settings.PRINTIFY_BASE"
    assert '"https://api.printify.com/v1"' not in src("feedback_routes.py"), \
        "feedback_routes.py still holds its own copy of the Printify base URL"
    from api import feedback_routes
    assert feedback_routes.PRINTIFY_BASE == settings.PRINTIFY_BASE == "https://api.printify.com/v1"


def test_feedback_public_base_url_delegates():
    from api import feedback_routes
    with with_env(PUBLIC_BASE_URL="https://pub.example/"):
        assert feedback_routes._public_base_url() == "https://pub.example"
    with with_env(PUBLIC_BASE_URL=None):
        assert feedback_routes._public_base_url() == "http://localhost:8000", "local-dev fallback is kept"
    assert "settings.public_base_url()" in src("feedback_routes.py")


def test_feedback_data_dir_delegates():
    from api import feedback_routes
    assert feedback_routes._data_dir() == settings.data_dir()
    assert "settings.data_dir()" in src("feedback_routes.py")


def test_pending_copies_are_still_the_old_ones():
    # Remove an entry here, and add its checks above, when the file is converted.
    assert '"https://api.printify.com/v1"' in src("printify_routes.py"), \
        "printify_routes.py changed: convert its PRINTIFY_BASE and _public_base_url and update this test"
    assert "def _persistent_data_dir" in src("main.py") and "settings.data_dir()" not in src("main.py"), \
        "main.py changed: update this test"


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
        print(f"test_config_aliases: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_config_aliases: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
