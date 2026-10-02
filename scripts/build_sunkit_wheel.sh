#!/bin/bash
# Rebuild the vendored sunkit-image wheel from an explicit commit of the fork.
# Usage: scripts/build_sunkit_wheel.sh <40-hex sha> [out_dir]
# Writes exactly one file, <out_dir>/<wheel>, and prints "sha256 <hex>  <path>".
# Never edits requirements.txt, never commits, never pushes.
# Env overrides: FORK_URL (default the GillySpace27 fork), PYTHON (default python3).
set -euo pipefail
FORK_URL="${FORK_URL:-https://github.com/GillySpace27/sunkit-image.git}"
SHA="${1:-}"
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <40-hex sha> [out_dir]" >&2
  exit 2
fi
OUT="${2:-vendor/sunkit-image-${SHA:0:9}}"
PY="${PYTHON:-python3}"
TMP="$(mktemp -d)"

# 1. Refuse a SHA the fork does not have (one-commit fetch, nothing built yet).
git init -q "$TMP/probe"
if ! git -C "$TMP/probe" fetch -q --depth 1 "$FORK_URL" "$SHA" 2>/dev/null; then
  echo "refused: $FORK_URL has no commit $SHA" >&2
  exit 1
fi
# Commit time of the SHA makes the zip timestamps reproducible.
export SOURCE_DATE_EPOCH="$(git -C "$TMP/probe" log -1 --format=%ct "$SHA")"

# 2. Build with pinned build backends (read on 2026-10-01 as the latest releases).
cat > "$TMP/build-constraints.txt" <<'PINS'
setuptools==84.0.0
setuptools_scm==10.3.4
vcs-versioning==2.5.0
wheel==0.48.0
PINS
PIP_CONSTRAINT="$TMP/build-constraints.txt" "$PY" -m pip wheel -q --no-deps --no-cache-dir \
  -w "$TMP/raw" "git+$FORK_URL@$SHA"
RAW="$(ls "$TMP"/raw/*.whl)"

# 3. Strip non-.py files under sunkit_image/data/test/, rewrite RECORD, repack
#    deterministically (fixed timestamps, stored entries, original order, RECORD last).
mkdir -p "$OUT"
"$PY" - "$RAW" "$OUT" <<'PY'
import base64, hashlib, os, sys, time, zipfile
raw, out = sys.argv[1], sys.argv[2]
epoch = int(os.environ["SOURCE_DATE_EPOCH"])
stamp = time.gmtime(max(epoch, 315532800))[:6]
src = zipfile.ZipFile(raw)
keep = [i for i in src.infolist()
        if not (i.filename.startswith("sunkit_image/data/test/") and not i.filename.endswith(".py"))]
record = next(i.filename for i in keep if i.filename.endswith(".dist-info/RECORD"))
dst_path = os.path.join(out, os.path.basename(raw))
lines = []
with zipfile.ZipFile(dst_path, "w") as dst:
    for info in keep:
        if info.filename == record:
            continue
        data = src.read(info.filename)
        zi = zipfile.ZipInfo(info.filename, date_time=stamp)
        zi.external_attr = info.external_attr
        zi.compress_type = zipfile.ZIP_STORED
        dst.writestr(zi, data)
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        lines.append(f"{info.filename},sha256={digest},{len(data)}")
    lines.append(f"{record},,")
    zi = zipfile.ZipInfo(record, date_time=stamp)
    zi.external_attr = 0o644 << 16
    zi.compress_type = zipfile.ZIP_STORED
    dst.writestr(zi, "\n".join(lines) + "\n")
PY
WHL="$OUT/$(basename "$RAW")"
if command -v sha256sum >/dev/null; then HEX="$(sha256sum "$WHL" | cut -d' ' -f1)"; else HEX="$(shasum -a 256 "$WHL" | cut -d' ' -f1)"; fi
echo "sha256 $HEX  $WHL"
