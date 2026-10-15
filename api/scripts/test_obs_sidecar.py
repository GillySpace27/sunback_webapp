"""Pin the preview observation-time sidecar (MH-19).
Run: python3 api/scripts/test_obs_sidecar.py
"""
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api import obs_sidecar as o  # noqa: E402

tmp = Path(tempfile.mkdtemp()) / "preview_x_filtered.png"
assert o.read_obs(tmp) == {}, "no sidecar: unknown, not a guess"
assert o.write_obs(tmp, datetime(2026, 10, 1, 12, 0, 7)) is True
assert o.read_obs(tmp) == {"obs_time_utc": "2026-10-01T12:00:07Z", "fetch_rung": "vso"}
assert o.write_obs(tmp, "2026-10-01 12:00:07.123") is True
assert o.read_obs(tmp)["obs_time_utc"] == "2026-10-01T12:00:07Z"
assert o.write_obs(tmp, "garbage") is False, "unparseable time is never written"
Path(o.sidecar_path(tmp)).write_text("{not json")
assert o.read_obs(tmp) == {}, "a corrupt sidecar reads as unknown"
Path(o.sidecar_path(tmp)).write_text('{"obs_time_utc": "<script>"}')
assert o.read_obs(tmp) == {}, "only an ISO time comes back"
print("test_obs_sidecar: ok")
