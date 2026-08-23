#!/usr/bin/env bash
# Tiered deploy for myheliograph.com: dev.myheliograph.com first, then prod.
#
#   TARGET=dev  ADMIN_KEY=... ./infra/scripts/deploy.sh
#   TARGET=prod ADMIN_KEY=... ./infra/scripts/deploy.sh
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
  dev|prod) ;;
  *) echo "set TARGET=dev or TARGET=prod (refusing to guess which tier to deploy)" >&2; exit 64 ;;
esac
: "${ADMIN_KEY:?set ADMIN_KEY (the warm-admin / FEEDBACK_ADMIN_KEY value)}"

RUN_STATE=".deploy-run.json"
GIT_SHA="$(git rev-parse HEAD)"
GIT_DIRTY="$(git status --porcelain | head -c1)"

if [ "$TARGET" = "dev" ]; then
  FLY_CONFIG="fly.dev.toml"; FLY_APP="myheliograph-api-dev"
  WRANGLER_ARGS="--env dev";  SITE="https://dev.myheliograph.com"
  export DEV_BUILD=1
else
  FLY_CONFIG="fly.toml";      FLY_APP="myheliograph-api"
  WRANGLER_ARGS="";           SITE="https://myheliograph.com"
fi

echo "### deploying to $TARGET ($SITE) from ${GIT_SHA:0:8}${GIT_DIRTY:+ (WORKING TREE DIRTY)}"

# A dirty tree on prod means the promoted image cannot be reconstructed from
# any commit, which breaks the one guarantee this tiering exists to provide.
if [ "$TARGET" = "prod" ] && [ -n "$GIT_DIRTY" ]; then
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

echo "### 1/6  mockup coverage BEFORE deploy"
CHECK_ONLY=1 ./infra/scripts/sweep_mockups.sh || true   # report-only; never blocks

if [ "${SKIP_FLY:-0}" != "1" ]; then
  if [ "$TARGET" = "dev" ]; then
    echo "### 2/6  fly deploy → $FLY_APP (builds the candidate image)"
    fly deploy --config "$FLY_CONFIG" --app "$FLY_APP" --ha=false --remote-only
    # Pin by DIGEST, not tag. A tag is a mutable pointer; a digest is the
    # bytes that were reviewed, and it is what the tracker later compares
    # prod against to prove the promotion shipped the reviewed artifact.
    # Plain concatenation, not an f-string: backslash escapes are illegal
    # inside f-string expressions before Python 3.12, and this one-liner is
    # already inside single quotes inside "$( )". Verified 2026-08-22.
    IMAGE="$(fly status --app "$FLY_APP" --json \
      | python3 -c 'import json,sys; r=json.load(sys.stdin)["Machines"][0]["image_ref"]; print(r["registry"] + "/" + r["repository"] + "@" + r["digest"])')"
    python3 - "$RUN_STATE" "$GIT_SHA" "$IMAGE" <<'PY'
import json, sys, datetime
path, sha, image = sys.argv[1:4]
json.dump({
    "git_sha": sha,
    "image": image,
    "dev_deployed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}, open(path, "w"), indent=2)
print(f"recorded candidate: {image}")
PY
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
( cd infra/worker && ALLOW_STALE_MIRROR=1 ./build-public.sh && npx --yes wrangler deploy $WRANGLER_ARGS )

# The mockup warm runs on PROD ONLY. Dev serves a seeded cache and falls back
# to canvas mockups for anything missing; warming 648 cells against the same
# Printify shop from two tiers would just make them race.
if [ "$TARGET" = "prod" ] && [ "${SKIP_WARM:-0}" != "1" ]; then
  echo "### 4/6  warm missing mockup cells on the origin (non-blocking)"
  ./infra/scripts/sweep_mockups.sh \
    || echo "  warm did not complete — grid falls back to canvas; check coverage / last_warm"
  echo "### 5/6  re-ship edge with any newly-warmed thumbs"
  ./infra/scripts/pull_fly_assets.sh || true
  ( cd infra/worker && ./build-public.sh && npx --yes wrangler deploy ) || true
elif [ "$TARGET" = "dev" ]; then
  echo "### 4-5/6  warm skipped (dev tier never warms — see comment)"
else
  echo "### 4-5/6  warm skipped (SKIP_WARM=1)"
fi

echo "### 6/6  mockup coverage AFTER"
CHECK_ONLY=1 ./infra/scripts/sweep_mockups.sh || true

echo
echo "deployed $TARGET: $SITE"
[ "$TARGET" = "dev" ] && echo "NEXT: run the review gate (see DEPLOY.md) before TARGET=prod."
exit 0
