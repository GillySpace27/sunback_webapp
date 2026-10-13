#!/usr/bin/env bash
# Refresh infra/worker/vendor/ from web3d/node_modules, on purpose.
#
# The store has no build step. Its GSAP, Lenis and two variable fonts used to be
# copied out of web3d/node_modules by build-public.sh on every build, with a WARN
# fallback, so a store-only deploy from a checkout without `npm ci` silently shipped
# a store without motion or fonts. They are now committed under infra/worker/vendor/
# and build-public.sh copies from there (list: vendor/SOURCES.txt).
#
#   ./infra/scripts/refresh_vendor.sh             report what would change, write nothing
#   REFRESH=1 ./infra/scripts/refresh_vendor.sh   write the files, VERSIONS.txt, SHA256SUMS
#
# Run it after changing gsap, lenis or the @fontsource-variable versions in
# web3d/package.json, in a commit of its own (DEPLOY.md, "Pinned build inputs").
# The files are regenerated from the versions locked in web3d/package-lock.json,
# so overwriting them is a rebuild of generated content; git keeps the old bytes.
# Needs web3d/node_modules (cd web3d && npm ci).
set -euo pipefail
cd "$(dirname "$0")/../.."
V="infra/worker/vendor"
NM="web3d/node_modules"
LOCK="web3d/package-lock.json"
[ -f "$V/SOURCES.txt" ] || { echo "refresh_vendor: $V/SOURCES.txt is missing" >&2; exit 1; }
[ -d "$NM" ] || { echo "refresh_vendor: $NM is missing (cd web3d && npm ci)" >&2; exit 1; }

listing() { grep -v '^[[:space:]]*#' "$V/SOURCES.txt" | sed '/^[[:space:]]*$/d'; }

differ=0
while read -r rel src; do
  [ -f "$NM/$src" ] || { echo "refresh_vendor: $NM/$src is missing" >&2; exit 1; }
  if [ ! -f "$V/$rel" ]; then
    echo "add:    $rel"; differ=$((differ + 1))
  elif ! cmp -s "$V/$rel" "$NM/$src"; then
    echo "change: $rel"; differ=$((differ + 1))
  fi
done < <(listing)

if [ "${REFRESH:-0}" != "1" ]; then
  echo "refresh_vendor: $differ file(s) differ from $NM. Nothing written (REFRESH=1 writes them)."
  exit 0
fi

while read -r rel src; do
  mkdir -p "$(dirname "$V/$rel")"
  cp "$NM/$src" "$V/$rel"
done < <(listing)

python3 - "$V" "$LOCK" <<'PY'
import datetime
import hashlib
import json
import pathlib
import sys

v = pathlib.Path(sys.argv[1])
packages = json.load(open(sys.argv[2], encoding="utf-8"))["packages"]
names = ["gsap", "lenis", "@fontsource-variable/inter", "@fontsource-variable/fraunces"]
lines = ["# Versions of the vendored store assets, read from web3d/package-lock.json by refresh_vendor.sh."]
for n in names:
    lines.append("%s %s" % (n, packages["node_modules/" + n]["version"]))
lines.append("refreshed %s" % datetime.date.today().isoformat())
(v / "VERSIONS.txt").write_text("\n".join(lines) + "\n")
rels = [ln.split()[0] for ln in (v / "SOURCES.txt").read_text().splitlines()
        if ln.strip() and not ln.lstrip().startswith("#")]
sums = ["%s  %s" % (hashlib.sha256((v / r).read_bytes()).hexdigest(), r) for r in sorted(rels)]
(v / "SHA256SUMS").write_text("\n".join(sums) + "\n")
PY
echo "refresh_vendor: wrote $differ changed file(s), VERSIONS.txt and SHA256SUMS in $V"
