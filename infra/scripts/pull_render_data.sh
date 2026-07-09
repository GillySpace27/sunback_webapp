#!/usr/bin/env bash
# Pull the full /var/data tree off the Render persistent disk over SSH.
# Produces infra/data_mirror/render_var_data.tgz + an extracted mirror/.
#
# Prereq: your SSH public key added at dashboard.render.com → Account
# Settings → SSH Public Keys (Render SSH uses account keys, not service
# config). Test with:  ssh srv-d478g9i4d50c73809e60@ssh.oregon.render.com true
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data_mirror
cd data_mirror

SSH_TARGET="srv-d478g9i4d50c73809e60@ssh.oregon.render.com"

# Exclude: events/ (orphaned jpg_thumb tree ~500MB, not in any manifest),
# macOS ._* AppleDouble junk, and output/data (regenerable raw-FITS cache).
echo "Tarring /var/data on Render (~360 MB, a few minutes)..."
ssh "$SSH_TARGET" "cd /var/data && tar czf - --exclude='*/events' --exclude='._*' --exclude='output/data' ." > render_var_data.tgz

echo "Extracting local mirror..."
rm -rf mirror
mkdir mirror
tar xzf render_var_data.tgz -C mirror

echo "Done:"
du -sh render_var_data.tgz mirror
du -sh mirror/* 2>/dev/null | sort -rh | head
