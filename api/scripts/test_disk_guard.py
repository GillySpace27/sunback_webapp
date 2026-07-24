#!/usr/bin/env python3
"""Self-check for the disk guard + preview-failure classification.

Run: python3 api/scripts/test_disk_guard.py   (no framework, no fixtures)

Covers the 2026-07-24 outage: a full volume made every render raise
[Errno 28], which was recorded as "no VSO data for this date" and served to
customers forever. The rules that must hold:
  1. infrastructure failures are NOT remembered (they retry)
  2. genuine no-data failures ARE remembered, but expire
  3. the temp cache prunes oldest-first when the disk is over target
"""
import os
import sys
import time
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("SOLAR_ARCHIVE_SKIP_HEAVY_IMPORTS", "1")

from api.main import (  # noqa: E402
    _is_infrastructure_error,
    _preview_fail_reason,
    _preview_failed,
    _prune_temp_cache,
    _disk_used_pct,
)


def test_infra_errors_are_not_our_users_fault():
    assert _is_infrastructure_error(OSError(28, "No space left on device"))
    assert _is_infrastructure_error(MemoryError())
    assert _is_infrastructure_error(Exception("Read timed out"))
    assert _is_infrastructure_error(Exception("502 Bad Gateway"))
    # A genuine data gap is NOT infrastructure — that one we may remember.
    assert not _is_infrastructure_error(ValueError("No VSO records returned"))
    assert not _is_infrastructure_error(Exception("empty result set"))


def test_failure_memory_expires():
    key = ("20230102_1200", 304)
    _preview_failed.clear()
    _preview_failed[key] = (time.time() + 60, "No VSO AIA data for this date/wavelength")
    assert _preview_fail_reason(key) == "No VSO AIA data for this date/wavelength"
    # Expired entries evaporate instead of blacklisting the date forever.
    _preview_failed[key] = (time.time() - 1, "No VSO AIA data for this date/wavelength")
    assert _preview_fail_reason(key) is None
    assert key not in _preview_failed, "expired entry should be evicted on read"
    assert _preview_fail_reason(("nope", 171)) is None


def test_prune_removes_oldest_first():
    import api.main as m

    with tempfile.TemporaryDirectory() as d:
        made = []
        for i in range(3):
            p = os.path.join(d, "temp_combined_SDO_%d_2026_1200.npz" % (100 + i))
            with open(p, "wb") as fh:
                fh.write(b"x" * 1024)
            os.utime(p, (1000 + i, 1000 + i))  # ascending mtime
            made.append(p)

        orig_dir, orig_pct = m.OUTPUT_DIR, m._disk_used_pct
        m.OUTPUT_DIR = d
        try:
            # Report "full" until 2 files are gone, then report "fine".
            m._disk_used_pct = lambda path=None: 0.0 if len(
                [f for f in os.listdir(d) if f.endswith(".npz")]) <= 1 else 99.0
            removed = m._prune_temp_cache()
            left = sorted(f for f in os.listdir(d) if f.endswith(".npz"))
            assert removed == 2, removed
            assert left == [os.path.basename(made[2])], left  # newest survives
        finally:
            m.OUTPUT_DIR, m._disk_used_pct = orig_dir, orig_pct


def test_disk_pct_is_sane():
    pct = _disk_used_pct("/")
    assert 0.0 <= pct <= 100.0, pct


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok  %s" % name)
    print("all disk-guard checks passed")
