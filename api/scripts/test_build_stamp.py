#!/usr/bin/env python3
"""Self-check: the store build stamp (SU-15). Standard library only; no network; api.main is never imported.

Run: python3 api/scripts/test_build_stamp.py

1. infra/scripts/build_stamp.sh prints YYYY.MM.DD-<sha7> in a throwaway git repository
   (BUILD_STAMP_DATE fixes the date for the first run).
2. infra/scripts/deploy.sh computes the stamp, records build_stamp in .deploy-run.json and passes
   --env BUILD_STAMP=... to both fly deploy calls of the API app (the dev build and the prod
   promotion; the render app is not stamped); SU-3's prod gate block compares the stamp with
   the stamp the dev tier reports.
3. api/main.py: every response dict of api_build_info carries build_stamp beside built, read
   through settings.env (MH-10).
"""
import ast
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
failures = 0


def check(name, cond, detail=""):
    global failures
    if cond:
        print("ok   " + name)
    else:
        print("FAIL " + name + ("  " + detail if detail else ""))
        failures += 1


SCRIPT = ROOT / "infra" / "scripts" / "build_stamp.sh"
check("build_stamp.sh exists", SCRIPT.is_file(), str(SCRIPT))
if SCRIPT.is_file():
    with tempfile.TemporaryDirectory() as tmp:
        repo = pathlib.Path(tmp)
        (repo / "infra" / "scripts").mkdir(parents=True)
        (repo / "infra" / "scripts" / "build_stamp.sh").write_bytes(SCRIPT.read_bytes())
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")
        env.pop("BUILD_STAMP_DATE", None)

        def git(*args):
            return subprocess.run(["git", "-c", "commit.gpgsign=false", *args], cwd=repo, env=env,
                                  capture_output=True, text=True, check=True).stdout.strip()

        def run(extra):
            return subprocess.run(["bash", "infra/scripts/build_stamp.sh"], cwd=repo, env=dict(env, **extra),
                                  capture_output=True, text=True)

        git("init", "-q")
        git("add", "-A")
        git("commit", "-q", "-m", "seed")
        sha7 = git("rev-parse", "--short=7", "HEAD")
        a = run({"BUILD_STAMP_DATE": "2026.10.01"})
        check("build_stamp.sh prints <date>-<sha7>", a.stdout.strip() == f"2026.10.01-{sha7}",
              f"got {a.stdout!r} {a.stderr!r}")
        b = run({})
        check("build_stamp.sh default date is YYYY.MM.DD",
              re.fullmatch(r"\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7,}", b.stdout.strip()) is not None, f"got {b.stdout!r}")
else:
    check("build_stamp.sh prints <date>-<sha7>", False, "script missing")
    check("build_stamp.sh default date is YYYY.MM.DD", False, "script missing")

deploy = (ROOT / "infra" / "scripts" / "deploy.sh").read_text(encoding="utf-8")
check("deploy.sh calls build_stamp.sh", "./infra/scripts/build_stamp.sh" in deploy)
api_fly = [ln for ln in deploy.splitlines() if re.match(r"\s*fly deploy\b", ln)
           and ("--build-arg GIT_SHA" in ln or '--image "$IMAGE"' in ln)]
check("deploy.sh passes --env BUILD_STAMP to both API fly deploy calls",
      len(api_fly) == 2 and all('--env "BUILD_STAMP=$BUILD_STAMP"' in ln for ln in api_fly),
      f"{len(api_fly)} API fly deploy lines: {api_fly}")
check("deploy.sh records build_stamp in .deploy-run.json",
      re.search(r'merge_run_state git_sha "\$GIT_SHA".*build_stamp "\$BUILD_STAMP"', deploy, re.S) is not None)
gate = [ln for ln in deploy.splitlines() if "GATE_ARGS=(--product myheliograph" in ln]
check("deploy.sh gate block uses the build stamp and the dev tier",
      len(gate) == 1 and '--version "$BUILD_STAMP"' in gate[0] and '--version-check "dev-tier=' in deploy
      and '"deploy-run=' not in deploy, str(gate))

main_src = (ROOT / "api" / "main.py").read_text(encoding="utf-8")
fn = next((n for n in ast.walk(ast.parse(main_src))
           if isinstance(n, ast.AsyncFunctionDef) and n.name == "api_build_info"), None)
if fn is None:
    check("api_build_info returns build_stamp beside built", False, "api_build_info not found")
else:
    key_sets = []
    for node in ast.walk(fn):
        if isinstance(node, ast.Dict):
            keys = {k.value for k in node.keys if isinstance(k, ast.Constant)}
            if "built" in keys:
                key_sets.append(keys)
    segment = ast.get_source_segment(main_src, fn) or ""
    check("api_build_info returns build_stamp beside built",
          bool(key_sets) and all("build_stamp" in k for k in key_sets) and 'settings.env("BUILD_STAMP")' in segment,
          f"response dicts with 'built': {len(key_sets)}")

print(f"build stamp self-check: {failures} failed")
sys.exit(1 if failures else 0)
