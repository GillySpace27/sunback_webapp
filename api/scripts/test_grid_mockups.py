"""Pure-logic checks for the wavelength x filter x product mockup grid.

No network, no Printify, no image renders — exercises the cache-key nesting,
crop-to-aspect geometry, coverage/missing-cell accounting, and manifest
round-trip. Run: python -m pytest api/scripts/test_grid_mockups.py
or plain: python api/scripts/test_grid_mockups.py
"""
import io
import os
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from PIL import Image
from api import main


def _png_bytes(w, h, color=(200, 40, 40)):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def _noise_png_bytes(w=256, h=256):
    """Incompressible noise so the encoded PNG clears the >1000-byte
    'not truncated' guard the cache-presence checks use."""
    buf = io.BytesIO()
    Image.frombytes("RGB", (w, h), os.urandom(w * h * 3)).save(buf, "PNG")
    return buf.getvalue()


def test_filter_key_collapse():
    assert main._grid_filter_key("raw") == "raw"
    assert main._grid_filter_key("jpg") == "raw"
    assert main._grid_filter_key("rhef") == "rhef"
    assert main._grid_filter_key("hq_rhef") == "rhef"


def test_crop_to_aspect_geometry():
    src = _png_bytes(1000, 1000)
    # Portrait 11:14 → crop width, keep height.
    out = main._crop_to_aspect(src, [11, 14])
    im = Image.open(io.BytesIO(out))
    assert im.size[1] == 1000 and im.size[0] < 1000
    assert abs((im.size[0] / im.size[1]) - (11 / 14)) < 0.02
    # Landscape 14:11 → crop height, keep width.
    out2 = main._crop_to_aspect(src, [14, 11])
    im2 = Image.open(io.BytesIO(out2))
    assert im2.size[0] == 1000 and im2.size[1] < 1000
    assert abs((im2.size[0] / im2.size[1]) - (14 / 11)) < 0.02
    # Already square → returned unchanged (no re-encode).
    assert main._crop_to_aspect(src, [1, 1]) is src


def test_grid_cell_count():
    cells = main._grid_all_cells()
    assert len(cells) == len(main._GRID_WAVELENGTHS) * 2 * len(main._DEFAULT_MOCKUP_PRODUCTS)
    assert len(main._GRID_WAVELENGTHS) == 9
    assert set(main._GRID_FILTERS) == {"raw", "rhef"}


def test_coverage_and_missing(tmp_path=None):
    import tempfile
    tmp = pathlib.Path(tmp_path or tempfile.mkdtemp())
    # Redirect the cache dir + manifest at the module level.
    main.DEFAULT_MOCKUPS_DIR = tmp / "mockups"
    main.DEFAULT_MOCKUPS_MANIFEST = tmp / "default_mockups.json"
    main.DEFAULT_MOCKUPS_DIR.mkdir(parents=True, exist_ok=True)

    # Empty → everything missing.
    cov = main._mockup_coverage()
    total = len(main._grid_all_cells())
    assert cov["total"] == total
    assert cov["missing"] == total and cov["present"] == 0 and cov["complete"] is False
    assert main._next_incomplete_wavelength() == main._GRID_WAVELENGTHS[0]

    # Materialise ONE cell: png on disk + manifest entry.
    wl, filt, prod = main._GRID_WAVELENGTHS[0], "raw", main._DEFAULT_MOCKUP_PRODUCTS[0]
    pid = prod["id"]
    png, _thumb = main._grid_cell_paths(wl, filt, pid)
    png.parent.mkdir(parents=True, exist_ok=True)
    png.write_bytes(_noise_png_bytes())   # > 1000 bytes, clears the guard
    manifest = {str(wl): {filt: {pid: {"url": f"/asset/default/mockups/{wl}/{filt}/{pid}.png"}}}}
    main._persist_default_manifest(manifest)

    assert main._grid_cell_present(main._load_default_manifest(), wl, filt, pid) is True
    cov2 = main._mockup_coverage()
    assert cov2["present"] == 1 and cov2["missing"] == total - 1
    assert cov2["by_wavelength"][str(wl)]["present"] == 1


def test_manifest_persist_drops_legacy_flat_keys(tmp_path=None):
    import tempfile
    tmp = pathlib.Path(tmp_path or tempfile.mkdtemp())
    main.DEFAULT_MOCKUPS_MANIFEST = tmp / "default_mockups.json"
    # Mixed: a nested wl key + a stale flat product key.
    mixed = {"171": {"raw": {"poster_matte": {"url": "u"}}},
             "poster_matte": {"url": "legacy-flat"}}
    main._persist_default_manifest(mixed)
    loaded = main._load_default_manifest()
    assert "171" in loaded and "poster_matte" not in loaded  # flat key dropped


def _run_all():
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} checks passed.")


if __name__ == "__main__":
    _run_all()
