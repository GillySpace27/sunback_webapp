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

echo "public/ built:"
du -sh "$OUT"
ls "$OUT"
