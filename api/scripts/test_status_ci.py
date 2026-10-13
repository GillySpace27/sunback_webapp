#!/usr/bin/env python3
"""Self-check for the ci milestone in status.py (MH-2 Task 5).

Run: python3 api/scripts/test_status_ci.py

Copies status.py into a scratch git repository and puts a stub `gh` first on
PATH, so no GitHub call is made. The stub answers only for the scratch HEAD,
with $FAKE_CONCLUSION. Pins: ci is the first milestone and has HOW text; it is
green only when the check workflow run for HEAD concluded "success"; a failed
run and no run both read red. DEPLOY.md names the same gh command.
"""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / ".claude" / "skills" / "deploy-myheliograph" / "scripts" / "status.py"


def main():
    root = Path(tempfile.mkdtemp(prefix="mh2-status-")).resolve()
    dst = root / ".claude" / "skills" / "deploy-myheliograph" / "scripts" / "status.py"
    dst.parent.mkdir(parents=True)
    shutil.copy(SRC, dst)
    git = ["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@example.invalid",
           "-c", "commit.gpgsign=false"]
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "scratch"], check=True)
    head = subprocess.run(git + ["rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    bindir = root / "bin"
    bindir.mkdir()
    (bindir / "gh").write_text(
        "#!/bin/sh\n"
        "case \" $* \" in *\" " + head + " \"*) printf '%s\\n' \"$FAKE_CONCLUSION\" ;; *) printf '\\n' ;; esac\n")
    (bindir / "gh").chmod(0o755)
    os.environ["PATH"] = f"{bindir}{os.pathsep}{os.environ['PATH']}"

    spec = importlib.util.spec_from_file_location("status_ci_under_test", dst)
    status = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(status)

    checks = {k: c for k, _label, c in status.MILESTONES}
    assert "ci" in checks, "MILESTONES has no ci key"
    assert "ci" in status.HOW, "HOW has no ci entry"
    assert [k for k, _l, _c in status.MILESTONES][0] == "ci", "ci must be the first milestone"
    os.environ["FAKE_CONCLUSION"] = "success"
    assert status.run_ok(checks["ci"]), "ci must be green when the check run for HEAD succeeded"
    os.environ["FAKE_CONCLUSION"] = "failure"
    assert not status.run_ok(checks["ci"]), "ci must be red when the check run for HEAD failed"
    os.environ["FAKE_CONCLUSION"] = ""
    assert not status.run_ok(checks["ci"]), "ci must be red when HEAD has no check run"
    deploy = (ROOT / "DEPLOY.md").read_text(encoding="utf-8")
    assert "gh run list --workflow check.yml --commit" in deploy, "DEPLOY.md lacks the CI line"
    print("test_status_ci: all passed")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as ex:
        print(f"test_status_ci: FAIL {ex}")
        sys.exit(1)
