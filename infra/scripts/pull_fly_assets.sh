#!/usr/bin/env bash
# Refresh the committed landing-asset mirror from the Fly origin.
#
# Replaces pull_render_data.sh, which SSH-tarred /var/data off the Render
# disk that the Fly migration decommissioned. No SSH or flyctl needed:
# api/main.py mounts DEFAULT_CACHE_DIR at /asset/default via StaticFiles,
# so every file build-public.sh ships is already public over HTTPS.
#
# Why this exists: infra/worker/public/ is served by Cloudflare Static
# Assets, which SHADOW the Fly origin. A mirror nobody refreshed silently
# masked a good warm for days (25 stale front-camera entries at the edge
# vs 37 with context cameras on Fly). Run this after any warm_default or
# vibe re-warm, then rebuild + deploy the Worker.
#
# Usage:  ./infra/scripts/pull_fly_assets.sh
#         ORIGIN=https://other.example ./infra/scripts/pull_fly_assets.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

ORIGIN="${ORIGIN:-https://myheliograph-api.fly.dev}"
DEST="infra/data_mirror/mirror/default_cache"
# Fly scales to zero; the first request pays a cold wake (~25 s observed).
CURL=(curl -fsS --max-time 120 --retry 2 --retry-delay 3)

mkdir -p "$DEST/mockups" "$DEST/vibe"

echo "Pulling manifests from $ORIGIN ..."
"${CURL[@]}" -o "$DEST/default_mockups.json" "$ORIGIN/asset/default/default_mockups.json"
"${CURL[@]}" -o "$DEST/vibe_manifest.json"   "$ORIGIN/asset/default/vibe_manifest.json"

# Landing showcase + social card. Best-effort: a missing one shouldn't
# abort the mockup refresh that is the point of this script.
for f in quality_strip.webp compare_raw.webp compare_rhef.webp og_card.jpg; do
  "${CURL[@]}" -o "$DEST/$f" "$ORIGIN/asset/default/$f" || echo "  WARN: $f unavailable, keeping existing"
done

# Mockup thumbs, driven by the manifest's own thumb_url values so new
# products onboard themselves without editing this script. Only .thumb.webp
# is mirrored; the full-res PNGs stay proxied to Fly (build-public.sh L50-56).
echo "Pulling mockup thumbs ..."
python3 - "$ORIGIN" "$DEST" <<'PY'
import json, subprocess, sys, pathlib
origin, dest = sys.argv[1], pathlib.Path(sys.argv[2])
man = json.loads((dest / "default_mockups.json").read_text())

PREFIX = "/asset/default/"

def iter_entries(man):
    # Nested {wl:{filter:{pid:entry}}} (2026-08-15 wavelength x filter grid),
    # with a fallback for the legacy flat {pid:entry} shape.
    for k, v in man.items():
        if not isinstance(v, dict):
            continue
        if v.get("thumb_url") or v.get("url"):      # flat: k is a product id
            yield v
        else:                                       # nested: k is a wavelength
            for filt, cells in v.items():
                if not isinstance(cells, dict):
                    continue
                for pid, entry in cells.items():
                    if isinstance(entry, dict):
                        yield entry

kept = set()
for entry in iter_entries(man):
    thumb = entry.get("thumb_url")
    if not thumb or not thumb.startswith(PREFIX):
        continue
    rel = thumb[len(PREFIX):]        # mockups/{wl}/{filter}/{pid}.thumb.webp
    out = dest / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["curl", "-fsS", "--max-time", "60", "-o", str(out),
                    origin + thumb], check=True)
    kept.add(str(out.resolve()))
print(f"  {len(kept)} thumbs")
# Drop thumbs no longer referenced by the manifest so the mirror can't
# accumulate orphans (product renamed, wavelength dropped, etc.). Recursive
# so it walks the nested {wl}/{filter}/ tree.
for stale in sorted((dest / "mockups").rglob("*.thumb.webp")):
    if str(stale.resolve()) not in kept:
        print(f"  removing orphan {stale.relative_to(dest)}")
        stale.unlink()
PY

# Vibe gallery thumbs, driven by the vibe manifest for the same reason.
echo "Pulling vibe thumbs ..."
python3 - "$ORIGIN" "$DEST" <<'PY'
import json, subprocess, sys, pathlib
origin, dest = sys.argv[1], pathlib.Path(sys.argv[2])
vibes = json.loads((dest / "vibe_manifest.json").read_text()).get("vibes", {})
for slug in sorted(vibes):
    (dest / "vibe" / slug).mkdir(parents=True, exist_ok=True)
    for name in ("raw_thumb.png", "rhef_thumb.png"):
        subprocess.run(["curl", "-fsS", "--max-time", "60",
                        "-o", str(dest / "vibe" / slug / name),
                        f"{origin}/asset/default/vibe/{slug}/{name}"],
                       check=False)
print(f"  {len(vibes)} slugs")
PY

echo
echo "Mirror refreshed: $DEST"
du -sh "$DEST"
python3 - "$DEST/default_mockups.json" <<'PY'
import json, sys
man = json.load(open(sys.argv[1]))
cells = sum(len(cells) for wl, filts in man.items() if isinstance(filts, dict)
            for f, cells in filts.items() if isinstance(cells, dict)) \
        or len(man)   # fall back to flat count
print("  manifest cells:", cells)
PY
echo
echo "Next: cd infra/worker && ./build-public.sh && npx wrangler deploy"
