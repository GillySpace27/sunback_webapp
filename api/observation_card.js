/* ===============================================================
   Solar Archive: the observation card (MH-19)

   Provenance you can see: what the visitor's preview actually is, stated
   from facts the page already holds. Honest by construction:
     - the time is the FITS DATE-OBS when the preview endpoint reported it
       (obs_time_utc), otherwise the time REQUESTED, labelled as such;
     - Enhanced is RHEF output, a visualization, not a calibrated radiance.

   Pure functions, no DOM: tested by api/scripts/test_observation_card.mjs.
   =============================================================== */

// Same wording as web3d/src/data/wavelengths.ts ("sees"); the drift check
// api/scripts/test_wavelength_drift.py-style comparison lives in the test.
export var WAVELENGTH_GLOSSES = {
  94: "Flaring, ultra-hot corona",
  131: "Flares, hottest plasma",
  171: "Coronal loops, quiet Sun",
  193: "Corona and coronal holes",
  211: "Active-region corona",
  304: "Chromosphere and prominences",
  335: "Hot active regions",
  1600: "Transition region, photosphere"
};

export var RHEF_CITE = "Gilly & Cranmer 2025, Sol. Phys. 300, 174";

// look: the editor filter ("raw", "rhef", "hq_rhef", or a jpg-tier name).
export function processingText(look) {
  if (look === "rhef" || look === "hq_rhef") {
    return "Enhanced: RHEF (" + RHEF_CITE + "), a visualization, not a calibrated radiance";
  }
  return "Original: the observation as the archive holds it, colored for display";
}

// [label, value] rows for the card. Unknown inputs are left out, never guessed.
export function observationRows(f) {
  f = f || {};
  var rows = [["Instrument", "SDO / AIA (NASA)"]];
  var wl = parseInt(f.wavelength, 10);
  if (wl) {
    var gloss = WAVELENGTH_GLOSSES[wl];
    rows.push(["Wavelength", wl + " Å" + (gloss ? ": " + gloss : "")]);
  }
  if (f.observed && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(f.observed)) {
    // The FITS DATE-OBS of the frame the archive returned.
    rows.push(["Observed", f.observed.replace("T", " ").replace("Z", " UT")]);
  } else if (f.date) {
    rows.push(["Requested", f.date + (f.time ? " " + f.time + " UT" : "") +
      " (nearest available frame)"]);
  }
  rows.push(["Processing", processingText(f.look)]);
  return rows;
}

// Accessible name for the preview canvas.
export function canvasLabel(f) {
  f = f || {};
  var wl = parseInt(f.wavelength, 10);
  var parts = ["Solar image"];
  if (f.date) parts.push("from " + f.date + (f.time ? " " + f.time + " UT" : ""));
  if (wl) parts.push(wl + " Angstrom" + (WAVELENGTH_GLOSSES[wl] ? ", " + WAVELENGTH_GLOSSES[wl].toLowerCase() : ""));
  parts.push(f.look === "rhef" || f.look === "hq_rhef" ? "Enhanced with RHEF" : "Original");
  return parts.join(", ");
}

// Link to the 1200x1600 certificate for this observation, or "" when the
// date or wavelength is unknown.
export function certificateHref(f) {
  f = f || {};
  var wl = parseInt(f.wavelength, 10);
  if (!wl || !/^\d{4}-\d{2}-\d{2}$/.test(f.date || "")) return "";
  var q = "d=" + encodeURIComponent(f.date) + "&wl=" + wl;
  if (/^\d{2}:\d{2}$/.test(f.time || "")) q += "&t=" + encodeURIComponent(f.time);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(f.observed || "")) q += "&obs=" + encodeURIComponent(f.observed);
  return "/api/certificate?" + q;
}

// Fills `el` (a container) with a definition list using textContent only.
export function renderObservationCard(el, f) {
  if (!el) return;
  var doc = el.ownerDocument;
  while (el.firstChild) el.removeChild(el.firstChild);
  var h = doc.createElement("h3");
  h.className = "observation-card-title";
  h.textContent = "About this observation";
  var dl = doc.createElement("dl");
  observationRows(f).forEach(function (r) {
    var dt = doc.createElement("dt"); dt.textContent = r[0];
    var dd = doc.createElement("dd"); dd.textContent = r[1];
    dl.appendChild(dt); dl.appendChild(dd);
  });
  el.appendChild(h); el.appendChild(dl);
  var href = certificateHref(f);
  if (href) {
    var a = doc.createElement("a");
    a.className = "observation-card-cert";
    a.href = href;
    a.setAttribute("download", "");
    a.textContent = "Download certificate (PNG)";
    el.appendChild(a);
  }
  el.hidden = false;
}

// SU-18: the HelioSoftware provenance object (spec/provenance.md, version 1,
// gilly.space PR #43). Flat string-or-null fields about the picture, never
// about the person. `rhef` is the RHEF stamp line byte for byte and is only
// set when the caller has it (the store does not compute it client-side), so
// an RHEF-tier export without a stamp says null rather than inventing one.
// `citation` stays null until Gilly sets the wording in attribution.json.
export var SPEC_CREDIT = "Imagery courtesy of NASA/SDO and the AIA science team.";
export var SPEC_DISCLAIMER = "RHEF output is a visualization, not a calibrated radiance.";

export function helioProvenance(o) {
  o = o || {};
  var wl = parseInt(o.wavelength, 10);
  var observed = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(o.dateStr || "")) {
    var t = /^\d{2}:\d{2}$/.test(o.timeStr || "") ? o.timeStr : "00:00";
    observed = o.dateStr + "T" + t + ":00Z";
  }
  var rhefTier = o.editorFilter === "rhef" || o.editorFilter === "hq_rhef";
  var p = {
    product: "my-heliogram",
    version: o.version || "unknown",
    instrument: wl ? "SDO/AIA " + wl : "unknown",
    observed: observed,
    credit: SPEC_CREDIT,
    rhef: o.rhefStamp || null,
    citation: null
  };
  if (rhefTier) p.disclaimer = SPEC_DISCLAIMER;
  return p;
}
