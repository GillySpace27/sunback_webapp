"""Sanity check for the full-resolution AIA frame guard (print-quality path).

Run: python3 api/scripts/test_full_res_guard.py

The guard decides whether a FITS frame is allowed to satisfy the HQ/print
path. Getting it wrong in the permissive direction ships a 1024² synoptic
frame upscaled to a 4K print on a paid order, so this test pins both
directions with synthetic headers plus (when reachable) one real synoptic
frame from JSOC.
"""
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
from astropy.io import fits

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ.setdefault("SOLAR_ARCHIVE_OUTPUT_DIR", tempfile.mkdtemp())

# Import just the guard without dragging in the FastAPI app.
src = (Path(__file__).resolve().parents[1] / "main.py").read_text()
start = src.index("_FULL_RES_MAX_CDELT")
end = src.index("def _generate_preview_sync")
ns = {"os": os, "log_to_queue": lambda *_a, **_k: None}
exec(src[start:end], ns)  # noqa: S102 - our own source
_is_full_res_lev1 = ns["_is_full_res_lev1"]


def _write(path, data, **cards):
    hdu = fits.PrimaryHDU(data)
    for k, v in cards.items():
        hdu.header[k] = v
    hdu.writeto(path, overwrite=True)
    return path


tmp = Path(tempfile.mkdtemp())

# Real lev1 geometry: 4096², 0.6 arcsec/px → allowed.
lev1 = _write(tmp / "lev1.fits", np.zeros((4096, 4096), dtype=np.int16),
              CDELT1=0.599489, LVL_NUM=1.0)
assert _is_full_res_lev1(lev1) is True, "full-res lev1 must be accepted"

# Synoptic geometry: 1024², 2.4 arcsec/px → refused (the actual bug).
syn = _write(tmp / "syn.fits", np.zeros((1024, 1024), dtype=np.int16),
             CDELT1=2.4000003, LVL_NUM=1.5)
assert _is_full_res_lev1(syn) is False, "1024^2 synoptic frame must be refused"

# No CDELT1 at all: fall back to axis length.
big = _write(tmp / "big_nocdelt.fits", np.zeros((4096, 4096), dtype=np.int16))
assert _is_full_res_lev1(big) is True, "4096^2 without CDELT1 must be accepted"
small = _write(tmp / "small_nocdelt.fits", np.zeros((1024, 1024), dtype=np.int16))
assert _is_full_res_lev1(small) is False, "1024^2 without CDELT1 must be refused"

# Junk / missing / truncated inputs are refused, never raised on.
assert _is_full_res_lev1(None) is False
assert _is_full_res_lev1(str(tmp / "does_not_exist.fits")) is False
junk = tmp / "junk.fits"
junk.write_bytes(b"not a fits file" * 10_000)
assert _is_full_res_lev1(str(junk)) is False, "unreadable input must be refused, not raise"

print("full-res guard self-check OK (synthetic)")

# Optional live check against the real synoptic archive — skipped offline.
if os.environ.get("GUARD_TEST_NETWORK") == "1":
    import urllib.request
    url = ("https://jsoc1.stanford.edu/data/aia/synoptic/2024/05/10/H1200/"
           "AIA20240510_1200_0193.fits")
    real = tmp / "real_syn.fits"
    urllib.request.urlretrieve(url, real)
    assert _is_full_res_lev1(str(real)) is False, "real synoptic frame must be refused"
    print("full-res guard self-check OK (live synoptic frame refused)")
