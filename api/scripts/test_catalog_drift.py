#!/usr/bin/env python3
"""Self-check: catalog ids agree across api/main.py and api/products.js (MH-9).

The retired-manifest-keys comparison of the task file (test_retired_manifest_keys_agree)
is NOT here: it needs _RETIRED_MANIFEST_KEYS in api/main.py and api/solar-archive.js,
both FREEZE files. Add it with those edits.

Run: python3 api/scripts/test_catalog_drift.py

api/main.py _DEFAULT_MOCKUP_PRODUCTS is the server-side mirror of the store
catalog (api/products.js PRODUCTS): id, blueprintId, printProviderId and
variantId must match, or a warmed mockup shows a different product than the one
bought. api/main.py is read with ast (never imported); products.js is evaluated
with node through a temporary .mjs copy, with a regex fallback when node is
absent. DRIFT_TEST_ROOT points the test at a scratch tree (used to prove it can
fail).
"""
import ast
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(os.environ.get("DRIFT_TEST_ROOT") or pathlib.Path(__file__).resolve().parents[2])

# Known drift that MH-9 reports and does not fix. Every entry must still drift
# (test_known_drift_is_still_drift), so the list cannot go stale.
KNOWN_DRIFT = {
    "backpack": "api/products.js L159 has it commented out; api/main.py still lists and warms it. Gilly's call.",
}


def main_assign(name):
    tree = ast.parse((ROOT / "api" / "main.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return node.value
    raise AssertionError(f"api/main.py has no module-level {name}")


def server_products():
    return ast.literal_eval(main_assign("_DEFAULT_MOCKUP_PRODUCTS"))


def products_via_node():
    node = shutil.which("node")
    if not node:
        return None
    d = tempfile.mkdtemp(prefix="products-")
    shutil.copyfile(ROOT / "api" / "products.js", pathlib.Path(d) / "products.mjs")
    code = ("import(process.argv[1]).then(m => console.log(JSON.stringify(m.PRODUCTS.map(p => "
            "({id: p.id, b: p.blueprintId, p: p.printProviderId, v: p.variantId, hidden: !!p._hiddenFromGrid})))))")
    r = subprocess.run([node, "-e", code, (pathlib.Path(d) / "products.mjs").as_uri()],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise AssertionError(f"node could not evaluate api/products.js: {r.stderr[-300:]}")
    return {x["id"]: x for x in json.loads(r.stdout)}


def products_via_regex():
    text = (ROOT / "api" / "products.js").read_text(encoding="utf-8")
    out = {}
    for m in re.finditer(r'(?m)^\s*\{ id: "([a-z0-9_]+)".*?blueprintId: (\d+),\s*printProviderId: (\d+),\s*variantId: (\d+)(.*)$', text):
        out[m.group(1)] = {"id": m.group(1), "b": int(m.group(2)), "p": int(m.group(3)),
                           "v": int(m.group(4)), "hidden": "_hiddenFromGrid: true" in m.group(5)}
    return out


def products():
    return products_via_node() or products_via_regex()


def test_catalog_ids_agree():
    js = products()
    assert len(js) >= 30, f"only {len(js)} products parsed from api/products.js"
    problems = []
    for m in server_products():
        pid = m["id"]
        if pid in KNOWN_DRIFT:
            continue
        j = js.get(pid)
        if j is None:
            problems.append(f"{pid}: in api/main.py _DEFAULT_MOCKUP_PRODUCTS but not in api/products.js")
            continue
        for key, jk in (("blueprintId", "b"), ("printProviderId", "p"), ("variantId", "v")):
            if m[key] != j[jk]:
                problems.append(f"{pid}: main.py {key} {m[key]}, products.js {j[jk]}")
    server_ids = {m["id"] for m in server_products()}
    for pid, j in js.items():
        if not j["hidden"] and pid not in server_ids:
            problems.append(f"{pid}: in api/products.js (visible) but not in api/main.py _DEFAULT_MOCKUP_PRODUCTS")
    assert not problems, "; ".join(problems)


def test_known_drift_is_still_drift():
    js = products()
    server_ids = {m["id"] for m in server_products()}
    for pid, why in KNOWN_DRIFT.items():
        assert pid in server_ids, f"{pid} left api/main.py: remove it from KNOWN_DRIFT ({why})"
        assert pid not in js, f"{pid} is back in api/products.js: remove it from KNOWN_DRIFT ({why})"


def test_regex_fallback_matches_node():
    via_node = products_via_node()
    if via_node is None:
        print("     (node absent: nothing to compare)")
        return
    via_re = products_via_regex()
    assert set(via_re) == set(via_node), sorted(set(via_re) ^ set(via_node))
    for pid, n in via_node.items():
        r = via_re[pid]
        assert (r["b"], r["p"], r["v"]) == (n["b"], n["p"], n["v"]), pid


def run():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except Exception as ex:  # noqa: BLE001 - report every failure, then exit 1
            failed += 1
            print("FAIL", name, "-", type(ex).__name__, ex)
    if failed:
        print(f"test_catalog_drift: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_catalog_drift: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
