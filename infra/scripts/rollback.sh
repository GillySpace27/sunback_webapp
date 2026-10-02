#!/usr/bin/env bash
# Roll one tier back to an earlier deploy recorded in .deploy-ledger.jsonl.
#
#   TARGET=dev  ./infra/scripts/rollback.sh
#   TARGET=prod ./infra/scripts/rollback.sh
#   DRY_RUN=1 TARGET=dev ./infra/scripts/rollback.sh     (prints the plan, changes nothing)
#
# GATED: every run is Gilly's call, per run, dry or real; a prod rollback is a
# prod deploy. The script lists the last five ledger entries for the tier,
# reads the first 8 characters of the SHA to roll back to from stdin, then
# redeploys that entry's Fly image and rolls the Worker back to that entry's
# version, and polls until the origin (/api/build-info) and the edge
# (/build.json) both report that SHA. It prints PARTIAL when they do not.
# Rolling code back does NOT roll back files on the /var/data volume (the
# 2026-08-15 _persist_default_manifest incident): restore those from a
# backup_state.sh folder if the bad deploy changed them.
#
# Exit: 0 done or dry run; 1 refused or partial; 2 no ledger; 64 bad TARGET.
# Env: DRY_RUN, WORKER_VERSION_OVERRIDE (use when the ledger has no worker
# version id), WRANGLER_ROLLBACK_FLAGS (default --yes), ROLLBACK_WAIT_SECONDS
# (180), ROLLBACK_POLL_SECONDS (10).
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root, same idiom as deploy.sh

TARGET="${TARGET:-}"
case "$TARGET" in
  dev)
    FLY_CONFIG="fly.dev.toml"; FLY_APP="myheliograph-api-dev"; WRANGLER_ARGS="--env dev"
    ORIGIN="https://myheliograph-api-dev.fly.dev"
    EDGES="https://dev.myheliograph.com https://myheliograph-router-dev.gilly-22d.workers.dev" ;;
  prod)
    FLY_CONFIG="fly.toml"; FLY_APP="myheliograph-api"; WRANGLER_ARGS=""
    ORIGIN="https://myheliograph-api.fly.dev"
    EDGES="https://myheliograph.com" ;;
  *) echo "set TARGET=dev or TARGET=prod" >&2; exit 64 ;;
esac
DRY_RUN="${DRY_RUN:-0}"
LEDGER=".deploy-ledger.jsonl"
RUN_STATE=".deploy-run.json"
WAIT="${ROLLBACK_WAIT_SECONDS:-180}"
POLL="${ROLLBACK_POLL_SECONDS:-10}"
FLAGS="${WRANGLER_ROLLBACK_FLAGS:---yes}"

# Same idiom as deploy.sh: pinned wrangler once MH-7 adds pins.env.
[ -f infra/scripts/pins.env ] && . infra/scripts/pins.env
WRANGLER="npx --yes wrangler${WRANGLER_VERSION:+@$WRANGLER_VERSION}"

# Last five complete deploys (an image was shipped) for this tier, newest first,
# one tab-separated line each: sha, time, branch, image, worker, edge, action.
# Empty fields are written as "-" so the shell's tab splitting cannot shift them.
ledger_list() {
python3 - "$LEDGER" "$TARGET" <<'PY'
import json, sys
path, target = sys.argv[1:3]
try:
    lines = open(path).read().splitlines()
except OSError:
    lines = []
rows = []
for line in lines:
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if (isinstance(e, dict) and e.get("target") == target and not e.get("dry_run")
            and e.get("image") and isinstance(e.get("git_sha"), str)):
        rows.append(e)
for e in reversed(rows[-5:]):
    print("\t".join((str(e.get(k) or "-") for k in
                     ("git_sha", "time", "branch", "image", "worker_version_id", "edge_code_hash", "action"))))
PY
}
LIST="$(ledger_list)"

if [ -z "$LIST" ]; then
  echo "No ledger entries with an image for TARGET=$TARGET in $LEDGER." >&2
  echo "Fly keeps its own release history (read-only listing follows):" >&2
  fly releases --app "$FLY_APP" || true
  echo "Without a ledger, roll back by hand after Gilly's yes, and note it in CHANGELOG.md:" >&2
  echo "  fly deploy --config $FLY_CONFIG --app $FLY_APP --image <image from the list above> --ha=false" >&2
  echo "  ( cd infra/worker && $WRANGLER rollback <version id> $WRANGLER_ARGS )" >&2
  exit 2
fi

CURRENT_SHA="$(printf '%s\n' "$LIST" | head -n1 | cut -f1)"
echo "Last ledger entries for $TARGET (newest first):"
n=0
while IFS=$'\t' read -r sha time branch image worker edge action; do
  n=$((n + 1))
  mark=""
  if [ "$sha" = "$CURRENT_SHA" ]; then mark="  (live per ledger)"; fi
  digest="${image##*@}"
  printf '  %d  %s  %s  %s  %s  worker %s  edge %s  %s%s\n' "$n" "$time" "${sha:0:8}" "$branch" "${digest:0:19}" "${worker:0:8}" "${edge:0:12}" "$action" "$mark"
done <<< "$LIST"

cat >&2 <<EOF

This changes the live $TARGET tier. It restores code only: files on the
/var/data volume are NOT rolled back (see the 2026-08-15 _persist_default_manifest
incident in DEPLOY.md). Find or take a volume backup first if the bad deploy
wrote there.
EOF
printf 'Type the first 8 characters of the SHA to roll %s back to: ' "$TARGET" >&2
read -r TYPED || TYPED=""
TYPED="$(printf '%s' "$TYPED" | tr 'A-Z' 'a-z' | tr -d '[:space:]')"

PICK=""; IMAGE=""; WORKER=""; EDGE=""
while IFS=$'\t' read -r sha time branch image worker edge action; do
  if [ "$sha" = "$CURRENT_SHA" ]; then continue; fi
  if [ -n "$TYPED" ] && [ "${sha:0:8}" = "$TYPED" ]; then
    PICK="$sha"; IMAGE="$image"; WORKER="$worker"; EDGE="$edge"
    break
  fi
done <<< "$LIST"
if [ -z "$PICK" ]; then
  echo "No listed entry (other than the live one) starts with '$TYPED'. Nothing was changed." >&2
  exit 1
fi
WORKER="${WORKER_VERSION_OVERRIDE:-$WORKER}"
if [ "$WORKER" = "-" ]; then
  echo "The ledger entry for ${PICK:0:8} has no worker_version_id (it was unparsed at deploy time)." >&2
  echo "Find the Worker version id (wrangler versions list), then re-run with WORKER_VERSION_OVERRIDE=<id>. Nothing was changed." >&2
  exit 1
fi

SHORT="${PICK:0:8}"
echo "Plan for $TARGET -> $SHORT:"
echo "  1. fly deploy --config $FLY_CONFIG --app $FLY_APP --image $IMAGE --ha=false"
echo "  2. $WRANGLER rollback $WORKER $WRANGLER_ARGS --message \"rollback to $SHORT\" $FLAGS"
echo "  3. poll $ORIGIN/api/build-info and ${EDGES%% *}/build.json for up to ${WAIT}s until both report $SHORT"
if [ "$DRY_RUN" = "1" ]; then
  echo "### DRY_RUN=1: nothing rolled back."
  exit 0
fi

echo "### origin: fly deploy --image"
if ! fly deploy --config "$FLY_CONFIG" --app "$FLY_APP" --image "$IMAGE" --ha=false; then
  echo "FAILED at the origin step. The edge was not touched. Nothing is recorded." >&2
  exit 1
fi
echo "### edge: wrangler rollback"
if ! $WRANGLER rollback "$WORKER" $WRANGLER_ARGS --message "rollback to $SHORT" $FLAGS; then
  echo "PARTIAL: the origin now runs the $SHORT image but the Worker rollback failed; the edge still serves the newer bundle." >&2
  echo "Read the wrangler error above, then re-run the wrangler line of the plan by hand, or redeploy the newer commit with deploy.sh." >&2
  exit 1
fi

live_sha() {   # print the "sha" field of a JSON endpoint, or nothing
  curl -fsS --max-time 45 "$1?cb=$(date +%s)" 2>/dev/null \
    | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("sha") or "")
except Exception:
    pass' || true
}

echo "### polling origin and edge for up to ${WAIT}s"
deadline=$(( $(date +%s) + WAIT ))
o=""; e=""
while :; do
  o="$(live_sha "$ORIGIN/api/build-info")"
  e=""
  for h in $EDGES; do
    e="$(live_sha "$h/build.json")"
    if [ -n "$e" ]; then break; fi
  done
  if [ "$o" = "$PICK" ] && [ "$e" = "$PICK" ]; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
  sleep "$POLL"
done

if [ "$o" = "$PICK" ] && [ "$e" = "$PICK" ]; then
  echo "ROLLED BACK: origin and edge both report $SHORT."
  python3 - "$LEDGER" "$RUN_STATE" "$TARGET" "$PICK" "$IMAGE" "$WORKER" "$EDGE" "$CURRENT_SHA" <<'PY'
import datetime, json, os, sys
ledger, run_state, target, sha, image, worker, edge, was = sys.argv[1:9]
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
branch = None
for line in open(ledger).read().splitlines():
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if isinstance(e, dict) and e.get("git_sha") == sha and e.get("target") == target:
        branch = e.get("branch")
rec = {"time": now, "target": target, "git_sha": sha, "branch": branch, "image": image,
       "worker_version_id": worker, "edge_code_hash": None if edge == "-" else edge,
       "dry_run": False, "action": "rollback", "rolled_back_from": was}
with open(ledger, "a") as f:
    f.write(json.dumps(rec) + "\n")
if target == "dev":
    # A dev rollback is a recorded dev deploy: keep .deploy-run.json describing what runs.
    try:
        with open(run_state) as f:
            state = json.load(f)
    except (OSError, ValueError):
        state = {}
    state.update({"git_sha": sha, "image": image, "worker_version_id": worker,
                  "edge_code_hash": rec["edge_code_hash"], "dev_deployed_at": now})
    tmp = run_state + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, run_state)
PY
  echo "Recorded in $LEDGER. Check the tracker: python3 .claude/skills/deploy-myheliograph/scripts/status.py"
  exit 0
fi
echo "PARTIAL: origin reports '${o:-nothing}', edge reports '${e:-nothing}', wanted $PICK." >&2
echo "Do not call this rolled back. A pre-MH-8 image reports no sha, which also lands here; check each half by hand and see DEPLOY.md Rollback." >&2
exit 1
