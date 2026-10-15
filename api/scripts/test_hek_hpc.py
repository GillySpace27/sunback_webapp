"""Self-check for MH-17's additive HEK keys: /api/hek/best_time events carry
hpc_x and hpc_y in arcsec, negative coordinates survive, and a row without a
position says None rather than 0.
Run: python3 api/scripts/test_hek_hpc.py
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api import hek_routes as h  # noqa: E402

cand = {"time_iso": "2014-10-24T21:41:00", "event_type": "Flare", "event_code": "FL",
        "family": "flare", "tier": 2, "goes_class": "X3.1",
        "hpc_x": -320.5, "hpc_y": -310.0}
ev = h._candidate_to_event(cand, 0, 1)
assert ev["hpc_x"] == -320.5 and ev["hpc_y"] == -310.0, ev
ev = h._candidate_to_event(dict(cand, hpc_x=None, hpc_y=None), 0, 1)
assert ev["hpc_x"] is None and ev["hpc_y"] is None, ev

assert h._coord_or_none(-412.0) == -412.0, "a negative coordinate is a position, not a sentinel"
assert h._coord_or_none(-1.0) == -1.0
assert h._coord_or_none(None) is None
assert h._coord_or_none(math.nan) is None
assert h._coord_or_none("") is None


class Masked:
    mask = True


assert h._coord_or_none(Masked()) is None
print("test_hek_hpc: ok")
