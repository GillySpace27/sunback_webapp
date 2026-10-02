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
         store_syntax worker_syntax whitelist_parity web3d_typecheck )

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
