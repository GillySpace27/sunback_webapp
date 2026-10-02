#!/usr/bin/env bash
# Seed the DEV volume (MH-6): the committed landing-asset mirror, plus, if FROM is given,
# the two manifests from a backup folder. Writes to myheliograph-api-dev only.
#
#   ./infra/scripts/seed_dev.sh                                         plan only
#   APP=myheliograph-api-dev FROM=<backup dir> GO=1 ./infra/scripts/seed_dev.sh   do it
#
# It refuses any other app (exit 64). It stages only the mirror folder and two named
# manifests, refuses if a feedback or stats file would be staged, and never removes
# anything from either volume: unpacking only adds or overwrites files under
# /var/data/default_cache on dev. Every GO=1 run is an outward write and needs Gilly's
# yes for that run. The flyctl flags (ssh sftp put, ssh console -C) were not run when this
# was written; the closing step reads the manifest back from dev and compares hashes, so
# a flag that did not behave shows up as MISMATCH.
set -euo pipefail
cd "$(dirname "$0")/../.."
FLY="${FLY:-fly}"
CURL="${CURL:-curl}"
APP="${APP:-myheliograph-api-dev}"
ORIGIN="${ORIGIN:-https://myheliograph-api-dev.fly.dev}"
MIRROR="${MIRROR:-infra/data_mirror/mirror/default_cache}"

if [ "$APP" != "myheliograph-api-dev" ]; then
  echo "REFUSING: seed_dev.sh writes only to myheliograph-api-dev, not '$APP'. Prod is never written by this script." >&2
  exit 64
fi
[ -d "$MIRROR" ] || { echo "seed_dev: $MIRROR is missing (the committed mirror)" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  else shasum -a 256 | cut -d' ' -f1; fi
}

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/seed-dev.XXXXXX")"
mkdir -p "$STAGE/default_cache"
cp -R "$MIRROR/." "$STAGE/default_cache/"
if [ -n "${FROM:-}" ]; then
  for m in default_mockups.json vibe_manifest.json; do
    src="$FROM/default_cache/$m"
    [ -f "$src" ] || { echo "seed_dev: $src is missing in FROM" >&2; exit 1; }
    cp "$src" "$STAGE/default_cache/$m"
  done
fi
if find "$STAGE" \( -iname 'feedback*' -o -iname 'approved_catalog*' -o -iname 'product_stats*' -o -iname 'stats_seed*' \) | grep -q .; then
  echo "REFUSING: a feedback or stats file is staged; seed_dev.sh never copies those." >&2
  exit 64
fi
[ -f "$STAGE/default_cache/default_mockups.json" ] || { echo "seed_dev: no default_mockups.json to seed" >&2; exit 1; }
tar czf "$STAGE/seed.tgz" -C "$STAGE" default_cache
files="$(find "$STAGE/default_cache" -type f | wc -l | tr -d ' ')"
echo "seed_dev: staged $files files for $APP from $MIRROR${FROM:+ and the manifests in $FROM}"
if [ "${GO:-0}" != "1" ]; then
  echo "seed_dev: plan only. GO=1 pushes the tarball over fly ssh and unpacks it into /var/data on $APP (the dev volume)."
  exit 0
fi

"$FLY" ssh sftp put "$STAGE/seed.tgz" /tmp/seed.tgz --app "$APP"
"$FLY" ssh console --app "$APP" -C "tar xzf /tmp/seed.tgz -C /var/data"

want="$(sha256_of "$STAGE/default_cache/default_mockups.json")"
got="$("$CURL" -fsS --max-time 120 "$ORIGIN/asset/default/default_mockups.json" | sha256_stdin || true)"
if [ "$got" = "$want" ]; then
  echo "seed_dev: verified: dev serves default_mockups.json byte for byte ($want)"
else
  echo "seed_dev: MISMATCH: dev serves $got, staged $want" >&2
  exit 1
fi
