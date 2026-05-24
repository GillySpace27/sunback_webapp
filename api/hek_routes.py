"""HEK "best time of day" lookup.

Queries the Heliophysics Event Knowledgebase (via sunpy.net.hek) for a given
UTC date and returns the peak time of the most striking event so the
frontend can auto-fill the time-of-day picker.

Ranking (locked decision — see SESSION_NOTES.md):
  1. CMEs / filament-prominence eruptions  (above flares — flares oversaturate at 193 Å)
  2. Flares                                 (ranked by GOES X-ray class)
  3. Largest active region                  (NOAA AR area at disk centre)
  4. Quiet-day fallback                     → noon UTC

Per-date JSON cache lives on the persistent disk (alongside the default-image
cache) because HEK queries take 2–10 s and we don't want to re-pay that on
every page load. A negative result (quiet day) is cached too.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query


# ── GOES X-ray class ranking ────────────────────────────────────────────────
# X-class is ~10× M-class is ~10× C-class is ~10× B-class is ~10× A-class.
# Convert "M5.4" → 2.54 so we can sort numerically and a stronger flare always
# wins. Empty / unparseable → 0.0 (will lose to anything classified).
_GOES_LETTER = {"A": 0.0, "B": 1.0, "C": 2.0, "M": 3.0, "X": 4.0}


def _goes_score(cls: str) -> float:
    """Numeric score for a GOES X-ray class string, e.g. "X9.3" → 4.93.

    Mantissa is clamped to [0, 9.99] so a malformed "M99" row doesn't
    score 12.9 and beat any X-class flare under X90 (which is every real
    one). Science-audit fix: catches HEK data-revision edge cases.
    """
    if not cls:
        return 0.0
    s = str(cls).strip().upper()
    if not s:
        return 0.0
    letter = s[0]
    base = _GOES_LETTER.get(letter)
    if base is None:
        return 0.0
    m = re.match(r"^[A-Z]([0-9]+(?:\.[0-9]+)?)", s)
    if not m:
        return base
    mag = min(float(m.group(1)), 9.99) / 10.0
    return base + mag


def _float_or(value, default: float = 0.0) -> float:
    """HEK columns are often masked / unit-bearing / blank. Coerce defensively.

    The HEK service returns several columns as astropy `MaskedQuantity`
    (e.g. ``cme_radiallinvel`` is ``113. km / s``). A naive ``float(v)`` on a
    unit-bearing Quantity raises ``TypeError: only dimensionless scalar
    quantities can be converted``, so without this helper every CME ended up
    with a 0 score and the FIFO tie-broke between candidates.

    Also normalises common "no data" sentinels: explicit mask, NaN, and the
    -1 / -9999 magic numbers that HEK uses for missing intensity fields.
    """
    try:
        if value is None:
            return default
        # Astropy MaskedQuantity exposes .mask; True means missing.
        if getattr(value, "mask", False) is True:
            return default
        # Quantity-with-units → strip units before coercion.
        if hasattr(value, "value"):
            value = value.value
        # MaskedNDArray scalars need .item() to drop the mask wrapper.
        if hasattr(value, "item") and not isinstance(value, (int, float)):
            try:
                value = value.item()
            except Exception:
                pass
        f = float(value)
        if f != f:  # NaN
            return default
        # HEK's "missing" sentinels for speeds / masses / areas.
        if f <= -1.0 or f == -9999.0:
            return default
        return f
    except (TypeError, ValueError):
        return default


def _row_time(row, key: str) -> Optional[str]:
    """Pull an HEK time column and return ISO-8601 'YYYY-MM-DDTHH:MM:SS' UTC."""
    try:
        val = row[key]
    except Exception:
        return None
    if val is None or val == "":
        return None
    # Astropy Time / TimeISOT object → format directly
    try:
        from astropy.time import Time as _AstropyTime
        if isinstance(val, _AstropyTime):
            return val.isot[:19]
    except Exception:
        pass
    s = str(val).strip()
    if not s or s.lower() == "none":
        return None
    # HEK serves "2014-10-24T01:41:00" already — be tolerant of trailing ms / Z
    s = s.replace("Z", "").split(".")[0]
    return s[:19]


def _hhmm_from_iso(iso: Optional[str]) -> Optional[str]:
    if not iso or len(iso) < 16:
        return None
    return iso[11:16]


def _pick_time(row) -> Optional[str]:
    """Prefer peaktime → starttime → endtime."""
    for k in ("event_peaktime", "event_starttime", "event_endtime"):
        t = _row_time(row, k)
        if t:
            return t
    return None


# ── Cache I/O ───────────────────────────────────────────────────────────────

def _cache_path(cache_root: Path, date_str: str) -> Path:
    return cache_root / "hek" / f"{date_str}.json"


def _read_cache(cache_root: Path, date_str: str) -> Optional[Dict[str, Any]]:
    p = _cache_path(cache_root, date_str)
    if not p.exists() or p.stat().st_size <= 2:
        return None
    try:
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_cache(cache_root: Path, date_str: str, payload: Dict[str, Any]) -> None:
    p = _cache_path(cache_root, date_str)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp, p)
    except Exception as e:  # cache write failure should not break the response
        print(f"[hek] cache write failed for {date_str}: {e}", flush=True)


# ── HEK query + ranking ─────────────────────────────────────────────────────

def _query_hek(date_str: str) -> Dict[str, Any]:
    """Run the HEK query for one UTC day. Returns the response payload dict.

    Never raises on quiet days; only raises if the underlying SunPy/HEK call
    blows up in an unexpected way (caller catches and noon-fallbacks).
    """
    # Lazy-import so module load doesn't pay the SunPy startup cost when the
    # route is never hit, and so test environments without sunpy can import
    # this file for the pure-Python ranking helpers above.
    from sunpy.net import Fido, attrs as a

    day = datetime.strptime(date_str, "%Y-%m-%d")
    next_day = day + timedelta(days=1)

    # One Fido search per family — HEK's OR-syntax in attrs is finicky across
    # SunPy versions, and per-type queries also make ranking simpler.
    families = [
        ("CE", "cme"),                # coronal mass ejection
        ("FE", "filament_eruption"),  # filament / prominence eruption
        ("FL", "flare"),
        ("AR", "active_region"),
    ]

    candidates: List[Dict[str, Any]] = []
    errors: List[str] = []
    for code, family in families:
        try:
            res = Fido.search(
                a.Time(day, next_day),
                a.hek.EventType(code),
            )
            if "hek" not in res.keys():
                continue
            table = res["hek"]
            for row in table:
                cand = _row_to_candidate(row, code, family)
                if cand is None:
                    continue
                # HEK's time filter matches on event_starttime overlapping
                # the window, so a CME that started at 2023-12-31T21:48
                # surfaces on a 2024-01-01 query. If we used that peak time
                # the editor would fetch FITS for the wrong day. Clamp to
                # candidates whose chosen time actually falls on date_str.
                if not cand["time_iso"].startswith(date_str):
                    continue
                candidates.append(cand)
        except Exception as e:
            errors.append(f"{code}:{type(e).__name__}:{e}")
            continue

    picks = _pick_top_n(candidates, n=3)
    if not picks:
        return _noon_fallback(date_str, reason="quiet_day", errors=errors)
    events = [_candidate_to_event(c, i, len(picks)) for i, c in enumerate(picks)]
    chosen = picks[0]
    # Top-1 fields are kept at the response top level for back-compat with
    # the original single-event consumers; the 4-tile picker reads `events`.
    return {
        "ok": True,
        "date": date_str,
        "events": events,
        "time_utc": _hhmm_from_iso(chosen["time_iso"]) or "12:00",
        "peak_time_iso": chosen["time_iso"],
        "event_type": chosen["event_type"],
        "event_code": chosen["event_code"],
        "family": chosen["family"],
        "tier": chosen["tier"],
        "goes_class": chosen.get("goes_class"),
        "ar_number": chosen.get("ar_number"),
        "intensity": chosen.get("intensity"),
        "intensity_label": chosen.get("intensity_label"),
        "frm_name": chosen.get("frm_name"),
        "fallback": False,
        "source": "HEK via SunPy",
        "errors": errors or None,
    }


def _row_to_candidate(row, code: str, family: str) -> Optional[Dict[str, Any]]:
    """Score a single HEK row. Higher score wins within a tier; tier wins first."""
    time_iso = _pick_time(row)
    if not time_iso:
        return None

    frm = None
    try:
        frm = str(row["frm_name"])
    except Exception:
        pass

    if code == "CE":
        # Primary intensity: CDAW/CACTus linear speed (km/s). Fallback to the
        # max-speed column some FRMs populate; final fallback is angular
        # width so a slow-but-wide halo CME still beats a slower, narrower
        # one. We want every CME to rank above the 0.1 sentinel that
        # filament eruptions get, so floor the score at 1.0 once we know
        # it's a real CME row (time present, frm present).
        speed = _float_or(_safe_get(row, "cme_radiallinvel"))
        if speed <= 0:
            speed = _float_or(_safe_get(row, "cme_radiallinvelmax"))
        if speed <= 0:
            speed = _float_or(_safe_get(row, "cme_speed"))
        ang_width = _float_or(_safe_get(row, "cme_angularwidth"))
        if speed > 0:
            label = f"{int(speed)} km/s"
            intensity = speed
            score = speed
        elif ang_width > 0:
            # Score < a 1 km/s CME so a measured-speed event always wins,
            # but well above a non-CME tier-1 fallback.
            label = f"width {int(ang_width)}°"
            intensity = ang_width
            score = max(1.0, ang_width / 360.0)
        else:
            label = None
            intensity = None
            score = 1.0  # baseline so any CME beats a filament w/o area
        return {
            "event_code": "CE",
            "event_type": "CME",
            "family": family,
            "tier": 1,
            "tier_score": score,
            "intensity": intensity,
            "intensity_label": label,
            "time_iso": time_iso,
            "frm_name": frm,
        }

    if code == "FE":
        area = _float_or(_safe_get(row, "area_atdiskcenter"))
        # On-disk vs limb: drives the wavelength suggestion on the
        # frontend. On-disk filament eruptions show best in 193 (arcade +
        # dimming); off-limb prominence eruptions show best in 304 (cool
        # He II). Use helioprojective-cartesian radius in arcsec; ~960" is
        # the solar limb, 900" is a safe on-disk cutoff that avoids
        # near-limb cases the foot-points dominate.
        hpc_x = _float_or(_safe_get(row, "hpc_x"))
        hpc_y = _float_or(_safe_get(row, "hpc_y"))
        radius = (hpc_x ** 2 + hpc_y ** 2) ** 0.5 if (hpc_x or hpc_y) else 0.0
        on_disk = (0.0 < radius < 900.0) if radius else None  # None = unknown
        return {
            "event_code": "FE",
            "event_type": "Filament eruption",
            "family": family,
            "tier": 1,
            # Even an unmeasured eruption beats a noon fallback — pin a small
            # positive score so a zero-area FE still ranks above quiet day.
            "tier_score": area if area > 0 else 0.1,
            "intensity": area if area > 0 else None,
            "intensity_label": (
                f"area {area:.2e} on-disk" if area > 0 else None
            ),
            "on_disk": on_disk,
            "time_iso": time_iso,
            "frm_name": frm,
        }

    if code == "FL":
        goes = ""
        try:
            goes = str(row["fl_goescls"] or "").strip()
        except Exception:
            goes = ""
        # Drop sub-burst rows that lack a GOES class. HEK ingests "Flare
        # Detective — TriggerModule" records that catalogue every
        # impulsive sub-peak of a single flare without a goescls; they
        # outrank the authoritative SWPC/NOAA row by table position and
        # were the cause of the 2017-09-06 X9.3 being demoted to X2.2 in
        # the picker. Science-audit fix.
        if not goes or len(goes) < 2 or goes[0].upper() not in ("A", "B", "C", "M", "X"):
            return None
        score = _goes_score(goes)
        # Boost authoritative FRMs (SWPC, NOAA, GOES) so a sub-burst from
        # an exploratory FRM doesn't tie-break above the official record.
        frm_upper = (frm or "").upper()
        if frm_upper.startswith(("SWPC", "NOAA", "GOES")):
            score *= 1.25
        return {
            "event_code": "FL",
            "event_type": "Flare",
            "family": family,
            "tier": 2,
            "tier_score": score,
            "goes_class": goes,
            "intensity": score,
            "intensity_label": f"GOES {goes}",
            "time_iso": time_iso,
            "frm_name": frm,
        }

    if code == "AR":
        area = _float_or(_safe_get(row, "area_atdiskcenter"))
        ar_num = None
        try:
            v = row["ar_noaanum"]
            ar_num = int(v) if v not in (None, "", 0) else None
        except Exception:
            ar_num = None
        # ARs are long-lived (days). Snap to noon so we don't pin the time to
        # an arbitrary HEK record stamp at 00:00.
        noon = time_iso[:10] + "T12:00:00"
        return {
            "event_code": "AR",
            "event_type": "Active region",
            "family": family,
            "tier": 3,
            "tier_score": area,
            "ar_number": ar_num,
            "intensity": area if area > 0 else None,
            "intensity_label": (
                f"NOAA AR {ar_num}" if ar_num else f"area {area:.2e}"
            ) if (ar_num or area > 0) else None,
            "time_iso": noon,
            "frm_name": frm,
        }

    return None


def _safe_get(row, key: str):
    try:
        return row[key]
    except Exception:
        return None


def _rank(candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not candidates:
        return None
    # Lower tier number wins, then higher tier_score within the tier.
    candidates.sort(key=lambda c: (c["tier"], -float(c.get("tier_score") or 0.0)))
    return candidates[0]


_MIN_SPREAD_MINUTES = 45  # enforced gap between picked events; relaxed below if needed


def _minutes_between(iso_a: str, iso_b: str) -> float:
    """Absolute minute delta between two ISO 'YYYY-MM-DDTHH:MM:SS' strings."""
    try:
        a = datetime.strptime(iso_a[:19], "%Y-%m-%dT%H:%M:%S")
        b = datetime.strptime(iso_b[:19], "%Y-%m-%dT%H:%M:%S")
    except Exception:
        return 0.0
    return abs((a - b).total_seconds()) / 60.0


def _pick_top_n(
    candidates: List[Dict[str, Any]],
    n: int = 3,
    min_spread_minutes: float = _MIN_SPREAD_MINUTES,
) -> List[Dict[str, Any]]:
    """Pick up to N candidates with tier-diversity preference + spread enforcement.

    Goals (in priority order):
      1. Always include the highest-ranked candidate (lowest tier, top score).
      2. Prefer one candidate per distinct tier next, so an X-flare day with
         19 catalogued CMEs surfaces as CME + flare + AR rather than three
         near-identical CMEs.
      3. Enforce >= min_spread_minutes between picks so a "storm" day with
         19 CMEs in a half-hour doesn't collapse into a useless trio.
      4. Fall through to lower spread thresholds if a tight day can't be
         satisfied at the strict gap.
    """
    if not candidates:
        return []
    sorted_all = sorted(
        candidates,
        key=lambda c: (c["tier"], -float(c.get("tier_score") or 0.0)),
    )

    def _spread_ok(c, picked, relax):
        """Spread enforced only against same-tier picks.

        Cross-tier picks (CME + flare + AR) are different physical
        phenomena that often co-occur in an eruption sequence — e.g. the
        2017-09-06 X9.3 at 11:53 and its associated 1571 km/s CME at
        12:24 are the SAME event chain, 31 min apart, and a hard cross-
        tier spread filter would silently drop the X9.3 from the picker.
        Within-tier spread still applies (catches duplicate FRM records).
        """
        return all(
            _minutes_between(c["time_iso"], p["time_iso"]) >= relax
            for p in picked if p["tier"] == c["tier"]
        )

    for relax in (min_spread_minutes, min_spread_minutes / 2.0, 0.0):
        picked: List[Dict[str, Any]] = []
        # Pass 1: best-of-each-tier (with same-tier spread). Walk tiers
        # in priority order (1, 2, 3), take the highest-scored candidate
        # from each that satisfies same-tier spread.
        for tier in (1, 2, 3, 4):
            if len(picked) >= n:
                break
            for c in sorted_all:
                if c["tier"] != tier:
                    continue
                if _spread_ok(c, picked, relax):
                    picked.append(c)
                    break
        # Pass 2: fill remaining slots with the next-best regardless of
        # tier (still with same-tier spread).
        for c in sorted_all:
            if len(picked) >= n:
                break
            if c in picked:
                continue
            if _spread_ok(c, picked, relax):
                picked.append(c)
        if len(picked) >= min(n, len(candidates)):
            return picked
    return picked


def _candidate_to_event(cand: Dict[str, Any], rank_index: int, total_picks: int) -> Dict[str, Any]:
    """Public event shape — what the frontend renders into a tile.

    `rank_index` is 0-based. Tile #0 gets a "Top pick" label so screen readers
    convey the ranking (a11y agent's recommendation: rank must be in the
    accessible name, not just visual order).
    """
    if rank_index == 0 and total_picks > 1:
        rank_label = "Top pick"
    elif rank_index == 0:
        rank_label = "Pick"
    else:
        rank_label = f"Also notable"
    return {
        "rank": rank_index + 1,
        "rank_label": rank_label,
        "time_utc": _hhmm_from_iso(cand["time_iso"]) or "12:00",
        "peak_time_iso": cand["time_iso"],
        "event_type": cand["event_type"],
        "event_code": cand["event_code"],
        "family": cand["family"],
        "tier": cand["tier"],
        "goes_class": cand.get("goes_class"),
        "ar_number": cand.get("ar_number"),
        "intensity": cand.get("intensity"),
        "intensity_label": cand.get("intensity_label"),
        "on_disk": cand.get("on_disk"),  # FE only: drives 193 (disk) vs 304 (limb)
        "frm_name": cand.get("frm_name"),
        "fallback": False,
    }


def _noon_fallback_event(date_str: str, label_prefix: str = "Noon UTC") -> Dict[str, Any]:
    """Event-shaped fallback tile used when HEK is empty / errored.

    Lets the frontend render the same tile component for the fallback as for
    real events — no special "empty" path. Front-end then composes a 4-tile
    grid of [fallback] + [custom-time picker].
    """
    return {
        "rank": 1,
        "rank_label": label_prefix,
        "time_utc": "12:00",
        "peak_time_iso": f"{date_str}T12:00:00",
        "event_type": "Quiet day",
        "event_code": None,
        "family": None,
        "tier": 4,
        "goes_class": None,
        "ar_number": None,
        "intensity": None,
        "intensity_label": None,
        "frm_name": None,
        "fallback": True,
    }


def _noon_fallback(date_str: str, reason: str, errors: Optional[List[str]] = None) -> Dict[str, Any]:
    # Build a single noon "event" so the events array is never empty —
    # frontend renders the same tile component for quiet/error days as for
    # real events, simplifying the loading→loaded transition.
    label_prefix = "Noon UTC" if reason == "quiet_day" else "Noon UTC (fallback)"
    noon_event = _noon_fallback_event(date_str, label_prefix=label_prefix)
    return {
        "ok": True,
        "date": date_str,
        "events": [noon_event],
        "time_utc": "12:00",
        "peak_time_iso": f"{date_str}T12:00:00",
        "event_type": "Quiet day",
        "event_code": None,
        "family": None,
        "tier": 4,
        "goes_class": None,
        "ar_number": None,
        "intensity": None,
        "intensity_label": None,
        "frm_name": None,
        "fallback": True,
        "fallback_reason": reason,
        "source": "noon fallback",
        "errors": errors or None,
    }


# ── FastAPI wiring ──────────────────────────────────────────────────────────

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def register_hek_routes(app: FastAPI, cache_root: Path) -> None:
    """Mount the HEK route on the given FastAPI app.

    `cache_root` is the persistent default-cache dir (lives on /var/data on
    Render). Per-date JSON files land under `<cache_root>/hek/`.
    """

    @app.get("/api/hek/best_time")
    async def best_time(
        date: str = Query(..., description="UTC date YYYY-MM-DD"),
        refresh: int = Query(0, description="Set 1 to bypass the per-date cache."),
    ):
        if not _DATE_RE.match(date):
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
        # Sanity-check the date is real (e.g. reject 2014-02-30).
        try:
            datetime.strptime(date, "%Y-%m-%d")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"invalid date: {e}")

        if not refresh:
            cached = _read_cache(cache_root, date)
            if cached is not None:
                cached = dict(cached)
                cached["cached"] = True
                return cached

        import asyncio
        try:
            payload = await asyncio.to_thread(_query_hek, date)
        except Exception as e:
            # Don't bubble — give the frontend a usable noon fallback so the
            # date picker still progresses.
            payload = _noon_fallback(date, reason=f"hek_error: {type(e).__name__}: {e}")

        _write_cache(cache_root, date, payload)
        payload = dict(payload)
        payload["cached"] = False
        return payload
