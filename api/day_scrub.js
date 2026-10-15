/* ===============================================================
   Solar Archive: ranked events as ticks on the day scrubber (MH-17)

   The fine-tune tile's "Or scan the day" range input runs 0 to 23 UTC.
   These helpers turn the /api/hek/best_time events into tick marks along
   that track. They are the RANKED picks best_time returns (_pick_top_n,
   at most three), not every event of the day, and the label says so.
   Fallback tiles (a quiet day, a failed lookup) get no tick: there is no
   event to mark.

   Pure functions, no DOM: tested by api/scripts/test_day_scrub.mjs.
   =============================================================== */

export var SCRUB_MAX_HOUR = 23;

// "21:41" -> minutes after midnight, or null.
export function minutesOf(hhmm) {
  var m = /^(\d{2}):(\d{2})/.exec(String(hhmm || ""));
  if (!m) return null;
  var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Plain words for a tick's tooltip: what, how strong, when.
export function tickTitle(ev) {
  var what = ev.event_type || "Event";
  var strength = ev.goes_class ? ("GOES " + ev.goes_class + " class")
    : (ev.intensity_label || (ev.ar_number ? ("NOAA AR " + ev.ar_number) : ""));
  return (ev.rank_label ? ev.rank_label + ": " : "") + what +
    (strength ? ", " + strength : "") + ", " + ev.time_utc + " UTC (ranked event)";
}

// One tick per real event with a usable time: where it sits along the
// 0..23 track (percent, clamped, so 23:30 lands at the end), the hour the
// scrubber snaps to, the rank, and the tooltip.
export function eventTicks(events) {
  return (events || []).filter(function (ev) {
    return ev && !ev.fallback && minutesOf(ev.time_utc) !== null;
  }).map(function (ev) {
    var min = minutesOf(ev.time_utc);
    var pct = Math.min(100, (min / 60) / SCRUB_MAX_HOUR * 100);
    return {
      rank: ev.rank,
      hour: Math.floor(min / 60),
      pct: Math.round(pct * 10) / 10,
      title: tickTitle(ev),
    };
  });
}
