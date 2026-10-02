#!/usr/bin/env bash
# One check command for the webapp. Run from anywhere:
#   ./infra/scripts/check.sh                every check
#   ./infra/scripts/check.sh --only a,b     just the named checks
#   ./infra/scripts/check.sh --list         the check names, one per line
# Each check prints one row (PASS, FAIL or SKIP, its name, one reason) and
# the last line is "check.sh: <p> passed, <f> failed, <s> skipped".
# Exit 1 if any check FAILs, else 0. Failure detail goes to stderr.
#
# To add a check: write check_<name>() (return 0 PASS, 1 FAIL, 77 SKIP; print
# one reason line on stdout) and append <name> to CHECKS in the same commit.
# CI (.github/workflows/check.yml) runs exactly this script; it holds no
# secrets, so nothing here may print an environment value.
set -euo pipefail
cd "$(dirname "$0")/../.."           # repo root, same idiom as deploy.sh
PYTHON="${PYTHON:-python3}"
CHECKS=( no_tracked_env py_selfchecks node_selfchecks routes_snapshot import_smoke
         store_syntax worker_syntax whitelist_parity web3d_typecheck
         fixtures_pii claude_md_paths
         playwright_pins
         vendor_drift hsts_agree release_gates_copy )

# Importing api.main starts the render-cache janitor (deletes files older than
# two days under SOLAR_ARCHIVE_OUTPUT_DIR) and creates default_cache/ under
# FEEDBACK_DATA_DIR. Both point at a scratch dir, never at real data. The
# scratch dir is left for the OS to clean.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/check-sh.XXXXXX")"
export SOLAR_ARCHIVE_OUTPUT_DIR="$SCRATCH/output"
export FEEDBACK_DATA_DIR="$SCRATCH/data"
mkdir -p "$SOLAR_ARCHIVE_OUTPUT_DIR" "$FEEDBACK_DATA_DIR"

# Store ES modules served by the origin whitelist (main.py _FRONTEND_MODULES),
# read with ast so nothing is imported. MH-9 replaces this with frontend_modules.txt.
frontend_modules() {
  "$PYTHON" - <<'PY'
import ast
tree = ast.parse(open("api/main.py", encoding="utf-8").read())
for node in tree.body:
    if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "_FRONTEND_MODULES" for t in node.targets):
        print("\n".join(sorted(ast.literal_eval(node.value))))
        break
else:
    raise SystemExit("api/main.py: no module-level _FRONTEND_MODULES assignment")
PY
}

check_no_tracked_env() {
  local hits
  hits="$(git ls-files -- ':(glob)**/.env' ':(glob)**/.env.*')"
  if [ -n "$hits" ]; then
    echo "tracked env file(s): $(printf '%s' "$hits" | tr '\n' ' ')"
    return 1
  fi
  echo "git ls-files lists no .env or .env.*"
}

check_py_selfchecks() {
  local f log n=0 failed=""
  for f in api/scripts/test_*.py; do
    [ -e "$f" ] || continue
    n=$((n + 1))
    log="$SCRATCH/$(basename "$f").log"
    if ! SOLAR_ARCHIVE_OUTPUT_DIR="$(mktemp -d "$SCRATCH/out.XXXXXX")" "$PYTHON" "$f" >"$log" 2>&1; then
      failed="$failed $(basename "$f")"
      { echo "--- $f (last 20 lines)"; tail -n 20 "$log"; } >&2
    fi
  done
  [ "$n" -gt 0 ] || { echo "no api/scripts/test_*.py found"; return 1; }
  [ -z "$failed" ] || { echo "failed:$failed"; return 1; }
  echo "$n file(s) passed"
}

check_node_selfchecks() {
  local f log n=0 failed=""
  for f in api/scripts/test_*.mjs; do
    [ -e "$f" ] || continue
    n=$((n + 1))
    log="$SCRATCH/$(basename "$f").log"
    if ! node "$f" >"$log" 2>&1; then
      failed="$failed $(basename "$f")"
      { echo "--- $f (last 20 lines)"; tail -n 20 "$log"; } >&2
    fi
  done
  [ "$n" -gt 0 ] || { echo "no api/scripts/test_*.mjs found"; return 1; }
  [ -z "$failed" ] || { echo "failed:$failed"; return 1; }
  echo "$n file(s) passed"
}

check_routes_snapshot() {
  local log="$SCRATCH/routes_snapshot.log"
  if "$PYTHON" api/scripts/snapshot_routes.py >"$log" 2>&1; then
    echo "route table matches api/scripts/routes.snapshot.json"
    return 0
  fi
  tail -n 40 "$log" >&2
  echo "route table differs (refresh with snapshot_routes.py --update only in the commit that changes a route)"
  return 1
}

check_import_smoke() {
  local log="$SCRATCH/import_smoke.log"
  if "$PYTHON" -c 'import api.main' >"$log" 2>&1; then
    echo "import api.main ok"
    return 0
  fi
  tail -n 20 "$log" >&2
  echo "import api.main failed"
  return 1
}

# node --check needs ESM syntax recognised: a .mjs copy works on every Node.
check_store_syntax() {
  local mods f d="$SCRATCH/store" n=0 failed=""
  mods="$(frontend_modules)" || { echo "could not read _FRONTEND_MODULES from api/main.py"; return 1; }
  mkdir -p "$d"
  for f in solar-archive.js $mods; do
    n=$((n + 1))
    if ! cp "api/$f" "$d/${f%.js}.mjs" 2>/dev/null; then
      failed="$failed $f(missing)"
      continue
    fi
    node --check "$d/${f%.js}.mjs" 2>>"$SCRATCH/store_syntax.log" || failed="$failed $f"
  done
  if [ -n "$failed" ]; then
    tail -n 20 "$SCRATCH/store_syntax.log" >&2 || true
    echo "failed:$failed"
    return 1
  fi
  echo "$n module(s) parse (solar-archive.js plus the whitelist)"
}

check_worker_syntax() {
  cp infra/worker/src/index.js "$SCRATCH/worker-index.mjs"
  if node --check "$SCRATCH/worker-index.mjs" 2>"$SCRATCH/worker_syntax.log"; then
    echo "infra/worker/src/index.js parses"
    return 0
  fi
  cat "$SCRATCH/worker_syntax.log" >&2
  echo "infra/worker/src/index.js has a syntax error"
  return 1
}

# Until MH-9 makes one list file, the whitelist lives in two places:
# main.py _FRONTEND_MODULES and the copy loop in infra/worker/build-public.sh.
check_whitelist_parity() {
  "$PYTHON" - <<'PY'
import ast, re, sys
tree = ast.parse(open("api/main.py", encoding="utf-8").read())
py = None
for node in tree.body:
    if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "_FRONTEND_MODULES" for t in node.targets):
        py = set(ast.literal_eval(node.value))
m = re.search(r"for f in solar-archive\.js (.*?); do",
              open("infra/worker/build-public.sh", encoding="utf-8").read(), re.S)
if py is None or m is None:
    print("could not find _FRONTEND_MODULES in api/main.py or the copy loop in build-public.sh")
    sys.exit(1)
sh = {t for t in m.group(1).replace("\\", " ").split() if t.endswith(".js")}
if py != sh:
    print("only in main.py: %s; only in build-public.sh: %s"
          % (sorted(py - sh) or "none", sorted(sh - py) or "none"))
    sys.exit(1)
print("%d modules listed identically in main.py and build-public.sh" % len(py))
PY
}

check_web3d_typecheck() {
  local log="$SCRATCH/web3d_typecheck.log"
  if [ ! -d web3d/node_modules ]; then
    echo "web3d/node_modules absent (cd web3d && npm ci)"
    return 77
  fi
  if (cd web3d && npm run typecheck) >"$log" 2>&1; then
    echo "tsc -b --noEmit clean"
    return 0
  fi
  tail -n 30 "$log" >&2
  echo "web3d typecheck failed"
  return 1
}

check_fixtures_pii() {
  local dir="${FIXTURES_DIR:-api/scripts/fixtures}" hits
  if [ ! -d "$dir" ]; then echo "no $dir"; return 77; fi
  hits=$(grep -rnoE '@|[0-9]{1,6} +[A-Za-z0-9.]+( +[A-Za-z0-9.]+)* +(Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Suite|Ste)([ .,"]|$)' "$dir" | cut -d: -f1,2 || true)
  if [ -n "$hits" ]; then
    echo "PII pattern on $(printf '%s\n' "$hits" | wc -l | tr -d ' ') line(s), first at $(printf '%s\n' "$hits" | head -n 1)"
    return 1
  fi
  echo "no @ or street address in $(find "$dir" -type f | wc -l | tr -d ' ') files"
  return 0
}

check_claude_md_paths() {
  local f="${CLAUDE_MD_FILE:-CLAUDE.md}" missing
  if [ ! -f "$f" ]; then echo "no $f"; return 1; fi
  missing=$(CLAUDE_MD_FILE="$f" "$PYTHON" - <<'PY'
import os, re
text = open(os.environ["CLAUDE_MD_FILE"], encoding="utf-8").read()
ext = re.compile(r"\.(md|py|js|mjs|ts|tsx|sh|json|jsonc|toml|txt|css|html|yml)$")
bad = set()
for tok in re.findall(r"`([^`\s]+)`", text):
    if tok.startswith(("http", "/", "~", "-", "$")) or any(c in tok for c in "<>*=()|:"):
        continue
    if "/" not in tok and not ext.search(tok):
        continue
    if not os.path.exists(tok.rstrip("/")):
        bad.add(tok)
print(" ".join(sorted(bad)))
PY
)
  if [ -n "$missing" ]; then echo "$f names missing paths: $missing"; return 1; fi
  echo "every backticked path in $f exists"
  return 0
}

# The Playwright version is written in four places and they must be one number
# (MH-7; projects/solar-archive.md render-service note): render-service's npm
# "playwright", web3d's "playwright-core" spec (no caret), the version locked in
# web3d/package-lock.json, and the tag in render-service/Dockerfile's FROM (a
# trailing @sha256:... digest is allowed).
check_playwright_pins() {
  "$PYTHON" - <<'PY'
import json
import re
import sys

rs = json.load(open("render-service/package.json", encoding="utf-8"))
spec = json.load(open("web3d/package.json", encoding="utf-8"))
lock = json.load(open("web3d/package-lock.json", encoding="utf-8"))
dockerfile = open("render-service/Dockerfile", encoding="utf-8").read()
m = re.search(r"^FROM\s+mcr\.microsoft\.com/playwright:v([0-9][^-@\s]*)-\S+?(?:@sha256:[0-9a-f]{64})?\s*$",
              dockerfile, re.M)
vals = {
    "render-service/package.json playwright": rs.get("dependencies", {}).get("playwright"),
    "web3d/package.json playwright-core": spec.get("devDependencies", {}).get("playwright-core"),
    "web3d/package-lock.json playwright-core": lock.get("packages", {}).get("node_modules/playwright-core", {}).get("version"),
    "render-service/Dockerfile FROM tag": m.group(1) if m else None,
}
if None in vals.values() or len(set(vals.values())) != 1:
    print("; ".join("%s=%s" % kv for kv in vals.items()))
    sys.exit(1)
print("all four agree on playwright %s" % rs["dependencies"]["playwright"])
PY
}

# The committed store vendor files against their SHA256SUMS and, when web3d/node_modules is
# installed, against the node_modules copies (MH-7). Never FAILs: a difference is a WARN in
# the reason, because refresh_vendor.sh is the deliberate way to change them.
check_vendor_drift() {
  if [ ! -d web3d/node_modules ]; then
    echo "web3d/node_modules absent (cd web3d && npm ci)"
    return 77
  fi
  "$PYTHON" - <<'PY'
import hashlib
import pathlib

v = pathlib.Path("infra/worker/vendor")
nm = pathlib.Path("web3d/node_modules")


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


src = v / "SOURCES.txt"
if not src.is_file():
    print("WARN: infra/worker/vendor/SOURCES.txt is missing")
    raise SystemExit(0)
pairs = [ln.split() for ln in src.read_text().splitlines()
         if ln.strip() and not ln.lstrip().startswith("#")]
sums = {}
sf = v / "SHA256SUMS"
if sf.is_file():
    for ln in sf.read_text().splitlines():
        h, _, r = ln.partition("  ")
        if r:
            sums[r.strip()] = h.strip()
notes = []
for rel, node in pairs:
    p, q = v / rel, nm / node
    if not p.is_file():
        notes.append("%s is missing from vendor/" % rel)
        continue
    if sums.get(rel) != sha(p):
        notes.append("%s differs from SHA256SUMS" % rel)
    if q.is_file() and sha(p) != sha(q):
        notes.append("%s differs from node_modules (refresh_vendor.sh on purpose, or node_modules is older)" % rel)
if notes:
    print("WARN: " + "; ".join(notes))
else:
    print("%d vendored files match SHA256SUMS and web3d/node_modules" % len(pairs))
PY
}

# One HSTS owner (MH-10): the Worker. secure() in index.js covers the film and every
# proxied response; _headers covers the Static Assets pages. They must say the same.
# HSTS_INDEX_JS and HSTS_HEADERS_FILE override the paths (used to prove this can fail).
check_hsts_agree() {
  local js="${HSTS_INDEX_JS:-infra/worker/src/index.js}" hf="${HSTS_HEADERS_FILE:-infra/worker/_headers}" a b
  a="$(sed -n 's/.*headers\.set("Strict-Transport-Security", *"\([^"]*\)").*/\1/p' "$js" | head -n1)"
  b="$(sed -n 's/^[[:space:]]*Strict-Transport-Security:[[:space:]]*\(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$hf" | head -n1)"
  if [ -z "$a" ] || [ -z "$b" ]; then
    echo "could not read the Strict-Transport-Security value from $js (${a:-none}) or $hf (${b:-none})"
    return 1
  fi
  if [ "$a" != "$b" ]; then
    echo "HSTS differs: secure() says '$a', _headers says '$b'"
    return 1
  fi
  echo "secure() and _headers agree: $a"
}

# SU-3: the vendored release-gates.sh still matches its sha256 header (canonical copy: HelioFITS).
check_release_gates_copy() {
  if ./infra/scripts/release-gates.sh --verify-copy >/dev/null 2>&1; then
    echo "vendored copy matches its sha256 header"
  else
    echo "infra/scripts/release-gates.sh differs from its vendored header; recopy from HelioFITS"
    return 1
  fi
}

SELECTED=( "${CHECKS[@]}" )
while [ $# -gt 0 ]; do
  case "$1" in
    --list) printf '%s\n' "${CHECKS[@]}"; exit 0 ;;
    --only) [ $# -ge 2 ] || { echo "check.sh: --only needs a comma-separated list" >&2; exit 64; }
            IFS=',' read -r -a SELECTED <<<"$2"; shift 2 ;;
    --only=*) IFS=',' read -r -a SELECTED <<<"${1#--only=}"; shift ;;
    *) echo "check.sh: unknown argument $1 (use --only a,b or --list)" >&2; exit 64 ;;
  esac
done
for name in "${SELECTED[@]}"; do
  case " ${CHECKS[*]} " in
    *" $name "*) ;;
    *) echo "check.sh: unknown check '$name' (see --list)" >&2; exit 64 ;;
  esac
done

pass=0; fail=0; skip=0
for name in "${SELECTED[@]}"; do
  if reason="$("check_$name")"; then rc=0; else rc=$?; fi
  reason="$(printf '%s\n' "$reason" | tail -n 1)"
  case "$rc" in
    0)  status=PASS; pass=$((pass + 1)) ;;
    77) status=SKIP; skip=$((skip + 1)) ;;
    *)  status=FAIL; fail=$((fail + 1)) ;;
  esac
  printf '%-4s %-22s %s\n' "$status" "$name" "$reason"
done
echo "check.sh: $pass passed, $fail failed, $skip skipped"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
