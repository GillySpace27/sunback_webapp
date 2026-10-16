"""SU-18: the RHEF stamp line for images the store makes, kept beside the PNGs.

Line grammar: heliosoftware/spec/rhef/conventions.md section 5,
  RHEF <convention> via <implementation> <version>; upsilon=<lo>,<hi>; deviations=<ID>,...
The store runs the vendored sunkit-image wheel at its defaults. CONVENTION and
DEVIATIONS are read from the fastRHEF registry rows "sunkit-vendored-wheel" and
"webapp" (conventions/implementations.json): sunkit-0.7, no deviations. The
version is read from the installed package (importlib.metadata, so this module
loads no science stack). A missing or unreadable sidecar means no field: an
older preview is never given a stamp it did not earn. RHEF output is a
visualization, not a calibrated radiance.
"""
import json
import os
import re

CONVENTION = "sunkit-0.7"
IMPLEMENTATION = "sunkit-image"
DEVIATIONS = ()
UPSILON_DEFAULT = 0.35  # sunkit_image.radial.rhef default; test_rhef_stamp.py compares

_PATTERN = re.compile(
    r"^RHEF (\S+) via (\S+) (\S+); upsilon=(none|[0-9.eE+-]+,[0-9.eE+-]+); "
    r"deviations=(none|[A-Z0-9-]+(?:,[A-Z0-9-]+)*)(; ref=doi:\S+)?$")


def installed_version():
    try:
        from importlib.metadata import version
        return version(IMPLEMENTATION)
    except Exception:  # package metadata missing: write "unknown", per the spec
        return None


def build_stamp(version="__installed__", upsilon=(UPSILON_DEFAULT, UPSILON_DEFAULT)):
    if version == "__installed__":
        version = installed_version()
    if upsilon is None:
        ups = "none"
    else:
        lo, hi = (upsilon, upsilon) if isinstance(upsilon, (int, float)) else upsilon
        ups = f"{lo:g},{hi:g}"
    dev = ",".join(DEVIATIONS) or "none"
    return f"RHEF {CONVENTION} via {IMPLEMENTATION} {version or 'unknown'}; upsilon={ups}; deviations={dev}"


def sidecar_path(filtered_png_path):
    return str(filtered_png_path) + ".rhef.json"


def write_stamp(filtered_png_path, **kw):
    line = build_stamp(**kw)
    if not _PATTERN.match(line):
        return False
    with open(sidecar_path(filtered_png_path), "w", encoding="utf-8") as fh:
        json.dump({"rhef_stamp": line}, fh)
    return True


def read_stamp(filtered_png_path):
    """{'rhef_stamp': line} or {} when absent, unreadable or not a stamp."""
    try:
        with open(sidecar_path(filtered_png_path), encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return {}
    line = d.get("rhef_stamp") if isinstance(d, dict) else None
    return {"rhef_stamp": line} if isinstance(line, str) and _PATTERN.match(line) else {}
