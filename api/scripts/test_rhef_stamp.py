"""SU-18: the RHEF stamp line beside a preview and in the grid manifest (new fields only).

Run: python3 api/scripts/test_rhef_stamp.py
The line grammar is heliosoftware/spec/rhef/conventions.md section 5. The convention
and deviations come from the fastRHEF registry row "webapp" / "sunkit-vendored-wheel"
(convention sunkit-0.7, deviations none). The Upsilon default is read from the installed
sunkit-image signature when it imports; otherwise that one assertion prints SKIP.
"""
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from api import rhef_stamp as r  # noqa: E402

PATTERN = re.compile(
    r"^RHEF (\S+) via (\S+) (\S+); upsilon=(none|[0-9.eE+-]+,[0-9.eE+-]+); "
    r"deviations=(none|[A-Z0-9-]+(?:,[A-Z0-9-]+)*)(; ref=doi:\S+)?$")

line = r.build_stamp(version="0.1.dev308+g41e89767f")
assert line == ("RHEF sunkit-0.7 via sunkit-image 0.1.dev308+g41e89767f; "
                "upsilon=0.35,0.35; deviations=none"), line
assert PATTERN.match(line), "the stamp matches the section 5 pattern"
assert "unknown" in r.build_stamp(version=None), "unreadable version is written unknown"
assert PATTERN.match(r.build_stamp(version=None))
assert r.build_stamp(version="1", upsilon=(0.2, 0.5)).count("upsilon=0.2,0.5") == 1
assert "upsilon=none" in r.build_stamp(version="1", upsilon=None)
assert "—" not in line

tmp = os.path.join(tempfile.mkdtemp(), "p_filtered.png")
assert r.read_stamp(tmp) == {}, "no sidecar: nothing, never a guess"
assert r.write_stamp(tmp, version="9.9") is True
got = r.read_stamp(tmp)
assert list(got) == ["rhef_stamp"] and PATTERN.match(got["rhef_stamp"]), got
with open(r.sidecar_path(tmp), "w") as fh:
    fh.write("{not json")
assert r.read_stamp(tmp) == {}, "a corrupt sidecar reads as none"
with open(r.sidecar_path(tmp), "w") as fh:
    fh.write('{"rhef_stamp": "not a stamp"}')
assert r.read_stamp(tmp) == {}, "only a line that matches the pattern comes back"

try:
    import inspect
    from sunkit_image import radial
    default = inspect.signature(radial.rhef).parameters["upsilon"].default
    assert default == r.UPSILON_DEFAULT, f"sunkit-image default {default} != {r.UPSILON_DEFAULT}"
except ImportError:
    print("SKIP: sunkit_image not importable; Upsilon default not compared")

# Wiring: new fields only, beside the old ones (source text, no server start).
here = os.path.dirname(__file__)
main_src = open(os.path.join(here, "..", "main.py"), encoding="utf-8").read()
assert main_src.count("_rhef_stamp.read_stamp(out_path_filtered)") == 2, "both preview answers carry the stamp"
assert main_src.count("_rhef_stamp.write_stamp(out_path_filtered)") == 1, "the stamp is written where RHEF ran"
assert '"preview_url": url_path_filtered' in main_src, "old preview_url key kept"
assert main_src.count('entry["rhef_stamp"]') == 1, "grid manifest entry carries the stamp for the rhef filter"
print("test_rhef_stamp: ok")
