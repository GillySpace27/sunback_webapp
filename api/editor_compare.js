/* ===============================================================
   Solar Archive: the editor's drag comparison (MH-11)

   The editor canvas gains the same before/after wipe the landing showcase
   and the handoff bridge already use (_wireCompareSliderEl). Two modes:

     "look"   Original on the left, Enhanced on the right, both rendered
              through renderCanvas at the buyer's crop, colour edits,
              vignette and text, exactly as the print file is drawn.
     "newest" The buyer's day on the left and the newest printable day on
              the right, both in the Original look, so the comparison is
              between two days and not between two looks.

   Neither half ever goes through a CSS filter (#vibeRawGamma): the Original
   half is the pixels that print.

   Pure functions, no DOM: tested by api/scripts/test_editor_compare.mjs.
   =============================================================== */

// Which editor tier stands for each buyer word. Enhanced is the full
// resolution render when it has landed, else the preview render; never the
// Original tier standing in for a missing Enhanced one.
export function lookFilters(isReady) {
  var enhanced = isReady("hq_rhef") ? "hq_rhef" : (isReady("rhef") ? "rhef" : null);
  return { original: isReady("raw") ? "raw" : null, enhanced: enhanced };
}

// The newest printable day comes only from /api/data_frontier (never from
// today's date). Noon UT, the same anchor as every other fetch path; the
// 512 px frame at image_scale=12 covers the same 3000 arcsec as the
// editor's fast first paint, so renderCanvas co-registers it with the
// buyer's own frame.
export function newestDayThumbUrl(apiBase, frontier, wavelength) {
  if (!frontier || !/^\d{4}-\d{2}-\d{2}$/.test(String(frontier.latest || ""))) return null;
  var wl = parseInt(wavelength, 10);
  if (!wl) return null;
  return (apiBase || "") + "/api/helioviewer_thumb?date=" +
    encodeURIComponent(frontier.latest + "T12:00:00Z") +
    "&wavelength=" + wl + "&image_scale=12&size=512";
}

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return "";
  return MONTHS[parseInt(m[2], 10) - 1] + " " + parseInt(m[3], 10) + ", " + m[1];
}

// Corner labels and the slider's spoken value for each mode. Buyer words
// are Original and Enhanced only.
export function compareLabels(mode, yourDate, frontier) {
  if (mode === "newest") {
    var yours = shortDate(yourDate) || "Your day";
    var newest = shortDate(frontier && frontier.latest) || "Newest day";
    return { left: yours, right: newest, leftWord: yours, rightWord: newest };
  }
  return { left: "Original", right: "Enhanced", leftWord: "original", rightWord: "enhanced" };
}
