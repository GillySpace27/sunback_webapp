#!/usr/bin/env python3
"""Snapshot of the FastAPI route table: every (path, methods) pair, plus the
Starlette mounts in registration order (mount order matters; main.py
registers /asset/default and /asset/preview before the catch-all /asset).

Run:
    python3 api/scripts/snapshot_routes.py            compare; exit 1 with a diff on mismatch
    python3 api/scripts/snapshot_routes.py --update   rewrite api/scripts/routes.snapshot.json

Refresh with --update only in the commit that adds or removes a route. A
move-only refactor of api/main.py must leave the snapshot byte-identical.
"""
import contextlib
import difflib
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = Path(__file__).resolve().parent / "routes.snapshot.json"


def current() -> dict:
    # Importing api.main starts the render-cache janitor on OUTPUT_DIR and
    # creates default_cache/ under FEEDBACK_DATA_DIR. Point both at a scratch
    # dir unconditionally (an inherited value could be real data).
    scratch = Path(tempfile.mkdtemp(prefix="snapshot_routes_"))
    os.environ["SOLAR_ARCHIVE_OUTPUT_DIR"] = str(scratch / "output")
    os.environ["FEEDBACK_DATA_DIR"] = str(scratch / "data")
    sys.path.insert(0, str(ROOT))
    from starlette.routing import Mount

    with contextlib.redirect_stdout(sys.stderr):  # keep [startup] prints out of the diff
        import api.main as app_main

    def flatten(rs):
        # FastAPI 0.14x keeps include_router() lazy: app.routes holds
        # _IncludedRouter entries whose effective_candidates() are the real
        # routes. Older versions already hold the flat list.
        for r in rs:
            if hasattr(r, "effective_candidates"):
                yield from flatten(r.effective_candidates())
            else:
                yield r

    routes, mounts = [], []
    for r in flatten(app_main.app.routes):
        if isinstance(r, Mount):
            mounts.append(r.path)
        else:
            routes.append([r.path, sorted(getattr(r, "methods", None) or ["WEBSOCKET"])])
    routes.sort()
    return {"routes": routes, "mounts": mounts}


def render(snap: dict) -> str:
    """One route per line so a diff names the route that changed."""
    rows = ",\n".join("  " + json.dumps(r) for r in snap["routes"])
    return '{"routes": [\n' + rows + '\n ],\n "mounts": ' + json.dumps(snap["mounts"]) + "}\n"


def main() -> int:
    text = render(current())
    if sys.argv[1:] == ["--update"]:
        SNAPSHOT.write_text(text)
        print(f"wrote {SNAPSHOT.relative_to(ROOT)}")
        return 0
    if sys.argv[1:]:
        print("usage: snapshot_routes.py [--update]", file=sys.stderr)
        return 64
    if not SNAPSHOT.exists():
        print(f"{SNAPSHOT.relative_to(ROOT)} is missing; create it with --update")
        return 1
    want = SNAPSHOT.read_text()
    if want == text:
        print("routes match snapshot")
        return 0
    sys.stdout.writelines(difflib.unified_diff(
        want.splitlines(keepends=True), text.splitlines(keepends=True),
        "routes.snapshot.json", "current api.main"))
    return 1


if __name__ == "__main__":
    sys.exit(main())
