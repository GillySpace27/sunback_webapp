"""Filament-eruption on-disk test must read negative helioprojective coordinates.

Run: python3 api/scripts/test_hek_fe_disk.py
Before the fix, _row_to_candidate read hpc_x/hpc_y through _float_or, whose
"missing" sentinel is anything <= -1, so every coordinate on the west or south
half of the disk became 0 and the position was reported as unknown.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api import hek_routes as h  # noqa: E402


def fe(x, y):
    row = {"event_starttime": "2014-10-24T01:41:00", "area_atdiskcenter": 2.0e10,
           "hpc_x": x, "hpc_y": y, "frm_name": "t"}
    return h._row_to_candidate(row, "FE", "filament")


assert fe(-300.0, -200.0)["on_disk"] is True, "negative coords, well inside the limb"
assert fe(-700.0, -700.0)["on_disk"] is False, "radius ~990 arcsec is off the limb"
assert fe(300.0, 200.0)["on_disk"] is True, "positive coords unchanged"
assert fe(None, None)["on_disk"] is None, "no position stays unknown"
print("test_hek_fe_disk: ok")
