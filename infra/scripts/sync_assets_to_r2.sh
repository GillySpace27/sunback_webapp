#!/usr/bin/env bash
# Sync the pre-syncable /asset/default tree into the R2 bucket that the
# Worker serves at myheliograph.com/asset/*.
#
# Source: infra/data_mirror/mirror/default_cache (from pull_render_data.sh).
# Keys:   default/<relative-path>  (Worker maps /asset/<key> → bucket key).
# Skips:  hek/ (server-side only cache) and *.tmp* partials.
#
# Re-run after every /api/admin/warm_default or vibe re-warm — R2 is a
# mirror of the origin's default_cache, not a second source of truth.
#
# Usage: ./sync_assets_to_r2.sh [--dry-run]
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET="heliograph-assets"
SRC="data_mirror/mirror/default_cache"
DRY="${1:-}"

[ -d "$SRC" ] || { echo "No mirror at $SRC — run pull_render_data.sh first"; exit 1; }

count=0
while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"
  case "$rel" in
    hek/*|*.tmp*|.*) continue ;;
  esac
  key="default/$rel"
  if [ "$DRY" = "--dry-run" ]; then
    echo "would put: $key  ($(du -h "$f" | cut -f1))"
  else
    npx --yes wrangler r2 object put "$BUCKET/$key" --file "$f" --remote >/dev/null
    echo "put: $key"
  fi
  count=$((count + 1))
done < <(find "$SRC" -type f -print0)

echo "$count objects."
