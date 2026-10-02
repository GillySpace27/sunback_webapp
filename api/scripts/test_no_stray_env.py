#!/usr/bin/env python3
"""Self-check: api/*.py reads configuration only through api/settings.py (MH-10).

Run: python3 api/scripts/test_no_stray_env.py

1. No os.getenv( outside api/settings.py, except the files in PENDING.
2. os.environ.get( is allowed only for the variables the app sets for
   third-party libraries and reads back in place (same PENDING exception).
3. Writes (os.environ[...] = ..., setdefault, pop) are not reads and are not
   checked. api/scripts/ (operator tools) is out of scope.
4. Every PENDING file must still need its exemption, so the list cannot rot:
   convert the file, then delete its entry.

PENDING holds the files that cannot be converted yet and why:
  printify_routes.py BRANCHES.md has no Decision for claude/catalog-gc-donations and
                     claude/myheliograph-conversion-review-c05d69, which also edit it
"""
import pathlib
import re
import sys

API = pathlib.Path(__file__).resolve().parents[1]
PLUMBING = {"SUNPY_CONFIGDIR", "SUNPY_DOWNLOADDIR", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "VSO_URL",
            "MPLBACKEND", "PYTHONUNBUFFERED"}
PENDING = {
    "printify_routes.py": "no Decision in BRANCHES.md for the two branches that also edit it",
}


def sources(include_pending=False):
    for p in sorted(API.glob("*.py")):
        if p.name == "settings.py":
            continue
        if p.name in PENDING and not include_pending:
            continue
        yield p, p.read_text(encoding="utf-8")


def test_no_os_getenv_outside_settings():
    counts = {p.name: len(re.findall(r"\bos\.getenv\(", s)) for p, s in sources()}
    bad = {k: v for k, v in counts.items() if v}
    assert not bad, "os.getenv( found: " + ", ".join(f"api/{k}: {v}" for k, v in bad.items())


def test_environ_get_only_for_library_plumbing():
    bad = []
    for p, s in sources():
        for m in re.finditer(r"\bos\.environ\.get\(\s*[\"']([A-Za-z0-9_]+)[\"']", s):
            if m.group(1) not in PLUMBING:
                bad.append(f"api/{p.name}: {m.group(1)}")
    assert not bad, "os.environ.get of a configuration input: " + ", ".join(sorted(set(bad)))


def test_pending_exemptions_are_still_needed():
    stale = []
    for name in PENDING:
        s = (API / name).read_text(encoding="utf-8")
        has_getenv = re.search(r"\bos\.getenv\(", s)
        has_config_get = any(m.group(1) not in PLUMBING for m in
                             re.finditer(r"\bos\.environ\.get\(\s*[\"']([A-Za-z0-9_]+)[\"']", s))
        if not (has_getenv or has_config_get):
            stale.append(name)
    assert not stale, f"converted already, delete from PENDING: {stale}"


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
        print(f"test_no_stray_env: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_no_stray_env: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
