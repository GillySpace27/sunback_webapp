#!/usr/bin/env python3
"""Self-check for /api/build-info (MH-8). The Dockerfile half is test_dockerfile_git_sha.py.

Run: python3 api/scripts/test_build_info.py

The origin must say which commit built it (GIT_SHA, baked into the image by
deploy.sh --build-arg) and which tier it is (IS_DEV == "1" only in
fly.dev.toml), with the original "built" key untouched.
"""
import asyncio
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("SOLAR_ARCHIVE_SKIP_HEAVY_IMPORTS", "1")

from api.main import api_build_info  # noqa: E402

SHA = "0123456789abcdef0123456789abcdef01234567"


def call(**env):
    for k in ("GIT_SHA", "IS_DEV"):
        os.environ.pop(k, None)
    os.environ.update(env)
    return json.loads(asyncio.run(api_build_info()).body)


def test_sha_reported():
    d = call(GIT_SHA=SHA)
    assert d.get("sha") == SHA, f"build-info sha is {d.get('sha')!r}, want {SHA}; body {d}"


def test_sha_null_when_unset():
    d = call()
    assert "sha" in d and d["sha"] is None, f'build-info has no "sha": null key: {d}'


def test_sha_null_when_unknown():
    d = call(GIT_SHA="unknown")
    assert "sha" in d and d["sha"] is None, f'GIT_SHA=unknown must give "sha": null, got {d}'


def test_sha_null_when_not_hex():
    d = call(GIT_SHA="main; echo hi")
    assert "sha" in d and d["sha"] is None, f'a non-hex GIT_SHA must give "sha": null, got {d}'


def test_tier_follows_is_dev():
    assert call(IS_DEV="1").get("tier") == "dev", "tier is not 'dev' for IS_DEV=1"
    assert call().get("tier") == "prod", "tier is not 'prod' when IS_DEV is unset"
    assert call(IS_DEV="0").get("tier") == "prod", "tier is not 'prod' for IS_DEV=0"


def test_built_key_kept():
    d = call()
    assert "built" in d, f'the original "built" key is gone: {d}'
    assert d["built"] is None or d["built"].endswith("Z"), d["built"]


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
        print(f"test_build_info: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_build_info: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
