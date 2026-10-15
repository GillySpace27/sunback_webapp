"""MH-19: the FITS observation time of a cached preview, kept beside the PNGs.

The preview endpoint answers from file existence, so the DATE-OBS read while
the FITS was open is written to `<filtered png>.obs.json` and read back on
every answer. Missing or unreadable sidecar means None: the card then says the
time is the one requested, and never guesses.
"""
import json
import os
import re

_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def sidecar_path(filtered_png_path):
    return str(filtered_png_path) + ".obs.json"


def to_iso_z(value):
    """datetime or ISO-ish string -> 'YYYY-MM-DDTHH:MM:SSZ', else None."""
    try:
        if hasattr(value, "strftime"):
            s = value.strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            s = str(value).strip().replace(" ", "T").split(".")[0]
            s = s if s.endswith("Z") else s + "Z"
    except (TypeError, ValueError):
        return None
    return s if _ISO.match(s) else None


def write_obs(filtered_png_path, obs, rung="vso"):
    iso = to_iso_z(obs)
    if iso is None:
        return False
    with open(sidecar_path(filtered_png_path), "w", encoding="utf-8") as fh:
        json.dump({"obs_time_utc": iso, "fetch_rung": rung}, fh)
    return True


def read_obs(filtered_png_path):
    """{'obs_time_utc': ..., 'fetch_rung': ...} or {} when unknown."""
    try:
        with open(sidecar_path(filtered_png_path), encoding="utf-8") as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return {}
    iso = to_iso_z(d.get("obs_time_utc")) if isinstance(d, dict) else None
    if iso is None:
        return {}
    rung = d.get("fetch_rung")
    return {"obs_time_utc": iso, "fetch_rung": rung if isinstance(rung, str) else None}
