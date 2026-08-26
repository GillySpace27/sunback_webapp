"""Build the Urania's Mirror art layer: web3d/public/art/*.jpg + the manifest
web3d/src/data/constellation-art.json.

Cards are used WHOLE, exactly as scanned (Gilly, 2026-08-24: "no reason why we
need individual plates for each constellation"). Each 1824 card depicts a
REGION of sky — often several constellations on one plate — so it is placed at
the centroid of the constellations it names and sized to span them.

Source: Wikimedia Commons, Category:Urania's Mirror. Sidney Hall, 1824.
Verified public domain via the Commons API (Copyrighted: False,
LicenseShortName: Public domain) — no attribution requirement and no
share-alike, which is why this set and not Stellarium's Free-Art-Licensed one.

  python3 tools/build-constellation-art.py            # manifest + download
  python3 tools/build-constellation-art.py --dry-run  # manifest only
"""
import json, math, os, re, sys, time, unicodedata, urllib.parse, urllib.request


def fold(t: str) -> str:
    """Lowercase and strip diacritics/ligatures for name matching.

    The catalogue spells them "Boötes" and the plates spell them "Bootes";
    the cards also carry "Sextans Uraniæ". Comparing raw strings silently
    dropped those constellations from the art layer."""
    t = t.replace("æ", "ae").replace("Œ", "oe").replace("œ", "oe")
    t = unicodedata.normalize("NFKD", t)
    return "".join(c for c in t if not unicodedata.combining(c)).lower().strip(" .")

WIDTH = 512           # detailed engravings; below this the figures go mushy
OUT_DIR = "public/art"
UA = "myheliograph-art-builder/1.0 (https://myheliograph.com; gillygumption@gmail.com)"
API = "https://commons.wikimedia.org/w/api.php"

# Historical plate names -> modern IAU ids. The cards predate the 1922 IAU list,
# so several figures on them (Quadrans Muralis, Antinous, Musca Borealis, Custos
# Messium, Felis, Noctua, Argo Navis...) are constellations that no longer
# exist. Those are simply not looked up: they still appear in the ARTWORK, they
# just do not contribute a placement anchor.
EXTRA = {
    "scorpio": "Sco",
    "serpentarius": "Oph",       # Ophiuchus' older name
    "piscis australis": "PsA",
    "piscis notius": "PsA",
    "triangula": "Tri",
    "camelopardalis": "Cam",
    "cameleopardalis": "Cam",
    # The plate is titled "Leo Major and Leo Minor"; the IAU name is just
    # "Leo". Without this the canonical plate anchored only Leo Minor, so a
    # 256px thumbnail upload survived the dedupe as the art for Leo itself.
    "leo major": "Leo",
    "leo minor": "LMi",
    "ursa major": "UMa",
    "ursa minor": "UMi",
    "canis major": "CMa",
    "canis minor": "CMi",
    "coma berenices": "Com",
    "canes venatici": "CVn",
    "corona borealis": "CrB",
    "corona australis": "CrA",
    "piscis austrinus": "PsA",
}


def api(params):
    params = {**params, "format": "json"}
    req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params), headers={"User-Agent": UA})
    return json.load(urllib.request.urlopen(req))


def card_titles():
    """Every Commons file in the category, deduped to one file per plate."""
    titles, cont = [], None
    while True:
        p = {"action": "query", "list": "categorymembers",
             "cmtitle": "Category:Urania's Mirror", "cmlimit": "200"}
        if cont:
            p["cmcontinue"] = cont
        d = api(p)
        titles += [m["title"] for m in d.get("query", {}).get("categorymembers", [])]
        cont = d.get("continue", {}).get("cmcontinue")
        if not cont:
            break

    # Prefer the properly-attributed "Sidney Hall - Urania's Mirror - <plate>"
    # set, and among duplicates of one plate prefer .jpg over .tif/.png and the
    # cleaned scan over the "- original" raw one.
    best = {}
    for t in titles:
        m = re.match(r"File:Sidney Hall - Urania's Mirror - (.+?)\.(\w+)$", t)
        if not m:
            continue
        plate, ext = m.group(1).strip(), m.group(2).lower()
        # Strip scan/version qualifiers that are ABOUT the file, not the plate:
        # "(whole card)", "- original", "(image right side up)", "(best
        # currently available version - 2014)". Left in, they became part of the
        # plate name and Cassiopeia and Orion — two of the most recognisable
        # figures in the set — fell out with "no constellation to anchor on".
        plate = re.sub(r"\s*\([^)]*\)", "", plate)
        plate = re.sub(r"\s*-\s*[Oo]riginal\s*$", "", plate)
        plate = plate.strip(" -")
        if not plate:
            continue
        score = (3 if ext in ("jpg", "jpeg") else 1) - (2 if "original" in t.lower() else 0) \
                - (1 if "whole card" in t.lower() else 0)
        if plate not in best or score > best[plate][0]:
            best[plate] = (score, t)

    # A second naming convention in the same category: "<Name>urania.jpg"
    # (Leourania, Bootesurania, ...) and a handful of descriptive titles. These
    # are the SAME 1824 plates, uploaded separately, and skipping them lost 30+
    # constellations including Leo, Bootes, Orion and Eridanus. Only added when
    # the canonical set has no plate for that name already.
    ALT_PAT = re.compile(r"^File:([A-Za-z]+)urania\.jpg$", re.I)
    DESCRIPTIVE = {
        "File:Camelopardalis, Tarandus and Custos Messium.jpg": "Camelopardalis, Tarandus and Custos Messium",
        "File:Draco and Ursa Minor.jpg": "Draco and Ursa Minor",
        "File:Lacerta, Cygnus, Lyra, Vulpecula and Anser.jpg": "Lacerta, Cygnus, Lyra, Vulpecula and Anser",
        "File:Corvus Crater (Sidney Hall).png": "Corvus and Crater",
        "File:Sculptor-Sydney-Hall.jpg": "Sculptor",
        "File:Canis Major etc..jpg": "Canis Major",
    }
    known = {k.lower() for k in best}
    for t in titles:
        m = ALT_PAT.match(t)
        name = m.group(1) if m else None
        if not name:
            name = DESCRIPTIVE.get(t)
        if not name:
            continue
        if name.lower() in known:
            continue
        best[name] = (0, t)
        known.add(name.lower())
    return {plate: t for plate, (_, t) in best.items()}


def main():
    dry = "--dry-run" in sys.argv
    names = json.load(open("src/data/constellation-names.json"))["items"]
    by_name = {fold(it["name"]): it for it in names}
    by_id = {it["c"]: it for it in names}

    plates = card_titles()
    print(f"{len(plates)} distinct plates in the category")

    manifest, skipped = [], []
    for plate, title in sorted(plates.items()):
        # "Bootes, Canes Venatici, Coma Berenices, and Quadrans Muralis"
        parts = [p.strip() for p in re.split(r",| and | & ", plate) if p.strip()]
        ids = []
        for part in parts:
            key = fold(part)
            hit = by_name.get(key) or by_id.get(EXTRA.get(key, ""))
            if not hit and EXTRA.get(key):
                hit = by_id.get(EXTRA[key])
            if hit and hit["c"] not in ids:
                ids.append(hit["c"])
        if not ids:
            skipped.append(plate)
            continue

        # Mean direction of the constellations this plate depicts, and the
        # angular radius needed to cover them all.
        vs = [by_id[c]["p"] for c in ids]
        cx = sum(v[0] for v in vs) / len(vs)
        cy = sum(v[1] for v in vs) / len(vs)
        cz = sum(v[2] for v in vs) / len(vs)
        mag = math.sqrt(cx * cx + cy * cy + cz * cz) or 1.0
        c = [cx / mag, cy / mag, cz / mag]
        spread = 0.0
        for v in vs:
            dot = max(-1.0, min(1.0, v[0] * c[0] + v[1] * c[1] + v[2] * c[2]))
            spread = max(spread, math.degrees(math.acos(dot)))
        # A plate always covers more sky than the centroids it anchors on (the
        # figure runs past them, and the card has a border). 22 degrees is the
        # floor for a single-constellation plate.
        radius = max(22.0, spread + 14.0)

        slug = re.sub(r"[^a-z0-9]+", "-", plate.lower()).strip("-")[:48]
        manifest.append({"file": f"{slug}.jpg", "plate": plate, "c": ids,
                         "p": [round(v, 4) for v in c], "r": round(radius, 1),
                         "title": title})

    # Drop a plate whose constellations are ALL already covered by an earlier,
    # better one. The alternate "<Name>urania.jpg" uploads are ~365px
    # thumbnails of plates the canonical set already has at full size, and the
    # name-based dedupe above could not see that ("Leo" vs "Leo Major and Leo
    # Minor" are different strings for overlapping sky). Canonical plates are
    # preferred by sorting them first.
    manifest.sort(key=lambda m: (0 if m["title"].startswith("File:Sidney Hall") else 1,
                                 -len(m["c"])))
    kept, covered = [], set()
    for m in manifest:
        if set(m["c"]) <= covered:
            continue
        kept.append(m)
        covered |= set(m["c"])
    dropped = len(manifest) - len(kept)
    if dropped:
        print(f"dropped {dropped} redundant plate(s) already covered at higher resolution")
    manifest = kept

    manifest.sort(key=lambda m: m["file"])
    print(f"{len(manifest)} plates placed; {len(skipped)} with no modern constellation to anchor on")
    for s in skipped:
        print(f"   skipped: {s}")

    os.makedirs(OUT_DIR, exist_ok=True)
    out = [{k: m[k] for k in ("file", "plate", "c", "p", "r")} for m in manifest]
    json.dump({"n": len(out), "items": out},
              open("src/data/constellation-art.json", "w"), separators=(",", ":"))
    print(f"-> src/data/constellation-art.json ({len(out)} plates)")
    covered = {c for m in out for c in m["c"]}
    print(f"constellations with art: {len(covered)} of {len(names)}")
    missing = sorted(it["name"] for it in names if it["c"] not in covered)
    print(f"without art ({len(missing)}): {', '.join(missing)}")

    if dry:
        return
    for i, m in enumerate(manifest, 1):
        dest = os.path.join(OUT_DIR, m["file"])
        if os.path.exists(dest):
            continue
        url = ("https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/"
               + urllib.parse.quote(m["title"][5:]) + f"&width={WIDTH}")
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
            f.write(r.read())
        print(f"  [{i}/{len(manifest)}] {m['file']} ({os.path.getsize(dest)//1024} KB)")
        time.sleep(0.25)  # be polite to Commons
    total = sum(os.path.getsize(os.path.join(OUT_DIR, f)) for f in os.listdir(OUT_DIR))
    print(f"{OUT_DIR}: {total//1024} KB total")


main()
