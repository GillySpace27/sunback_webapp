#!/usr/bin/env python3
"""Code hash of the edge bundle (infra/worker/public/), MH-8.

    python3 infra/scripts/bundle_manifest.py infra/worker/public            one line: overall sha256
    python3 infra/scripts/bundle_manifest.py infra/worker/public --files    that line, then "<sha256>  <path>" per file
    python3 infra/scripts/bundle_manifest.py infra/worker/public --diff F   name files that differ from a saved --files output F;
                                                                            exit 1 when any differ

What is hashed is the code and fonts the Worker serves. What is left out is
everything that legitimately differs between the dev build and the prod build
of ONE commit (read from build-public.sh):
  asset/default/   warmed mockup thumbs and manifests (pull_fly_assets.sh and
                   the mockup warm only ever change this subtree)
  build.json       carries built_at, different on every build
  robots.txt, sitemap.xml   dev rewrites robots.txt and deletes sitemap.xml
  .DS_Store        never shipped on purpose
and the noindex meta that DEV_BUILD=1 injects into every .html file is
stripped before hashing.
"""
import argparse
import hashlib
import pathlib
import sys

NOINDEX_TAG = b'\n  <meta name="robots" content="noindex, nofollow">'
EXCLUDE_EXACT = frozenset({"build.json", "robots.txt", "sitemap.xml"})
EXCLUDE_PREFIX = ("asset/default/",)
EXCLUDE_NAMES = frozenset({".DS_Store"})


def _excluded(rel):
    return (rel in EXCLUDE_EXACT or rel.startswith(EXCLUDE_PREFIX)
            or rel.rsplit("/", 1)[-1] in EXCLUDE_NAMES)


def code_hash(public_dir):
    """Return (overall sha256 hex, {relative posix path: sha256 hex})."""
    root = pathlib.Path(public_dir)
    if not root.is_dir():
        raise FileNotFoundError(f"not a directory: {root}")
    files = {}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        if _excluded(rel):
            continue
        data = p.read_bytes()
        if rel.endswith(".html"):
            data = data.replace(NOINDEX_TAG, b"", 1)
        files[rel] = hashlib.sha256(data).hexdigest()
    listing = "".join(f"{files[r]}  {r}\n" for r in sorted(files))
    return hashlib.sha256(listing.encode("utf-8")).hexdigest(), files


def parse_listing(text):
    """Parse the per-file lines of a saved --files output."""
    out = {}
    for line in text.splitlines():
        digest, sep, path = line.partition("  ")
        if sep and len(digest) == 64 and all(c in "0123456789abcdef" for c in digest):
            out[path] = digest
    return out


def diff(saved, current):
    rows = []
    for path in sorted(set(saved) | set(current)):
        if path not in current:
            rows.append(f"missing: {path}")
        elif path not in saved:
            rows.append(f"added: {path}")
        elif saved[path] != current[path]:
            rows.append(f"changed: {path}")
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("public_dir")
    ap.add_argument("--files", action="store_true", help="also print one '<sha256>  <path>' line per file")
    ap.add_argument("--diff", metavar="FILE", help="compare with a saved --files output")
    args = ap.parse_args(argv)
    try:
        overall, files = code_hash(args.public_dir)
    except FileNotFoundError as ex:
        print(f"bundle_manifest: {ex}", file=sys.stderr)
        return 2
    if args.diff:
        rows = diff(parse_listing(pathlib.Path(args.diff).read_text()), files)
        if rows:
            print("\n".join(rows))
        return 1 if rows else 0
    print(overall)
    if args.files:
        for rel in sorted(files):
            print(f"{files[rel]}  {rel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
