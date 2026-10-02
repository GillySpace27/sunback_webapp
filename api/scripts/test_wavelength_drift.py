#!/usr/bin/env python3
"""Self-check: the wavelength lists the store and the film show are consistent
with the one in api/main.py (MH-9).

Run: python3 api/scripts/test_wavelength_drift.py

AIA_WAVELENGTHS (api/main.py, once it lands; until then _DIM_CHANNELS, the same
eight values) is the list of store wavelengths. The data-wl
values of the .wl-card tiles in api/index.html and the angstrom values of
CHANNELS in web3d/src/data/wavelengths.ts must be subsets of it, the
render-service channel list _DIM_CHANNELS must equal it in order (the render
service takes a channel INDEX), and every store wavelength must have a warmed
mockup grid column (_GRID_WAVELENGTHS). Nothing is imported: main.py is read with
ast, the others as text. Do NOT use HELIO_SOURCE_IDS in solar-archive.js: it
includes 1700, which the store dropped on 2026-08-18. DRIFT_TEST_ROOT points the
test at a scratch tree (used to prove it can fail). MH-19 extends this file to
cover WAVELENGTH_GLOSSES.
"""
import ast
import os
import pathlib
import re
import sys

ROOT = pathlib.Path(os.environ.get("DRIFT_TEST_ROOT") or pathlib.Path(__file__).resolve().parents[2])


def main_value(name):
    tree = ast.parse((ROOT / "api" / "main.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return node.value
    raise AssertionError(f"api/main.py has no module-level {name}")


def has_aia_constant():
    tree = ast.parse((ROOT / "api" / "main.py").read_text(encoding="utf-8"))
    return any(isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "AIA_WAVELENGTHS" for t in n.targets)
               for n in tree.body)


def aia():
    """The store wavelength list. AIA_WAVELENGTHS is not in api/main.py yet (the
    edit is FREEZE-held), so until then the literal _DIM_CHANNELS list, which
    holds the same eight values, is the source."""
    if has_aia_constant():
        return tuple(ast.literal_eval(main_value("AIA_WAVELENGTHS")))
    return tuple(ast.literal_eval(main_value("_DIM_CHANNELS")))


def tiles():
    html = (ROOT / "api" / "index.html").read_text(encoding="utf-8")
    return [int(x) for x in re.findall(r'class="wl-card[^"]*"\s+data-wl="(\d+)"', html)]


def channels():
    ts = (ROOT / "web3d" / "src" / "data" / "wavelengths.ts").read_text(encoding="utf-8")
    start = ts.index("export const CHANNELS")
    end = ts.index("\n];", start)
    return [int(x) for x in re.findall(r"angstrom:\s*(\d+)", ts[start:end])]


def test_aia_wavelengths_is_a_tuple_of_ints():
    w = aia()
    assert len(w) >= 8 and all(isinstance(x, int) for x in w) and len(set(w)) == len(w), w


def test_store_tiles_are_a_subset():
    t, w = tiles(), set(aia())
    assert len(t) >= 8, f"only {len(t)} .wl-card tiles found in api/index.html"
    assert set(t) <= w, f"api/index.html tiles not in AIA_WAVELENGTHS: {sorted(set(t) - w)}"


def test_film_channels_are_a_subset_and_in_render_order():
    c, w = channels(), aia()
    assert len(c) >= 8, f"only {len(c)} CHANNELS found in wavelengths.ts"
    assert set(c) <= set(w), f"wavelengths.ts CHANNELS not in AIA_WAVELENGTHS: {sorted(set(c) - set(w))}"
    assert c == list(w), f"wavelengths.ts order {c} != AIA_WAVELENGTHS order {list(w)} (the render service takes an index)"


def test_dim_channels_is_built_from_the_one_list():
    if not has_aia_constant():
        print("     (SKIP: AIA_WAVELENGTHS is not in api/main.py yet; FREEZE row)")
        return
    node = main_value("_DIM_CHANNELS")
    ok = (isinstance(node, ast.Call) and getattr(node.func, "id", "") == "list"
          and len(node.args) == 1 and getattr(node.args[0], "id", "") == "AIA_WAVELENGTHS")
    assert ok, "api/main.py _DIM_CHANNELS must be list(AIA_WAVELENGTHS)"


def test_every_store_wavelength_has_a_grid_column():
    grid = set(ast.literal_eval(main_value("_GRID_WAVELENGTHS")))
    assert set(aia()) <= grid, f"no mockup grid column for: {sorted(set(aia()) - grid)}"


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
        print(f"test_wavelength_drift: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_wavelength_drift: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
