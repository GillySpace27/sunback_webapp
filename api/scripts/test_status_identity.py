#!/usr/bin/env python3
"""Self-check for the Build identity block of the deploy tracker (MH-8).

Run: python3 api/scripts/test_status_identity.py

status.py is imported from its path with _get_json replaced, so no request
leaves the machine.
"""
import importlib.util
import os
import pathlib
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / ".claude" / "skills" / "deploy-myheliograph" / "scripts" / "status.py"
spec = importlib.util.spec_from_file_location("status_under_test", SRC)
status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(status)

A = "a" * 40
B = "b" * 40


def fake(table):
    def _get_json(url, timeout=45):
        for needle, value in table.items():
            if needle in url:
                return value
        return None
    return _get_json


def test_ok_skew_and_unknown_lines():
    status._get_json = fake({
        "myheliograph-api.fly.dev/api/build-info": {"sha": A, "tier": "prod"},
        "https://myheliograph.com/build.json": {"sha": A},
        "myheliograph-api-dev.fly.dev/api/build-info": {"sha": A, "tier": "dev"},
        "dev.myheliograph.com/build.json": {"sha": B},
    })
    assert status.build_identity_lines() == [
        f"prod: origin {A[:8]} edge {A[:8]} OK",
        f"dev: origin {A[:8]} edge {B[:8]} SKEW",
    ], status.build_identity_lines()
    status._get_json = fake({
        "myheliograph-api.fly.dev/api/build-info": {"built": "2026-09-01T00:00:00Z"},
        "https://myheliograph.com/build.json": {"sha": A},
    })
    lines = status.build_identity_lines()
    assert lines[0] == f"prod: origin none edge {A[:8]} UNKNOWN", lines[0]
    assert lines[1] == "dev: origin none edge none UNKNOWN", lines[1]


def test_dev_edge_falls_back_to_the_workers_dev_host():
    status._get_json = fake({
        "myheliograph-api-dev.fly.dev/api/build-info": {"sha": B},
        "myheliograph-router-dev.gilly-22d.workers.dev/build.json": {"sha": B},
    })
    rows = {r["tier"]: r for r in status.build_identity()}
    assert rows["dev"]["state"] == "OK" and rows["dev"]["edge"] == B, rows["dev"]
    assert set(rows["dev"]) == {"tier", "origin", "edge", "state", "line"}, sorted(rows["dev"])


def test_newest_receipt():
    old_repo = status.REPO
    try:
        status.REPO = tempfile.mkdtemp(prefix="status-receipt-")
        assert status.newest_receipt() is None, "no receipts yet must give None"
        paths = []
        for i, name in enumerate(("111", "222")):
            d = pathlib.Path(status.REPO) / ".deploy-artifacts" / name
            d.mkdir(parents=True)
            f = d / "receipt.html"
            f.write_text("x")
            os.utime(f, (time.time() - 100 + i * 10, time.time() - 100 + i * 10))
            paths.append(str(f))
        assert status.newest_receipt() == paths[1], status.newest_receipt()
    finally:
        status.REPO = old_repo


def test_json_and_render_are_wired():
    text = SRC.read_text()
    assert '"build_identity": build_identity()' in text, "--json output has no build_identity key"
    assert '"Build identity"' in text and "Newest receipt:" in text, "render() does not print the block"


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
        print(f"test_status_identity: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_status_identity: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
