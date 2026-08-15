#!/usr/bin/env bash
# Self-updating mockup grid (2026-08-15).
#
# The product picker shows a mockup per (wavelength x filter x product) cell:
# 9 wavelengths x {raw, rhef} x 36 products = 648 cells. This script warms the
# missing cells ON THE ORIGIN, one wavelength (~72 cells) at a time, until the
# grid is complete, and reads coverage BEFORE and AFTER so a deploy log shows
# what changed.
#
# The warm runs in a BACKGROUND thread on the origin (warm_grid?background=1)
# and this script POLLS coverage: short requests only, so a proxy / the
# scale-to-zero edge can't reset a long-held connection (the failure mode that
# broke the old synchronous sweep with curl "HTTP2 framing layer"). Frequent
# polling also keeps the machine awake, and per-cell persistence means an
# interruption just resumes. Curl is pinned to HTTP/1.1 for the same proxy
# reason.
#
#   ADMIN_KEY=... ./infra/scripts/sweep_mockups.sh                # fill gaps
#   ADMIN_KEY=... CHECK_ONLY=1 ./infra/scripts/sweep_mockups.sh   # report only
#   ORIGIN=https://other.example ADMIN_KEY=... ./sweep_mockups.sh
#
# ADMIN_KEY is the warm-admin key (FEEDBACK_ADMIN_KEY). CHECK_ONLY=1 exits
# non-zero if the grid is incomplete (pre-deploy gate). Tunables: MAX_POLLS
# (default 900), POLL_INTERVAL secs (default 20).
set -euo pipefail

ORIGIN="${ORIGIN:-https://myheliograph-api.fly.dev}"
: "${ADMIN_KEY:?set ADMIN_KEY (the warm-admin / FEEDBACK_ADMIN_KEY value)}"
MAX_POLLS="${MAX_POLLS:-900}"
POLL_INTERVAL="${POLL_INTERVAL:-20}"
CURL=(curl -fsS --http1.1 --retry 2 --retry-delay 3 -H "x-admin-key: $ADMIN_KEY")

cov() { "${CURL[@]}" --max-time 120 "$ORIGIN/api/admin/mockup_coverage"; }

# Parse coverage JSON into: complete present total missing warming
_parse() {
  python3 -c "import json,sys;d=json.load(sys.stdin);print(d['complete'],d['present'],d['total'],d['missing'],d.get('warming'))"
}

echo "== mockup coverage BEFORE ($ORIGIN) =="
before="$(cov)"
set -- $(printf '%s' "$before" | _parse); complete="$1"
printf '%s' "$before" | python3 -c "import json,sys;d=json.load(sys.stdin);print('  present %d/%d  missing %d  complete=%s'%(d['present'],d['total'],d['missing'],d['complete']))"

if [ "${CHECK_ONLY:-0}" = "1" ]; then
  [ "$complete" = "True" ] && { echo "grid complete."; exit 0; }
  echo "grid INCOMPLETE (CHECK_ONLY) — deploy will backfill."; exit 1
fi

polls=0
while : ; do
  cj="$(cov)" || { echo "  coverage fetch failed, retrying in 10s"; sleep 10; continue; }
  set -- $(printf '%s' "$cj" | _parse)
  complete="$1"; present="$2"; total="$3"; missing="$4"; warming="$5"
  echo "  present $present/$total  missing $missing  warming=$warming"
  [ "$complete" = "True" ] && { echo "grid complete."; break; }
  if [ "$warming" != "True" ]; then
    "${CURL[@]}" --max-time 60 -X POST "$ORIGIN/api/admin/warm_grid?sweep=1&background=1" \
      | python3 -c "import json,sys;d=json.load(sys.stdin);print('  started wl',d.get('wavelength'),'already_running=%s'%d.get('already_running'))" \
      || echo "  warm start failed, will retry next poll"
  fi
  polls=$((polls + 1))
  [ "$polls" -ge "$MAX_POLLS" ] && { echo "  reached MAX_POLLS ($MAX_POLLS) — stopping"; break; }
  sleep "$POLL_INTERVAL"
done

echo "== mockup coverage AFTER =="
cov | python3 -c "import json,sys;d=json.load(sys.stdin);print('  present %d/%d  missing %d  complete=%s'%(d['present'],d['total'],d['missing'],d['complete']))"
