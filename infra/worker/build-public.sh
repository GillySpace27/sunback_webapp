#!/usr/bin/env bash
# Populate infra/worker/public/ with the static frontend for Workers Static
# Assets. This is the exact file set FastAPI serves via explicit routes
# (api/main.py deliberately has NO static mount of api/ so .py source is
# never served — this whitelist preserves that property; NEVER rsync api/
# wholesale). Legal pages flatten from api/legal/<name>.html to
# public/<name>.html so /privacy etc. resolve via html_handling.
set -euo pipefail
cd "$(dirname "$0")"
API_DIR="../../api"
OUT="public"

rm -rf "$OUT"
mkdir -p "$OUT"

# Core page + ES modules (the /{module}.js whitelist in api/main.py).
for f in index.html solar-archive.js solar-archive.css \
         state.js products.js colors.js mockups.js feedback.js stats.js bundler.js \
         favicon.svg robots.txt sitemap.xml; do
  cp "$API_DIR/$f" "$OUT/$f"
done

# Legal pages: /privacy → privacy.html etc.
for f in "$API_DIR"/legal/*.html; do
  cp "$f" "$OUT/$(basename "$f")"
done

# Landing assets served STATIC from the edge so the landing page + product
# grid + vibe gallery need ZERO backend (no waiting on a cold Fly wake).
# Only the small stuff: the two manifests + mockup thumbs + vibe thumbs.
# The heavy full-res vibe PNGs stay edge-cached-from-Fly (editor-time only,
# by which point the on-load health ping has warmed Fly). Re-run this +
# `wrangler deploy` after any admin warm so these don't go stale.
# ponytail: static-copy, not a sync tool — warms are rare and re-deploy is one line.
DC="data_mirror/mirror/default_cache"
if [ -d "../../$DC" ] || [ -d "../$DC" ]; then
  SRC=$(cd "$(dirname "$0")" && cd ../.. 2>/dev/null && pwd)/$DC
  [ -d "$SRC" ] || SRC=$(cd "$(dirname "$0")" && cd .. && pwd)/$DC
  DEST="$OUT/asset/default"
  mkdir -p "$DEST/mockups"
  cp "$SRC/default_mockups.json" "$DEST/" 2>/dev/null || true
  cp "$SRC/vibe_manifest.json" "$DEST/" 2>/dev/null || true
  cp "$SRC/quality_strip.webp" "$DEST/" 2>/dev/null || true  # landing showcase
  cp "$SRC"/mockups/*.thumb.webp "$DEST/mockups/" 2>/dev/null || true
  # vibe thumbnails (raw_thumb/rhef_thumb per slug) — small, makes the
  # gallery instant too. Full-res *_full.png deliberately excluded.
  for d in "$SRC"/vibe/*/; do
    slug=$(basename "$d"); mkdir -p "$DEST/vibe/$slug"
    cp "$d"raw_thumb.png "$d"rhef_thumb.png "$DEST/vibe/$slug/" 2>/dev/null || true
  done
  echo "static landing assets: $(find "$DEST" -type f | wc -l | tr -d ' ') files, $(du -sh "$DEST" | cut -f1)"
else
  echo "WARN: no default_cache mirror — landing manifests will fall through to Fly (run pull_render_data.sh)"
fi

echo "public/ built:"
du -sh "$OUT"
ls "$OUT"
