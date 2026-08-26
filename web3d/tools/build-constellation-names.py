"""Build web3d/src/data/constellation-names.json: one label per constellation
already in constellations.json (the line data), positioned at the centroid of
its own vertices so it sits naturally among the figure it names.

Names come from d3-celestial's OWN boundaries file — same repo, same MIT
license as constellations.lines.json already vendored, so this adds no new
license surface:

  curl -sS -o /tmp/constellations.full.json \
    https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.json
  python3 tools/build-constellation-names.py /tmp/constellations.full.json

Zodiac membership is not looked up anywhere; it is the fixed, uncontroversial
IAU list of the 12 constellations the ecliptic passes through.
"""
import json, sys

ZODIAC = {"Ari", "Tau", "Gem", "Cnc", "Leo", "Vir", "Lib", "Sco", "Sgr", "Cap", "Aqr", "Psc"}

names_src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/constellations.full.json"
names = {}
for f in json.load(open(names_src)).get("features", []):
    cid = f.get("id")
    nm = f.get("properties", {}).get("name")
    if cid and nm:
        names[cid] = nm

lines = json.load(open("src/data/constellations.json"))

# Centroid of a constellation's own vertices, normalized back onto the unit
# sphere — not the true geometric center of its IAU boundary (we do not have
# that shape), but it lands inside the figure's own stick-line drawing, which
# is what the label needs to sit near.
sums = {}
for seg in lines["segments"]:
    cid = seg["c"]
    pts = seg["p"]
    sx = sy = sz = n = 0.0
    for i in range(0, len(pts), 3):
        sx += pts[i]; sy += pts[i + 1]; sz += pts[i + 2]; n += 1
    a = sums.setdefault(cid, [0.0, 0.0, 0.0, 0])
    a[0] += sx; a[1] += sy; a[2] += sz; a[3] += n

items = []
missing = []
for cid, (sx, sy, sz, n) in sums.items():
    if n == 0:
        continue
    x, y, z = sx / n, sy / n, sz / n
    mag = (x * x + y * y + z * z) ** 0.5 or 1.0
    name = names.get(cid)
    if not name:
        missing.append(cid)
        continue
    items.append({"c": cid, "name": name, "zodiac": cid in ZODIAC,
                  "p": [round(x / mag, 4), round(y / mag, 4), round(z / mag, 4)]})

if missing:
    print(f"WARNING: no name found for {missing}", file=sys.stderr)

items.sort(key=lambda it: it["c"])
json.dump({"n": len(items), "items": items}, open("src/data/constellation-names.json", "w"),
           separators=(",", ":"))
print(f"{len(items)} constellation names ({sum(1 for i in items if i['zodiac'])} zodiac) "
      f"-> src/data/constellation-names.json")
