"""Build web3d/public/constellations.json from d3-celestial's line data.

  curl -sS -o /tmp/constellations.lines.json \
    https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json
  python3 tools/build-constellations.py /tmp/constellations.lines.json

Source gives RA/Dec degrees per vertex, so no cross-match against the star
catalogue is needed. Stored as J2000 unit vectors in the same frame as
stars.json, so the renderer applies one rotation to both and the figures stay
registered to the stars they connect.
"""
import json, sys, math

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/constellations.lines.json"
d = json.load(open(src))

out = []
for f in d.get("features", []):
    cid = f.get("id") or ""
    geom = f.get("geometry", {})
    lines = geom.get("coordinates", [])
    if geom.get("type") == "LineString":
        lines = [lines]
    for seg in lines:
        pts = []
        for ra, dec in seg:
            a, e = math.radians(float(ra)), math.radians(float(dec))
            ce = math.cos(e)
            pts.extend([round(ce * math.cos(a), 4), round(ce * math.sin(a), 4), round(math.sin(e), 4)])
        if len(pts) >= 6:
            out.append({"c": cid, "p": pts})

json.dump({"n": len(out), "segments": out}, open("public/constellations.json", "w"), separators=(",", ":"))
print(f"{len(out)} segments from {len({s['c'] for s in out})} constellations -> public/constellations.json")
