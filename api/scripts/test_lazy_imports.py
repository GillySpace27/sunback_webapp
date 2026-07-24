#!/usr/bin/env python3
"""Self-check for the deferred science-stack imports.

Run: python3 api/scripts/test_lazy_imports.py

The machine scales to zero, so importing sunpy/matplotlib/aiapy at module
scope meant every wake paid ~19s before it could answer /api/health. These
asserts fail if someone reintroduces an eager import — the failure mode is
invisible in dev (warm cache) and only shows up as a cold-start timeout in
front of a customer.
"""
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
HEAVY = ("sunpy", "matplotlib", "astropy", "sunkit_image", "aiapy", "skimage")


def _run(snippet):
    """Import api.main in a FRESH interpreter — sys.modules state is the thing
    under test, so it can't be checked in a process that already imported."""
    out = subprocess.run(
        [sys.executable, "-c", snippet],
        cwd=ROOT, capture_output=True, text=True, timeout=300,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    return out.stdout.strip().splitlines()[-1]


def test_importing_the_app_does_not_drag_in_the_science_stack():
    got = _run(
        "import sys; sys.path.insert(0,'.');\n"
        "import api.main;\n"
        "print('LOADED:' + ','.join(m for m in %r if m in sys.modules))" % (HEAVY,)
    )
    loaded = got.split("LOADED:", 1)[1]
    assert loaded == "", (
        "these imported at module scope and will be paid on every cold "
        "start: %s" % loaded
    )


def test_touching_a_proxy_loads_the_whole_stack():
    # All-or-nothing matters: sunpy.visualization.colormaps registers the
    # sdoaia* colour tables as an import side effect, so pulling in plt
    # without it would leave get_cmap('sdoaia304') broken at render time.
    got = _run(
        "import sys; sys.path.insert(0,'.');\n"
        "import api.main as m;\n"
        "cmap = m.plt.get_cmap('sdoaia304');\n"
        "assert m._heavy_loaded, 'touching plt should have loaded the stack';\n"
        "assert callable(m.rhef) and not isinstance(m.rhef, m._LazyHeavy);\n"
        "print('OK:' + cmap.name)"
    )
    assert got == "OK:sdoaia304", got


def test_default_wavelengths_are_plain_ints():
    # They used to be astropy Quantities built at module scope, which forced
    # the whole stack in before the first request.
    got = _run(
        "import sys; sys.path.insert(0,'.');\n"
        "import api.main as m;\n"
        "assert isinstance(m.DEFAULT_AIA_WAVELENGTH, int), m.DEFAULT_AIA_WAVELENGTH;\n"
        "assert isinstance(m.DEFAULT_EIT_WAVELENGTH, int);\n"
        "assert not m._heavy_loaded, 'reading the defaults must stay cheap';\n"
        "print('OK:%d,%d' % (m.DEFAULT_AIA_WAVELENGTH, m.DEFAULT_EIT_WAVELENGTH))"
    )
    assert got == "OK:211,195", got


def test_cold_import_is_fast():
    t = time.time()
    _run("import sys; sys.path.insert(0,'.');\nimport api.main;\nprint('ok')")
    elapsed = time.time() - t
    # Generous: this runs on dev machines and CI boxes of varying speed. The
    # point is to catch a regression back to importing the science stack,
    # which costs ~19s on the production VM.
    assert elapsed < 10, "app import took %.1fs — did an eager import return?" % elapsed


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok  %s" % name)
    print("all lazy-import checks passed")
