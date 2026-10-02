#!/usr/bin/env bash
# Tiered deploy for myheliograph.com: dev.myheliograph.com first, then prod.
#
#   TARGET=dev  ADMIN_KEY=... ./infra/scripts/deploy.sh
#   TARGET=prod ADMIN_KEY=... ./infra/scripts/deploy.sh
#   TARGET=render ./infra/scripts/deploy.sh          (print-master render service)
#   DRY_RUN=1 TARGET=prod ./infra/scripts/deploy.sh  (every gate, nothing deployed, no secret)
#
# Prod and render ship only a HEAD that is an ancestor of origin/main
# (gate_prod_ancestry). Never run `fly deploy` or `wrangler deploy` by hand.
#
# The authoritative procedure — including the review gate that belongs
# BETWEEN these two commands — is DEPLOY.md. This script deliberately does
# NOT run the panel or enforce the gate: a script that could self-approve its
# own promotion would be theatre. It records what was deployed; DEPLOY.md and
# the deploy-myheliograph skill decide whether that may be promoted.
#
# WHY IMAGE PROMOTION, NOT TWO BUILDS: prod deploys the exact image digest dev
# was reviewed on, so "what you reviewed is what you shipped" is a verifiable
# fact rather than an assumption about build reproducibility. The digest is
# recorded in .deploy-run.json and the tracker checks prod against it.
#
# Escape hatches (each skips a stage, none skips the gate):
#   SKIP_FLY=1   edge only          SKIP_WARM=1  code + frontend only
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root (webapp/)

TARGET="${TARGET:-}"
case "$TARGET" in
  dev|prod|render) ;;
  *) echo "set TARGET=dev, TARGET=prod or TARGET=render (refusing to guess which tier to deploy)" >&2; exit 64 ;;
esac
DRY_RUN="${DRY_RUN:-0}"
# ADMIN_KEY is required further down, after every gate, so DRY_RUN needs no secret.

RUN_STATE=".deploy-run.json"
GIT_SHA="$(git rev-parse HEAD)"
GIT_DIRTY="$(git status --porcelain | head -c1)"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
WORKER_VERSION_ID=""
WRANGLER_LOG="$(mktemp)"

# Pinned wrangler once MH-7 adds infra/scripts/pins.env; unpinned npx until then.
[ -f infra/scripts/pins.env ] && . infra/scripts/pins.env
WRANGLER="npx --yes wrangler${WRANGLER_VERSION:+@$WRANGLER_VERSION}"

# Read-merge-write of $RUN_STATE. Arguments are key/value pairs; "a.b" sets a
# nested key, "true" is JSON true, "" is null, "@now" is the current UTC time.
# A dev deploy therefore never drops the render key (or any other key).
merge_run_state() {
  python3 - "$RUN_STATE" "$@" <<'PY'
import datetime, json, os, sys
path, args = sys.argv[1], sys.argv[2:]
try:
    with open(path) as f:
        state = json.load(f)
except (OSError, ValueError):
    state = {}
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
for key, raw in zip(args[0::2], args[1::2]):
    value = {"true": True, "": None, "@now": now}.get(raw, raw)
    parent, _, leaf = key.rpartition(".")
    target = state.setdefault(parent, {}) if parent else state
    target[leaf] = value
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, path)
PY
}

# 2026-08-11: a deploy from an unmerged branch, then a deploy from main,
# silently reverted six days of work. Prod (and the render service, which has
# no dev tier) only ships a HEAD that is already an ancestor of origin/main.
gate_prod_ancestry() {
  if ! git fetch --quiet origin main; then
    echo "REFUSING: could not fetch origin/main, so ancestry cannot be checked." >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor HEAD origin/main; then
    echo "REFUSING: HEAD ${GIT_SHA:0:8} is not an ancestor of origin/main (branch $GIT_BRANCH)." >&2
    echo "  2026-08-11: deploying an unmerged branch, then main, silently reverted six days of work." >&2
    echo "  Prod promotes the dev candidate recorded in $RUN_STATE (its git_sha must equal HEAD)," >&2
    echo "  so the dev deploy that feeds a promotion must itself be from origin/main ancestry." >&2
    echo "  Land the branch on main and push main first (pushing main is Gilly's call)." >&2
    exit 1
  fi
}

# render-service/Dockerfile: the base image tag must equal the "playwright"
# version in render-service/package.json. MH-7's check.sh playwright_pins
# widens this to web3d's lockfile; this two-file form is what render needs.
gate_render_playwright() {
  local npm_ver img_ver
  npm_ver="$(python3 -c 'import json;print(json.load(open("render-service/package.json"))["dependencies"]["playwright"])')"
  img_ver="$(sed -n 's|^FROM mcr.microsoft.com/playwright:v\([0-9][0-9.]*\).*|\1|p' render-service/Dockerfile | head -n1)"
  if [ -z "$img_ver" ] || [ "$npm_ver" != "$img_ver" ]; then
    echo "REFUSING: render-service/package.json playwright is '$npm_ver' but the render-service/Dockerfile FROM tag is 'v$img_ver'." >&2
    exit 1
  fi
}

# >>> deploy-ledger (MH-8) >>>
# Append-only record of what each deploy shipped, the edge code hash gate and
# the receipt inputs. Everything here is local files under the repo root; no
# network. .deploy-ledger.jsonl and .deploy-artifacts/ are gitignored and are
# never pruned.
LEDGER=".deploy-ledger.jsonl"
ARTIFACTS=".deploy-artifacts"
EDGE_HASH=""

# ledger_append <image> <worker version id> <edge code hash>: one JSON line,
# never truncated. Empty arguments are recorded as null. DRY_RUN exits before
# any write, so dry_run is always false here.
ledger_append() {
  python3 - "$LEDGER" "$TARGET" "$GIT_SHA" "$GIT_BRANCH" "${1:-}" "${2:-}" "${3:-}" <<'PY'
import datetime, json, sys
path, target, sha, branch, image, worker, edge = sys.argv[1:8]
line = {
    "time": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "target": target, "git_sha": sha, "branch": branch,
    "image": image or None, "worker_version_id": worker or None,
    "edge_code_hash": edge or None, "dry_run": False, "action": "deploy",
}
with open(path, "a") as f:
    f.write(json.dumps(line) + "\n")
PY
}

# The edge code hash dev recorded in $RUN_STATE (empty when absent).
recorded_edge_hash() {
  python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("edge_code_hash") or "")' "$RUN_STATE" 2>/dev/null || true
}

# Hash infra/worker/public/ and keep the per-file list beside the receipt, so a
# later mismatch can name the files. Sets EDGE_HASH.
edge_snapshot() {
  mkdir -p "$ARTIFACTS/$GIT_SHA"
  python3 infra/scripts/bundle_manifest.py infra/worker/public --files > "$ARTIFACTS/$GIT_SHA/edge-files.$TARGET.txt"
  EDGE_HASH="$(head -n1 "$ARTIFACTS/$GIT_SHA/edge-files.$TARGET.txt")"
}

# Prod only: the bundle about to ship must have the code hash dev recorded.
# Warmed assets (asset/default/) are outside the hash, so a normal warmed
# deploy passes. Returns 1 after saying why.
edge_gate_prod() {
  local want
  want="$(recorded_edge_hash)"
  edge_snapshot
  if [ -z "$want" ]; then
    echo "REFUSING: $RUN_STATE has no edge_code_hash, so the edge bundle cannot be compared with the one reviewed on dev." >&2
    echo "  Redeploy to dev with this deploy.sh first." >&2
    return 1
  fi
  if [ "$EDGE_HASH" != "$want" ]; then
    echo "REFUSING: the edge bundle built for prod (${EDGE_HASH:0:12}) differs from the one reviewed on dev (${want:0:12})." >&2
    if [ -f "$ARTIFACTS/$GIT_SHA/edge-files.dev.txt" ]; then
      python3 infra/scripts/bundle_manifest.py infra/worker/public --diff "$ARTIFACTS/$GIT_SHA/edge-files.dev.txt" | sed 's/^/    /' >&2 || true
    else
      echo "  (no $ARTIFACTS/$GIT_SHA/edge-files.dev.txt, so the differing files cannot be named)" >&2
    fi
    echo "  Likely causes: a different web3d/node_modules, or a web3d build that is not deterministic. Warmed mockup assets are outside the hash and are not the cause." >&2
    return 1
  fi
  echo "  edge gate: public/ matches the reviewed dev bundle (${EDGE_HASH:0:12})"
}

# DRY_RUN=1 on prod: compare whatever public/ an earlier build left behind with
# the recorded dev hash. Read-only; a real run rebuilds public/ first.
dry_run_edge_preview() {
  local want have
  if [ ! -d infra/worker/public ]; then
    echo "  edge gate: no infra/worker/public/ from an earlier build, so nothing to preview"
    return 0
  fi
  want="$(recorded_edge_hash)"
  have="$(python3 infra/scripts/bundle_manifest.py infra/worker/public | head -n1)"
  if [ -z "$want" ]; then
    echo "  edge gate: $RUN_STATE has no edge_code_hash; the real run would REFUSE until dev is redeployed"
  elif [ "$have" = "$want" ]; then
    echo "  edge gate: existing public/ matches the reviewed dev bundle (${have:0:12})"
  else
    echo "  edge gate: existing public/ differs from the reviewed dev bundle (${have:0:12} vs ${want:0:12}); a real run rebuilds public/ first, so this is a preview only"
  fi
}
# <<< deploy-ledger (MH-8) <<<

# Worker version id from wrangler deploy output ("Current Version ID: <uuid>",
# wrangler 3 and 4 wording, not verified against every version); empty if absent.
worker_version_from() {
  sed -n 's/.*Current Version ID: *\([0-9A-Fa-f-]\{8,\}\).*/\1/p' "$1" | tail -n1
}

if [ "$TARGET" = "dev" ]; then
  FLY_CONFIG="fly.dev.toml"; FLY_APP="myheliograph-api-dev"
  WRANGLER_ARGS="--env dev";  SITE="https://dev.myheliograph.com"
  export DEV_BUILD=1
elif [ "$TARGET" = "render" ]; then
  FLY_CONFIG="fly.render.toml"; FLY_APP="myheliograph-render"
  WRANGLER_ARGS="";           SITE="(private: Fly network only)"
else
  FLY_CONFIG="fly.toml";      FLY_APP="myheliograph-api"
  WRANGLER_ARGS="";           SITE="https://myheliograph.com"
fi

echo "### deploying to $TARGET ($SITE) from ${GIT_SHA:0:8}${GIT_DIRTY:+ (WORKING TREE DIRTY)}"

# A dirty tree on prod means the promoted image cannot be reconstructed from
# any commit, which breaks the one guarantee this tiering exists to provide.
if [ "$TARGET" != "dev" ] && [ -n "$GIT_DIRTY" ]; then
  echo "REFUSING: working tree is dirty and this is a production promotion." >&2
  echo "A promoted image must map to a real commit. Offending paths:" >&2
  git status --porcelain | sed 's/^/    /' >&2
  # UNTRACKED counts, deliberately. An untracked file under a path the
  # Dockerfile COPYs lands in the image without being in any commit, which
  # breaks the exact guarantee this gate exists to provide. A stray scratch
  # file at the repo root is harmless in itself but still fails here — commit
  # it, delete it, or .gitignore it. Five seconds of tidying beats a
  # promotion nobody can reconstruct.
  echo "  → commit, delete, or .gitignore each of the above." >&2
  exit 1
fi

if [ "$TARGET" = "dev" ]; then
  git fetch --quiet origin main || echo "  (could not fetch origin/main; using the last fetched copy)" >&2
  if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    echo "### dev from unmerged branch $GIT_BRANCH" >&2
    echo "    Prod will refuse to promote this candidate until ${GIT_SHA:0:8} is on origin/main." >&2
  fi
else
  gate_prod_ancestry
fi
if [ "$TARGET" = "render" ]; then
  gate_render_playwright
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "### DRY_RUN=1: gates passed for $TARGET at ${GIT_SHA:0:8} ($GIT_BRANCH); nothing deployed."
  echo "  would append one line to $LEDGER and write $ARTIFACTS/$GIT_SHA/receipt.html"
  case "$TARGET" in
    dev)
      echo "  would run: fly deploy --config $FLY_CONFIG --app $FLY_APP --ha=false --remote-only"
      echo "  would record in $RUN_STATE: git_sha, image, dev_deployed_at, branch, deployed_by_script, worker_version_id, edge_code_hash"
      echo "  would run: web3d build, pull_fly_assets.sh, build-public.sh, edge hash record, $WRANGLER deploy $WRANGLER_ARGS" ;;
    prod)
      CAND_SHA="$(python3 -c 'import json;print(json.load(open(".deploy-run.json"))["git_sha"])' 2>/dev/null || true)"
      if [ "$CAND_SHA" = "$GIT_SHA" ]; then
        echo "  candidate gate: pass ($RUN_STATE records HEAD)"
      else
        echo "  candidate gate: the real run would REFUSE ($RUN_STATE records '${CAND_SHA:0:8}', HEAD is ${GIT_SHA:0:8})"
      fi
      echo "  would run: fly deploy --config $FLY_CONFIG --app $FLY_APP --image <image from $RUN_STATE> --ha=false"
      echo "  would run: web3d build, pull_fly_assets.sh, build-public.sh, edge hash gate, $WRANGLER deploy, mockup warm, edge re-ship"
      dry_run_edge_preview ;;
    render)
      echo "  would run: fly deploy --config $FLY_CONFIG --app $FLY_APP --ha=false --remote-only"
      echo "  would record in $RUN_STATE: render.image, render.git_sha, render.deployed_at" ;;
  esac
  exit 0
fi

if [ "$TARGET" = "render" ]; then
  echo "### render: fly deploy -> $FLY_APP"
  fly deploy --config "$FLY_CONFIG" --app "$FLY_APP" --ha=false --remote-only
  RENDER_IMAGE="$(fly status --app "$FLY_APP" --json \
    | python3 -c 'import json,sys; r=json.load(sys.stdin)["Machines"][0]["image_ref"]; print(r["registry"] + "/" + r["repository"] + "@" + r["digest"])')"
  merge_run_state render.image "$RENDER_IMAGE" render.git_sha "$GIT_SHA" render.deployed_at @now
  ledger_append "$RENDER_IMAGE" "" ""
  echo "deployed render: $RENDER_IMAGE (recorded under render in $RUN_STATE)"
  exit 0
fi

: "${ADMIN_KEY:?set ADMIN_KEY (the warm-admin / FEEDBACK_ADMIN_KEY value)}"

echo "### 1/6  mockup coverage BEFORE deploy"
CHECK_ONLY=1 ./infra/scripts/sweep_mockups.sh || true   # report-only; never blocks

if [ "${SKIP_FLY:-0}" != "1" ]; then
  if [ "$TARGET" = "dev" ]; then
    echo "### 2/6  fly deploy → $FLY_APP (builds the candidate image)"
    fly deploy --config "$FLY_CONFIG" --app "$FLY_APP" --ha=false --remote-only --build-arg GIT_SHA="$GIT_SHA"
    # Pin by DIGEST, not tag. A tag is a mutable pointer; a digest is the
    # bytes that were reviewed, and it is what the tracker later compares
    # prod against to prove the promotion shipped the reviewed artifact.
    # Plain concatenation, not an f-string: backslash escapes are illegal
    # inside f-string expressions before Python 3.12, and this one-liner is
    # already inside single quotes inside "$( )". Verified 2026-08-22.
    IMAGE="$(fly status --app "$FLY_APP" --json \
      | python3 -c 'import json,sys; r=json.load(sys.stdin)["Machines"][0]["image_ref"]; print(r["registry"] + "/" + r["repository"] + "@" + r["digest"])')"
    merge_run_state git_sha "$GIT_SHA" image "$IMAGE" dev_deployed_at @now \
      branch "$GIT_BRANCH" deployed_by_script true worker_version_id ""
    echo "recorded candidate: $IMAGE"
  else
    echo "### 2/6  fly deploy → $FLY_APP (promoting the reviewed image)"
    [ -f "$RUN_STATE" ] || { echo "REFUSING: no $RUN_STATE — deploy to dev first." >&2; exit 1; }
    CAND_SHA="$(python3 -c 'import json;print(json.load(open(".deploy-run.json"))["git_sha"])')"
    IMAGE="$(python3 -c 'import json;print(json.load(open(".deploy-run.json"))["image"])')"
    if [ "$CAND_SHA" != "$GIT_SHA" ]; then
      echo "REFUSING: $RUN_STATE records ${CAND_SHA:0:8} but HEAD is ${GIT_SHA:0:8}." >&2
      echo "You would be shipping an image nobody reviewed at this commit." >&2
      exit 1
    fi
    echo "  promoting $IMAGE"
    fly deploy --config "$FLY_CONFIG" --app "$FLY_APP" --image "$IMAGE" --ha=false
  fi
else
  echo "### 2/6  fly deploy skipped (SKIP_FLY=1)"
fi

echo "### 3/6  ship frontend to the edge (BEFORE the warm)"
# The edge build hard-fails without web3d/dist (shipping without it DELETES the
# live /experience/ tree — 2026-08-15 incident). Build it every deploy; dist is
# gitignored so a fresh checkout always needs this.
( cd web3d && [ -d node_modules ] || npm ci --no-audit --no-fund; npm run build )
./infra/scripts/pull_fly_assets.sh || echo "  (mirror pull failed; shipping frontend anyway)"
( cd infra/worker && ALLOW_STALE_MIRROR=1 ./build-public.sh )
# MH-8: dev records the edge code hash; prod refuses unless its bundle matches dev's.
if [ "$TARGET" = "dev" ]; then
  edge_snapshot
  merge_run_state edge_code_hash "$EDGE_HASH"
  echo "  edge code hash (recorded): ${EDGE_HASH:0:12}"
else
  edge_gate_prod || exit 1
fi
( cd infra/worker && $WRANGLER deploy $WRANGLER_ARGS ) 2>&1 | tee "$WRANGLER_LOG"
WORKER_VERSION_ID="$(worker_version_from "$WRANGLER_LOG")"
if [ "$TARGET" = "dev" ]; then
  merge_run_state worker_version_id "$WORKER_VERSION_ID"
fi
echo "  worker version: ${WORKER_VERSION_ID:-unparsed (recorded as null)}"

# The mockup warm runs on PROD ONLY. Dev serves a seeded cache and falls back
# to canvas mockups for anything missing; warming 648 cells against the same
# Printify shop from two tiers would just make them race.
if [ "$TARGET" = "prod" ] && [ "${SKIP_WARM:-0}" != "1" ]; then
  echo "### 4/6  warm missing mockup cells on the origin (non-blocking)"
  ./infra/scripts/sweep_mockups.sh \
    || echo "  warm did not complete — grid falls back to canvas; check coverage / last_warm"
  echo "### 5/6  re-ship edge with any newly-warmed thumbs"
  ./infra/scripts/pull_fly_assets.sh || true
  if ( cd infra/worker && ./build-public.sh ) && edge_gate_prod; then
    ( cd infra/worker && $WRANGLER deploy ) 2>&1 | tee -a "$WRANGLER_LOG" || true
  else
    echo "  re-ship SKIPPED (build-public.sh failed or the rebuilt edge bundle did not match the reviewed one; see above). The edge keeps the first ship." >&2
  fi
  WORKER_VERSION_ID="$(worker_version_from "$WRANGLER_LOG")"
  echo "  worker version after re-ship: ${WORKER_VERSION_ID:-unparsed}"
elif [ "$TARGET" = "dev" ]; then
  echo "### 4-5/6  warm skipped (dev tier never warms — see comment)"
else
  echo "### 4-5/6  warm skipped (SKIP_WARM=1)"
fi

echo "### 6/6  mockup coverage AFTER"
CHECK_ONLY=1 ./infra/scripts/sweep_mockups.sh || true

# MH-8: one ledger line per finished deploy, then the receipt Gilly reads
# before saying yes to the next step. A failed receipt never fails a deploy.
ledger_append "${IMAGE:-}" "$WORKER_VERSION_ID" "$EDGE_HASH"
python3 infra/scripts/deploy_receipt.py "$GIT_SHA" || echo "  (receipt not written; the deploy itself is unaffected)" >&2
echo "  ledger: $LEDGER ($(wc -l < "$LEDGER" | tr -d ' ') lines)   receipt: $ARTIFACTS/$GIT_SHA/receipt.html"
if [ "$TARGET" = "prod" ]; then
  echo "  To mark this release (printed, not run; pushing the tag needs Gilly's yes): git tag mh-$(date -u +%Y.%m.%d) $GIT_SHA"
fi

echo
echo "deployed $TARGET: $SITE"
[ "$TARGET" = "dev" ] && echo "NEXT: run the review gate (see DEPLOY.md) before TARGET=prod."
exit 0
