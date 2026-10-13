#!/usr/bin/env python3
"""Self-check for infra/scripts/deploy_receipt.py (MH-8).

Run: python3 api/scripts/test_deploy_receipt.py

Builds a scratch git repo with three commits, a ledger and two capture
folders, and checks the receipt: commit range since the last prod promotion,
both capture columns, no external request, no em dash, HTML escaping.
"""
import importlib.util
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra" / "scripts" / "deploy_receipt.py"
spec = importlib.util.spec_from_file_location("deploy_receipt", SCRIPT)
dr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dr)  # FileNotFoundError until the script exists

GENV = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
            GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")


def git(root, *args):
    r = subprocess.run(["git", "-C", str(root), "-c", "commit.gpgsign=false", *args],
                       capture_output=True, text=True, env=GENV, check=True)
    return r.stdout.strip()


def scratch():
    root = pathlib.Path(tempfile.mkdtemp(prefix="receipt-"))
    git(root, "init", "-q")
    shas = []
    for subject in ("first commit", "second commit", "fix <script>alert(1)</script> & more"):
        git(root, "commit", "-q", "--allow-empty", "-m", subject)
        shas.append(git(root, "rev-parse", "HEAD"))
    import json
    rows = [
        {"time": "2026-10-01T10:00:00Z", "target": "prod", "git_sha": shas[0], "branch": "main",
         "image": "reg/app@sha256:" + "1" * 64, "worker_version_id": "prodworker-1",
         "edge_code_hash": "e" * 64, "dry_run": False, "action": "deploy"},
        {"time": "2026-10-02T10:00:00Z", "target": "dev", "git_sha": shas[2], "branch": "claude/x",
         "image": "reg/app-dev@sha256:" + "2" * 64, "worker_version_id": "devworker-2",
         "edge_code_hash": "d" * 64, "dry_run": False, "action": "deploy"},
    ]
    (root / ".deploy-ledger.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows) + "not json\n")
    for tier, names in (("dev", ("a.png", "b.png")), ("prod", ("a.png",))):
        d = root / ".deploy-shots" / tier
        d.mkdir(parents=True)
        for n in names:
            (d / n).write_bytes(b"\x89PNG")
    return root, shas


def test_receipt_content():
    root, shas = scratch()
    html = dr.build_receipt(root, shas[2])
    assert shas[2][:8] in html, "short sha missing"
    assert "devworker-2" in html and "sha256:" + "2" * 12 in html, "dev worker version or digest missing"
    assert "second commit" in html, "commit range must include the second commit"
    assert "first commit" not in html, "commit range must start after the last prod promotion (first commit)"
    assert html.count("<img ") == 3, f"want 3 images (a.png dev+prod, b.png dev), got {html.count('<img ')}"
    assert "no capture" in html, "b.png has no prod capture; the cell must say so"
    assert "../../.deploy-shots/dev/a.png" in html, "image paths must be relative to .deploy-artifacts/<sha>/"


def test_no_external_requests_and_no_em_dash():
    root, shas = scratch()
    html = dr.build_receipt(root, shas[2])
    assert not re.search(r"""(?:src|href)\s*=\s*["']https?:""", html), "external src or href"
    assert not re.search(r"url\(\s*[\"']?https?:", html), "external url()"
    assert "@import" not in html, "@import pulls a stylesheet"
    assert chr(0x2014) not in html, "em dash in the receipt"


def test_html_is_escaped():
    root, shas = scratch()
    html = dr.build_receipt(root, shas[2])
    assert "<script>alert(1)</script>" not in html, "commit subject was not escaped"
    assert "&lt;script&gt;" in html, "escaped subject missing"


def test_check_summary_is_read_not_run():
    root, shas = scratch()
    d = root / ".deploy-artifacts" / shas[2]
    d.mkdir(parents=True)
    (d / "check-summary.txt").write_text("check.sh: 9 passed, 0 failed, 1 skipped\n")
    html = dr.build_receipt(root, shas[2])
    assert "check.sh: 9 passed, 0 failed, 1 skipped" in html, "recorded summary missing"


def test_existing_receipt_is_renamed_not_overwritten():
    root, shas = scratch()
    assert dr.main([shas[2], "--root", str(root)]) == 0
    assert dr.main([shas[2], "--root", str(root)]) == 0
    d = root / ".deploy-artifacts" / shas[2]
    names = sorted(p.name for p in d.iterdir() if p.name.startswith("receipt"))
    assert "receipt.html" in names and len(names) == 2, names


def test_unknown_commit_exits_2():
    root, _ = scratch()
    assert dr.main(["deadbeef" * 5, "--root", str(root)]) == 2


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
        print(f"test_deploy_receipt: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_deploy_receipt: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
