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
  cp "$SRC/quality_strip.webp" "$DEST/" 2>/dev/null || true  # landing showcase (slider fallback)
  cp "$SRC/compare_raw.webp"  "$DEST/" 2>/dev/null || true   # before/after slider pair
  cp "$SRC/compare_rhef.webp" "$DEST/" 2>/dev/null || true
  cp "$SRC/og_card.jpg" "$DEST/" 2>/dev/null || true         # social share card
  # Mockup thumbs, recursive: the grid cache is nested
  # mockups/{wl}/{filter}/{pid}.thumb.webp (wavelength x filter grid,
  # 2026-08-15). Copy only the webp thumbs, preserving the subdir tree; the
  # full-res PNGs stay proxied to Fly. rsync preserves dirs; the flat cp is a
  # fallback for the legacy layout / rsync-less environments.
  rsync -am --include='*/' --include='*.thumb.webp' --exclude='*' \
    "$SRC/mockups/" "$DEST/mockups/" 2>/dev/null \
    || cp "$SRC"/mockups/*.thumb.webp "$DEST/mockups/" 2>/dev/null || true
  # vibe thumbnails (raw_thumb/rhef_thumb per slug) — small, makes the
  # gallery instant too. Full-res *_full.png deliberately excluded.
  for d in "$SRC"/vibe/*/; do
    slug=$(basename "$d"); mkdir -p "$DEST/vibe/$slug"
    cp "$d"raw_thumb.png "$d"rhef_thumb.png "$DEST/vibe/$slug/" 2>/dev/null || true
  done
  echo "static landing assets: $(find "$DEST" -type f | wc -l | tr -d ' ') files, $(du -sh "$DEST" | cut -f1)"

  # ── Staleness guard ────────────────────────────────────────────
  # Static Assets SHADOW the Fly origin: whatever lands in public/ wins,
  # and Cloudflare then holds it for 30 days immutable. A mirror nobody
  # refreshed silently masked a good warm for days (25 stale front-camera
  # entries at the edge while Fly served 37 with context cameras, and 12
  # products had no card photo at all). Never again silently: compare what
  # we just copied against the live origin and refuse to ship a mirror that
  # would mask it. Soft-fail when Fly is unreachable so offline builds work;
  # ALLOW_STALE_MIRROR=1 to ship anyway.
  ORIGIN="${ORIGIN:-https://myheliograph-api.fly.dev}"
  FLY_MANIFEST=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$FLY_MANIFEST'" EXIT
  if curl -fsS --max-time 120 -o "$FLY_MANIFEST" "$ORIGIN/asset/default/default_mockups.json" 2>/dev/null; then
    # Heredoc owns stdin, so the manifest travels as a file path, not a pipe.
    python3 - "$DEST" "${ALLOW_STALE_MIRROR:-0}" "$FLY_MANIFEST" <<'PY'
import json, sys, pathlib
dest, allow = pathlib.Path(sys.argv[1]), sys.argv[2] == "1"
fly = json.loads(pathlib.Path(sys.argv[3]).read_text())
PREFIX = "/asset/default/"

def iter_entries(man):
    # Nested {wl:{filter:{pid:entry}}} (wavelength x filter grid) + legacy flat.
    for k, v in man.items():
        if not isinstance(v, dict):
            continue
        if v.get("thumb_url") or v.get("url"):
            yield k, v
        else:
            for filt, cells in v.items():
                if not isinstance(cells, dict):
                    continue
                for pid, entry in cells.items():
                    if isinstance(entry, dict):
                        yield f"{k}/{filt}/{pid}", entry

problems = []
n = 0
for label, entry in iter_entries(fly):
    thumb = entry.get("thumb_url")
    if not thumb or not thumb.startswith(PREFIX):
        continue
    n += 1
    p = dest / thumb[len(PREFIX):]     # preserves mockups/{wl}/{filter}/ subdirs
    if not p.exists():
        problems.append(f"{label}: missing from mirror (origin has it)")
    elif p.stat().st_size != entry.get("thumb_size_bytes"):
        problems.append(
            f"{label}: {p.stat().st_size} B in mirror vs {entry.get('thumb_size_bytes')} B on origin")
if problems:
    print("\nSTALE MIRROR — public/ would shadow fresher assets on Fly:")
    for p in problems[:15]:
        print("  " + p)
    if len(problems) > 15:
        print(f"  ... and {len(problems) - 15} more")
    print("\nFix: ./infra/scripts/pull_fly_assets.sh   (or ALLOW_STALE_MIRROR=1 to ship anyway)")
    sys.exit(0 if allow else 1)
print(f"staleness guard: OK, {n} entries match the origin")
PY
  else
    echo "WARN: could not reach $ORIGIN — skipping staleness check"
  fi
else
  echo "WARN: no default_cache mirror — landing manifests will fall through to Fly (run pull_fly_assets.sh)"
fi

echo "public/ built:"
du -sh "$OUT"
ls "$OUT"
