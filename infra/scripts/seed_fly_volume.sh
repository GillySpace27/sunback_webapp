#!/usr/bin/env bash
# Seed the Fly volume (/var/data) with the Render disk contents so the
# origin boots with feedback history, stats, and the warm default_cache
# intact. Run AFTER `fly deploy` has a machine up.
#
# Uses fly ssh sftp to push the tarball, then extracts in-place.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="myheliograph-api"
TARBALL="data_mirror/render_var_data.tgz"

[ -f "$TARBALL" ] || { echo "No tarball at $TARBALL — run pull_render_data.sh first"; exit 1; }

echo "Waking the machine..."
curl -s -o /dev/null --max-time 60 "https://${APP}.fly.dev/api/health" || true

echo "Pushing tarball (~$(du -h "$TARBALL" | cut -f1))..."
fly ssh sftp put "$TARBALL" /var/data/seed.tgz -a "$APP"

echo "Extracting on the volume..."
fly ssh console -a "$APP" -C "sh -c 'cd /var/data && tar xzf seed.tgz && rm seed.tgz && ls -la /var/data'"

echo "Done. Verify: curl https://${APP}.fly.dev/asset/default/default_mockups.json | head -c 300"
