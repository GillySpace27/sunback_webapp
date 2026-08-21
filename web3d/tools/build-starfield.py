"""Build web3d/public/stars.json from the Yale Bright Star Catalogue.

Run once; the output is committed so the runtime has no external dependency.

  curl -sS -o /tmp/bsc.tsv "https://vizier.cds.unistra.fr/viz-bin/asu-tsv?\
-source=V/50/catalog&-out=RAJ2000,DEJ2000,Vmag,B-V&-out.max=10000&Vmag=%3C6.5&-out.form=tsv"
  python3 tools/build-starfield.py /tmp/bsc.tsv

Stores unit vectors in the J2000 equatorial frame (not RA/Dec) so the client
does no trigonometry per star, plus V magnitude and B-V colour index. Rounded
to 4 decimals, which is ~20 arcsec — far finer than a star is ever drawn.
"""
import json, sys, math

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/bsc.tsv"
MAG_LIMIT = 6.5

out = []
for line in open(src, encoding="utf-8", errors="replace"):
    line = line.rstrip("\n")
    if not line or line.startswith("#") or line.startswith("-") or line.startswith("RAJ"):
        continue
    if line.startswith('"'):          # units row
        continue
    parts = line.split("\t")
    if len(parts) < 4:
        continue
    try:
        rh, rm, rs = [float(v) for v in parts[0].split()]
        dparts = parts[1].split()
        dsign = -1.0 if dparts[0].startswith("-") else 1.0
        dd, dm, ds = abs(float(dparts[0])), float(dparts[1]), float(dparts[2])
        mag = float(parts[2])
        bv = float(parts[3]) if parts[3].strip() else 0.0
    except ValueError:
        continue
    if mag > MAG_LIMIT:
        continue
    ra = math.radians((rh + rm / 60 + rs / 3600) * 15.0)
    dec = math.radians(dsign * (dd + dm / 60 + ds / 3600))
    cd = math.cos(dec)
    out.append([
        round(cd * math.cos(ra), 4),
        round(cd * math.sin(ra), 4),
        round(math.sin(dec), 4),
        round(mag, 2),
        round(bv, 2),
    ])

out.sort(key=lambda s: s[3])          # brightest first
path = "public/stars.json"
with open(path, "w") as f:
    json.dump({"n": len(out), "stars": out}, f, separators=(",", ":"))
print(f"{len(out)} stars -> {path}")
