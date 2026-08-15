#!/usr/bin/env bash
# Deploy chain that keeps the wavelength x filter x product mockup grid
# self-updating (2026-08-15).
#
# Order matters: the FRONTEND ships to the edge BEFORE the mockup warm, so a
# slow or failing warm can never block a frontend/backend deploy (it did once,
# spinning on a Printify hang while the landing fix sat undeployed). The warm
# is a non-fatal, bounded backfill; the grid falls back to canvas mockups for
# any cell it hasn't populated yet.
#
#   ADMIN_KEY=... ./infra/scripts/deploy.sh
#   SKIP_FLY=1  ADMIN_KEY=... ./infra/scripts/deploy.sh   # edge + warm only
#   SKIP_WARM=1 ADMIN_KEY=... ./infra/scripts/deploy.sh   # code + frontend only
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root (webapp/)
: "${ADMIN_KEY:?set ADMIN_KEY (the warm-admin / FEEDBACK_ADMIN_KEY value)}"

echo "### 1/6  mockup coverage BEFORE deploy"
CHECK_ONLY=1 ./infra/scripts/sweep_mockups.sh || true   # report-only; never blocks

if [ "${SKIP_FLY:-0}" != "1" ]; then
  echo "### 2/6  fly deploy (origin)"
  fly deploy
else
  echo "### 2/6  fly deploy skipped (SKIP_FLY=1)"
fi

echo "### 3/6  ship frontend to the edge (BEFORE the warm)"
./infra/scripts/pull_fly_assets.sh || echo "  (mirror pull failed; shipping frontend anyway)"
( cd infra/worker && ALLOW_STALE_MIRROR=1 ./build-public.sh && npx --yes wrangler deploy )

if [ "${SKIP_WARM:-0}" != "1" ]; then
  echo "### 4/6  warm missing mockup cells on the origin (non-blocking)"
  ./infra/scripts/sweep_mockups.sh \
    || echo "  warm did not complete — grid falls back to canvas; check coverage / last_warm"
  echo "### 5/6  re-ship edge with any newly-warmed thumbs"
  ./infra/scripts/pull_fly_assets.sh || true
  ( cd infra/worker && ./build-public.sh && npx --yes wrangler deploy ) || true
else
  echo "### 4-5/6  warm skipped (SKIP_WARM=1)"
fi

echo "### 6/6  mockup coverage AFTER"
CHECK_ONLY=1 ./infra/scripts/sweep_mockups.sh || true
