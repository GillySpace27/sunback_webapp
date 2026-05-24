#!/usr/bin/env bash
# Render the vibe-grid tiles LOCALLY (a beefier dev box has the memory
# headroom Render's 2 GB Standard instance lacks) and ship the result
# up to /var/data/default_cache/vibe/ via the /api/admin/upload_vibe_bundle
# endpoint.
#
# Usage:
#   1. Start the local dev server in another terminal:  ./run_server
#   2. Source the admin key:                            source ~/.claude/secrets/solar-archive.env
#   3. Run this script:                                 ./api/scripts/warm_and_upload_vibe.sh
#
# Total time: ~25 min for first run (all 5 vibes cold), ~5 min on
# subsequent runs (FITS already cached in ~/.sunpy/data).
#
# Set REMOTE=... to push to a non-default host.
# Set LOCAL=... to point at a non-default local server.

set -euo pipefail

REMOTE="${REMOTE:-https://solar-archive.onrender.com}"
LOCAL="${LOCAL:-http://localhost:8000}"
FORCE="${FORCE:-1}"    # 1 = purge stale cache + manifest before rendering

# Locate the default_cache directory. Mirrors the server's _persistent_data_dir()
# logic: $FEEDBACK_DATA_DIR if set, otherwise webapp-root/default_cache.
WEBAPP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
DEFAULT_DIR="${FEEDBACK_DATA_DIR:-$WEBAPP_DIR}/default_cache"

if [[ -z "${FEEDBACK_ADMIN_KEY:-}" ]]; then
  echo "ERROR: FEEDBACK_ADMIN_KEY not set. Run: source ~/.claude/secrets/solar-archive.env"
  exit 2
fi

# Pre-flight: confirm local server is up.
if ! curl -sf "$LOCAL/api/health" > /dev/null; then
  echo "ERROR: local server not responding at $LOCAL"
  echo "       Start it in another terminal: ./run_server"
  exit 2
fi

# Pre-flight: confirm remote endpoint exists (returns 401 without auth header).
remote_check=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$REMOTE/api/admin/upload_vibe_bundle" || echo "000")
if [[ "$remote_check" != "401" ]]; then
  echo "WARNING: $REMOTE/api/admin/upload_vibe_bundle returned $remote_check (expected 401)."
  echo "         Endpoint may not be deployed yet. Continuing anyway."
fi

# 1. Render locally (sequential, ~5 min per vibe cold, ~30 s warm).
echo "[1/3] Rendering vibes locally via $LOCAL/api/admin/warm_vibe_grid?force=$FORCE"
echo "       (this will take 20–30 min on first run; FITS cache speeds re-runs)"
curl -sS -X POST \
  -H "X-Admin-Key: $FEEDBACK_ADMIN_KEY" \
  --max-time 3600 \
  "$LOCAL/api/admin/warm_vibe_grid?force=$FORCE" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"  warmed={d.get('warmed')} skipped={d.get('skipped')} failed={d.get('failed')}\"); [print(f\"  - {p['slug']}: {p.get('status')}\") for p in d.get('per_vibe', [])]"

# 2. Bundle. Don't gzip-compress PNGs (they're already DEFLATEd internally);
#    pure tar is roughly the same size and faster to make.
BUNDLE="${TMPDIR:-/tmp}/vibe_bundle.tar.gz"
echo "[2/3] Bundling $DEFAULT_DIR/{vibe,vibe_manifest.json} -> $BUNDLE"
if [[ ! -d "$DEFAULT_DIR/vibe" ]] || [[ ! -f "$DEFAULT_DIR/vibe_manifest.json" ]]; then
  echo "ERROR: expected $DEFAULT_DIR/vibe + $DEFAULT_DIR/vibe_manifest.json after local warm"
  exit 1
fi
tar czf "$BUNDLE" -C "$DEFAULT_DIR" vibe vibe_manifest.json
SIZE=$(du -h "$BUNDLE" | cut -f1)
echo "       bundle size: $SIZE"

# 3. Ship. Server unpacks under DEFAULT_CACHE_DIR via /api/admin/upload_vibe_bundle.
echo "[3/3] Uploading to $REMOTE/api/admin/upload_vibe_bundle"
curl -sS -X POST \
  -H "X-Admin-Key: $FEEDBACK_ADMIN_KEY" \
  -H "Content-Type: application/gzip" \
  --data-binary "@$BUNDLE" \
  --max-time 300 \
  "$REMOTE/api/admin/upload_vibe_bundle" \
  | python3 -m json.tool

echo
echo "Done. Refresh the landing page to see the new vibes; check the manifest at"
echo "      $REMOTE/asset/default/vibe_manifest.json"
