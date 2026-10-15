/* ===============================================================
   Solar Archive: the observation card (MH-19)

   Provenance you can see: what the visitor's preview actually is, stated
   from facts the page already holds. Honest by construction:
     - the time is the time REQUESTED; the FITS observation time is not
       carried to the client yet, so the card says so rather than guess;
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
  if (f.date) {
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
  el.hidden = false;
}
