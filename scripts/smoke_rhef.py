"""Build-time smoke check for the vendored sunkit-image RHEF wheel (RH-9).

Run from the repo root (the Dockerfile runs it right after `pip install -r
requirements.txt`). Exit 0 when the vendored wheel has the recorded sha256, the
installed sunkit-image is that wheel, and rhef on a small synthetic Map gives
finite values in [0, 1] within a generous time bound. Exit 1 otherwise.

    python scripts/smoke_rhef.py                    # the build-time check
    python scripts/smoke_rhef.py --golden DIR       # also the sunkit-0.7 golden cases

RHEF output is a visualization, not a calibrated radiance.
"""
import argparse
import functools
import hashlib
import importlib.metadata
import sys
import time
import zipfile
from pathlib import Path

WHEEL = "vendor/sunkit-image-41e89767f/sunkit_image-0.1.dev308+g41e89767f-py3-none-any.whl"
WHEEL_SHA256 = "df3123a4e0a0214324045febac239c28003f1bd6ab202e6ea77baf841fd35a41"
SUNKIT_VERSION = "0.1.dev308+g41e89767f"
TIME_BOUND_S = 30.0  # estimated: generous for a 64x64 map on a cold container

_failures = []


def check(ok, line):
    print(("ok   " if ok else "FAIL ") + line)
    if not ok:
        _failures.append(line)
    return ok


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def check_wheel_and_install():
    whl = Path(WHEEL)
    if not check(whl.is_file(), f"vendored wheel present: {WHEEL}"):
        return
    got = sha256(whl)
    check(got == WHEEL_SHA256, f"wheel sha256 {got} == {WHEEL_SHA256}")
    try:
        installed = importlib.metadata.version("sunkit_image")
    except importlib.metadata.PackageNotFoundError:
        installed = "not installed"
    check(installed == SUNKIT_VERSION, f"installed sunkit_image {installed} == {SUNKIT_VERSION}")
    import sunkit_image.radial as radial
    with zipfile.ZipFile(whl) as z:
        packed = z.read("sunkit_image/radial.py")
    check(Path(radial.__file__).read_bytes() == packed,
          f"installed {radial.__file__} is byte-equal to the wheel's sunkit_image/radial.py")


def synthetic_map(n=64):
    import numpy as np
    import sunpy.map
    yy, xx = np.mgrid[0:n, 0:n]
    r = np.hypot(xx - (n - 1) / 2, yy - (n - 1) / 2)
    rng = np.random.default_rng(20261001)
    data = 1000.0 * np.exp(-r / 8.0) + rng.random((n, n))
    meta = {
        "ctype1": "HPLN-TAN", "ctype2": "HPLT-TAN", "cunit1": "arcsec", "cunit2": "arcsec",
        "cdelt1": 2400.0 / n, "cdelt2": 2400.0 / n, "crpix1": (n + 1) / 2, "crpix2": (n + 1) / 2,
        "crval1": 0.0, "crval2": 0.0, "naxis1": n, "naxis2": n,
        "date-obs": "2026-10-01T00:00:00.000", "rsun_ref": 696000000.0, "rsun_obs": 960.0,
        "dsun_obs": 1.495978707e11, "hgln_obs": 0.0, "hglt_obs": 0.0,
    }
    return sunpy.map.Map(data, meta)


def check_rhef_runs():
    import numpy as np
    from sunkit_image.radial import rhef
    smap = synthetic_map()
    t0 = time.perf_counter()
    out = rhef(smap, progress=False).data
    dt = time.perf_counter() - t0
    finite = out[np.isfinite(out)]
    check(out.shape == smap.data.shape, f"rhef output shape {out.shape}")
    check(finite.size >= 0.95 * out.size, f"finite pixels {finite.size} of {out.size} (need 95%)")
    check(finite.size > 0 and finite.min() >= 0.0 and finite.max() <= 1.0,
          f"finite output in [0, 1]: min {finite.min() if finite.size else 'n/a'} max {finite.max() if finite.size else 'n/a'}")
    check(dt < TIME_BOUND_S, f"rhef on 64x64 took {dt:.3f} s (bound {TIME_BOUND_S} s)")


def read_props(path):
    props = {}
    for raw in Path(path).read_text().splitlines():
        line = raw.strip()
        if line and not line.startswith(("#", "!")) and "=" in line:
            k, v = line.split("=", 1)
            props[k.strip()] = v.strip()
    return props


def run_golden(golden_dir):
    """sunkit-0.7 cases: rank on the stored edges and radii, compare exactly."""
    from unittest import mock
    import json
    import numpy as np
    import astropy.units as u
    import sunpy.map
    import sunkit_image.radial as radial
    bundle = Path(golden_dir)
    version = json.loads((bundle / "manifest.json").read_text()).get("bundle_version", "unknown")
    counts = {"PASS": 0, "FAIL": 0, "SKIPPED": 0}
    for case in sorted(p for p in bundle.iterdir() if (p / "case.properties").is_file()):
        props = read_props(case / "case.properties")
        cid = props.get("case_id", case.name)
        expected_path = case / "expected_sunkit-0.7.f64"
        if "sunkit-0.7" not in props.get("conventions", "").split(",") or not expected_path.is_file():
            continue
        if props.get("radius_unit") != "R_sun":
            print(f"RHEF-CONFORMANCE impl=webapp bundle={version} case={cid} convention=sunkit-0.7 max_abs_diff=nan result=SKIPPED (radius_unit {props.get('radius_unit')})")
            counts["SKIPPED"] += 1
            continue
        ny, nx = (int(s) for s in props["shape"].split(","))
        values = np.fromfile(case / "input.f64", dtype="<f8").reshape(ny, nx)
        radii = np.fromfile(case / "radii.f64", dtype="<f8").reshape(ny, nx) * u.R_sun
        edges = np.fromfile(case / "edges.f64", dtype="<f8").reshape(2, -1) * u.R_sun
        expected = np.fromfile(expected_path, dtype="<f8").reshape(ny, nx)
        ups = props.get("upsilon", "none")
        upsilon = None if ups == "none" else tuple(float(s) for s in ups.split(","))
        fill = props.get("fill", "nan")
        fill = np.nan if fill == "nan" else float(fill)
        app_r = float(props.get("application_radius", "0")) * u.R_sun
        smap = sunpy.map.Map(values, synthetic_map(2).meta)  # WCS unused: radii are injected
        with mock.patch.object(radial, "find_radial_bin_edges", lambda m, e=None: (edges, radii)):
            got = radial.rhef(smap, radial_bin_edges=edges, upsilon=upsilon,
                              application_radius=app_r, fill=fill, progress=False).data
        same_nan = bool(np.array_equal(np.isnan(got), np.isnan(expected)))
        both = ~np.isnan(got) & ~np.isnan(expected)
        diff = float(np.max(np.abs(got[both] - expected[both]))) if both.any() else 0.0
        result = "PASS" if same_nan and diff == 0.0 else "FAIL"
        counts[result] += 1
        shown = f"{diff:.3e}" if same_nan else "nan"
        print(f"RHEF-CONFORMANCE impl=webapp bundle={version} case={cid} convention=sunkit-0.7 max_abs_diff={shown} result={result}")
        if result == "FAIL":
            _failures.append(f"golden {cid}")
    print(f"RHEF-CONFORMANCE impl=webapp summary pass={counts['PASS']} report=0 fail={counts['FAIL']} mode=enforce")
    check(counts["PASS"] > 0, f"golden sunkit-0.7 cases run: {counts['PASS'] + counts['FAIL']}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--golden", metavar="DIR", help="fastRHEF golden/ bundle directory")
    args = ap.parse_args(argv)
    steps = [check_wheel_and_install, check_rhef_runs]
    if args.golden:
        steps.append(functools.partial(run_golden, args.golden))
    for step in steps:
        try:
            step()
        except Exception as exc:  # an import or runtime error is a failed check, not a traceback
            check(False, f"{getattr(step, '__name__', 'golden')} raised {type(exc).__name__}: {exc}")
    print(f"smoke_rhef: {'FAIL' if _failures else 'PASS'} ({len(_failures)} failed)")
    return 1 if _failures else 0


if __name__ == "__main__":
    sys.exit(main())
