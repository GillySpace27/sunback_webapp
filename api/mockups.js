/* ===============================================================
   Solar Archive — product mockup drawing

   Step 4/N of the IIFE → ES-modules refactor. This is the big
   slice: drawProductMockup with all its per-product branches plus
   the helpers it depends on (canvas snapshot, crop viewport,
   edited-shared-source, per-product framing constants, effective
   aspect ratio).

   Two cross-module dependencies don't fit the import model
   cleanly:
     • solarCanvas — the editor DOM element, owned by
       solar-archive.js's startup code.
     • renderCanvas — a giant editor function that lives in
       solar-archive.js and would create an import cycle if
       imported back here.
   Both are injected once at startup via `initMockups({ … })`.
   The mockup module stores them in a module-private `_deps`
   object and reads through that.

   All function bodies are copied verbatim from the IIFE-era
   solar-archive.js (with `solarCanvas` → `_deps.solarCanvas`
   and `renderCanvas()` → `_deps.renderCanvas()` rewrites). Zero
   behavioural change intended.
   =============================================================== */

import { state } from "./state.js";
import { PRODUCTS } from "./products.js";
import { variantColorOption } from "./colors.js";

// Injected once at startup. Object-with-mutable-fields rather than
// individual setters so future deps (additional DOM refs, additional
// callbacks) only need a key here + an entry in initMockups's caller.
const _deps = {
  solarCanvas: null,
  renderCanvas: () => {},
};

export function initMockups(deps) {
  Object.assign(_deps, deps);
}

// Roman numeral labels for the wall-clock face. Inlined here because
// drawProductMockup's wall_clock branch (line ~697 in this module)
// reads `ROMAN_NUMERALS[nh]` when state.clockNumbers.style === "roman",
// and ES-module scoping means the `var ROMAN_NUMERALS` in
// solar-archive.js is not visible across the module boundary —
// without this declaration, picking the wall clock + roman numerals
// throws `ReferenceError: ROMAN_NUMERALS is not defined` and the
// product preview aborts mid-paint. Kept identical to the editor's
// own ROMAN_NUMERALS list (solar-archive.js:6472) so the two
// consumers can't drift.
const ROMAN_NUMERALS = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

    var PRODUCT_PREVIEW_VIEW = {
      // Square wall art — vary zoom/offset so each card looks different
      canvas_stretched:    { zoom: 1.00, cx: 0.50, cy: 0.50 },
      metal_sign:          { zoom: 1.08, cx: 0.52, cy: 0.48 },
      acrylic_print:       { zoom: 0.92, cx: 0.48, cy: 0.52 },
      tapestry:            { zoom: 0.85, cx: 0.50, cy: 0.50 },
      wall_clock:          { zoom: 1.00, cx: 0.50, cy: 0.50 },
      // Posters (11:14 portrait)
      poster_matte:        { zoom: 0.95, cx: 0.50, cy: 0.48 },
      framed_poster:       { zoom: 0.88, cx: 0.50, cy: 0.52 },
      // Drinkware (2:1 unwrap)
      mug_15oz:            { zoom: 0.80, cx: 0.50, cy: 0.50 },
      mug_15oz_black:      { zoom: 0.92, cx: 0.54, cy: 0.50 },
      tumbler_20oz:        { zoom: 0.88, cx: 0.46, cy: 0.50 },
      // Apparel — tighter detail crop (this is what prints on the chest panel)
      tshirt_unisex:       { zoom: 1.25, cx: 0.50, cy: 0.48 },
      hoodie_pullover:     { zoom: 1.20, cx: 0.52, cy: 0.50 },
      crewneck_sweatshirt: { zoom: 1.15, cx: 0.48, cy: 0.50 },
      // Tech / desk
      phone_case:          { zoom: 1.35, cx: 0.50, cy: 0.50 },
      laptop_sleeve:       { zoom: 0.90, cx: 0.50, cy: 0.50 },
      mouse_pad:           { zoom: 0.95, cx: 0.50, cy: 0.50 },
      desk_mat:            { zoom: 0.82, cx: 0.50, cy: 0.50 },
      // Home & living
      throw_pillow:        { zoom: 1.10, cx: 0.50, cy: 0.50 },
      sherpa_blanket:      { zoom: 0.80, cx: 0.50, cy: 0.50 },
      shower_curtain:      { zoom: 0.88, cx: 0.50, cy: 0.52 },
      puzzle_1000:         { zoom: 1.00, cx: 0.50, cy: 0.50 },
      coaster_set:         { zoom: 1.20, cx: 0.50, cy: 0.50 },
      // Accessories
      sticker_kiss:        { zoom: 1.50, cx: 0.50, cy: 0.50 },
      journal_hardcover:   { zoom: 0.95, cx: 0.52, cy: 0.50 },
      backpack:            { zoom: 1.05, cx: 0.50, cy: 0.50 },
      crew_socks:          { zoom: 1.15, cx: 0.50, cy: 0.50 },
    };

    // ── Clean canvas snapshot (no editor overlays) ──────────────
    // _deps.solarCanvas is drawn with an orange frame border + optional guide lines
    // so the editor can show where the printable edge is. Those are editing
    // aids — they must not leak into product mockups or the upload payload.
    // This helper renders the canvas once with _burningCanvas=true (which
    // skips the overlay branch in renderCanvas), copies the result to an
    // offscreen canvas, restores visible state, and returns the snapshot.
    var _cleanSnapshotCanvas = null;
    var _cleanSnapshotSig = null;
    function _currentCanvasSig() {
      // Rebuild the snapshot only when something observable to a mockup has
      // actually changed. Signature covers size, filter, background, geometry,
      // and active text overlay. Over-invalidating is cheap; under-invalidating
      // would show stale art.
      var t = state.textOverlay;
      return [
        _deps.solarCanvas ? _deps.solarCanvas.width : 0,
        _deps.solarCanvas ? _deps.solarCanvas.height : 0,
        state.editorFilter || "",
        state.vignetteFade || "",
        state.rotation || 0,
        state.flipH ? 1 : 0,
        state.flipV ? 1 : 0,
        state.panX || 0,
        state.panY || 0,
        state.cropZoom || 0,
        state.vignette || 0,
        state.vignetteWidth || 0,
        state.cropEdgeFeatherX || 0,
        state.cropEdgeFeatherY || 0,
        state.brightness || 0,
        state.contrast || 0,
        state.saturation || 100,
        state.hue || 0,
        // Timestamp caption: changing the toggle, the position, the
        // offset, the date, or the wavelength all change what's burned
        // into the snapshot.
        state.timestampStamp ? 1 : 0,
        state.timestampPos || "",
        state.timestampVOffset || 0,
        (document.getElementById("solarDate") && document.getElementById("solarDate").value) || "",
        state.wavelength || 0,
        t ? (t.text + "|" + t.x + "|" + t.y + "|" + t.size + "|" + t.color + "|" + (t.rotation || 0)) : ""
      ].join(":");
    }
    function getCleanCanvasSnapshot() {
      if (!_deps.solarCanvas || _deps.solarCanvas.width === 0) return _deps.solarCanvas;
      var sig = _currentCanvasSig();
      if (_cleanSnapshotCanvas && _cleanSnapshotSig === sig
          && _cleanSnapshotCanvas.width === _deps.solarCanvas.width
          && _cleanSnapshotCanvas.height === _deps.solarCanvas.height) {
        return _cleanSnapshotCanvas;
      }
      var wasBurning = state._burningCanvas;
      state._burningCanvas = true;
      try { _deps.renderCanvas(); } catch (_e) {}
      if (!_cleanSnapshotCanvas) _cleanSnapshotCanvas = document.createElement("canvas");
      _cleanSnapshotCanvas.width = _deps.solarCanvas.width;
      _cleanSnapshotCanvas.height = _deps.solarCanvas.height;
      var cctx = _cleanSnapshotCanvas.getContext("2d");
      cctx.clearRect(0, 0, _cleanSnapshotCanvas.width, _cleanSnapshotCanvas.height);
      cctx.drawImage(_deps.solarCanvas, 0, 0);
      state._burningCanvas = wasBurning || false;
      try { _deps.renderCanvas(); } catch (_e) {}
      _cleanSnapshotSig = sig;
      return _cleanSnapshotCanvas;
    }

    // ── Edited-shared-source cache for the product gallery ──────
    // Every non-selected product card in the grid used to draw from
    // state.originalImage, so colour edits (brightness / contrast /
    // saturation / hue / invert) didn't propagate beyond the
    // currently-edited card. This helper produces a canvas with those
    // adjustments baked into the source image at its natural size,
    // cached on a (filter + adjustment) signature so it only re-runs
    // when one of the adjustments changes. Positional edits (vignette,
    // crop-edge feather, timestamp / text / clock numerals) are NOT
    // applied here — those shapes depend on the selected product's
    // aspect ratio and would look wrong on cards for other products.
    var _editedSharedCanvas = null;
    var _editedSharedSig = null;
    function _editedSharedSig_fn() {
      var img = state.originalImage;
      return [
        img ? (img.src || "_") : "_",
        state.editorFilter || "",
        state.brightness || 0,
        state.contrast || 0,
        state.saturation || 100,
        state.hue || 0,
        state.inverted ? 1 : 0,
      ].join(":");
    }
    function _getEditedSharedSource() {
      var img = state.originalImage;
      if (!img || !img.naturalWidth || !img.naturalHeight) return img || null;
      // No colour edits → just return the raw image; saves a pixel
      // loop and matches the previous gallery behaviour exactly.
      var hasEdits = state.brightness !== 0 || state.contrast !== 0 ||
                     state.saturation !== 100 || (state.hue || 0) !== 0 ||
                     !!state.inverted;
      if (!hasEdits) return img;
      var sig = _editedSharedSig_fn();
      if (_editedSharedCanvas && _editedSharedSig === sig) return _editedSharedCanvas;
      try {
        if (!_editedSharedCanvas) _editedSharedCanvas = document.createElement("canvas");
        _editedSharedCanvas.width = img.naturalWidth;
        _editedSharedCanvas.height = img.naturalHeight;
        var ec = _editedSharedCanvas.getContext("2d");
        ec.clearRect(0, 0, _editedSharedCanvas.width, _editedSharedCanvas.height);
        ec.drawImage(img, 0, 0);
        var imd = ec.getImageData(0, 0, _editedSharedCanvas.width, _editedSharedCanvas.height);
        var d = imd.data;
        var br = state.brightness;
        var co = state.contrast / 100;
        var factor = (259 * (co * 255 + 255)) / (255 * (259 - co * 255));
        var sat = state.saturation / 100;
        var hueDeg = state.hue || 0;
        var applyHue = (hueDeg % 360) !== 0;
        var hc = applyHue ? Math.cos(hueDeg * Math.PI / 180) : 1;
        var hs = applyHue ? Math.sin(hueDeg * Math.PI / 180) : 0;
        // Same YIQ-derived rotation matrix as renderCanvas / _cropFilterImage.
        var hrr = 0.213 + 0.787 * hc - 0.213 * hs;
        var hrg = 0.715 - 0.715 * hc - 0.715 * hs;
        var hrb = 0.072 - 0.072 * hc + 0.928 * hs;
        var hgr = 0.213 - 0.213 * hc + 0.143 * hs;
        var hgg = 0.715 + 0.285 * hc + 0.140 * hs;
        var hgb = 0.072 - 0.072 * hc - 0.283 * hs;
        var hbr = 0.213 - 0.213 * hc - 0.787 * hs;
        var hbg = 0.715 - 0.715 * hc + 0.715 * hs;
        var hbb = 0.072 + 0.928 * hc + 0.072 * hs;
        for (var i = 0; i < d.length; i += 4) {
          var r = d[i], g = d[i + 1], b = d[i + 2];
          if (state.inverted) { r = 255 - r; g = 255 - g; b = 255 - b; }
          r += br; g += br; b += br;
          r = factor * (r - 128) + 128;
          g = factor * (g - 128) + 128;
          b = factor * (b - 128) + 128;
          var gy = 0.2989 * r + 0.587 * g + 0.114 * b;
          r = gy + sat * (r - gy);
          g = gy + sat * (g - gy);
          b = gy + sat * (b - gy);
          if (applyHue) {
            var hr = hrr * r + hrg * g + hrb * b;
            var hg = hgr * r + hgg * g + hgb * b;
            var hb = hbr * r + hbg * g + hbb * b;
            r = hr; g = hg; b = hb;
          }
          d[i]     = Math.max(0, Math.min(255, r));
          d[i + 1] = Math.max(0, Math.min(255, g));
          d[i + 2] = Math.max(0, Math.min(255, b));
        }
        ec.putImageData(imd, 0, 0);
        _editedSharedSig = sig;
        return _editedSharedCanvas;
      } catch (_e) {
        return img;
      }
    }

    /**
     * Return the crop box in canvas pixel coordinates. Fixed-frame model: the canvas is the frame,
     * so the box is always the full canvas (0,0,cw,ch). Same source for preview and mockups.
     */
    function getCropBoxInCanvasCoords() {
      if (!_deps.solarCanvas) return null;
      var cw = _deps.solarCanvas.width;
      var ch = _deps.solarCanvas.height;
      if (cw === 0 || ch === 0) return null;
      return { x: 0, y: 0, w: cw, h: ch };
    }

    /**
     * Return the visible portion of _deps.solarCanvas for product mockups (same as crop box).
     * Returns { sx, sy, sw, sh } in canvas pixel coordinates.
     */
    function _getCropViewport() {
      var box = getCropBoxInCanvasCoords();
      if (!box) {
        var cw = _deps.solarCanvas ? _deps.solarCanvas.width : 0;
        var ch = _deps.solarCanvas ? _deps.solarCanvas.height : 0;
        return { sx: 0, sy: 0, sw: cw, sh: ch };
      }
      return { sx: box.x, sy: box.y, sw: box.w, sh: box.h };
    }

    /**
     * Fit a rectangle of aspect ratio `ar` inside `maxW × maxH` so the print
     * area in the live preview mockup matches the editor canvas's effective
     * aspect ratio. Without this, square-hardcoded mockup print rects (e.g.
     * canvas/metal/acrylic) letterbox or crop the editor view differently
     * from the canvas itself, which beta testers flagged as confusing.
     * Moved here from solar-archive.js during step 4 of the module split
     * — only drawProductMockup's per-product branches call it.
     */
    function _fitPrintRectToAR(maxW, maxH, ar) {
      if (!ar || !ar.w || !ar.h) return { w: maxW, h: maxH };
      var R = ar.w / ar.h;
      var w, h;
      if (R >= maxW / maxH) { w = maxW; h = maxW / R; }
      else                  { h = maxH; w = maxH * R; }
      return { w: Math.round(w), h: Math.round(h) };
    }

    function drawProductMockup(mctx, productId, sw, sh, variant, opts) {
      var W = 160, H = 160;
      mctx.fillStyle = "#1a1a2e";
      mctx.fillRect(0, 0, W, H);

      // Source routing: the currently-edited product mirrors the live editor
      // canvas (so the user sees their edits); every other product in the
      // gallery pulls from a *colour-edited* copy of state.originalImage so
      // brightness / contrast / saturation / hue / invert propagate to the
      // full gallery too. Positional edits (vignette, crop-edge feather,
      // timestamp, text, clock numerals) stay tied to the selected product's
      // preview — their geometry depends on its aspect ratio.
      // opts.useSelectedSource: callers like the pre-editor variant picker
      // open BEFORE state.selectedProduct is committed but still want the
      // high-quality _deps.solarCanvas path (which reflects state.editorFilter →
      // HQ RHEF when promoted). Without this flag the picker would fall
      // through to the JPG-backed _getEditedSharedSource path and show a
      // visibly softer preview than the showcase tile right next to it.
      var forceSelected = !!(opts && opts.useSelectedSource);
      var isSelected = forceSelected || (productId === state.selectedProduct);
      var sourceCanvas = null;
      var shareSrc = null;
      if (isSelected) {
        sourceCanvas = (typeof getCleanCanvasSnapshot === "function")
          ? getCleanCanvasSnapshot()
          : _deps.solarCanvas;
      } else {
        shareSrc = (typeof _getEditedSharedSource === "function")
          ? _getEditedSharedSource()
          : state.originalImage;
      }
      // opts.fallbackSrc: when neither sourceCanvas nor shareSrc has
      // a usable image (cold-load pre-image-pick — variant picker
      // opens BEFORE the user has chosen a vibe), let the caller pass
      // an Image to use as the source. Used by the variant modal to
      // render the AR 2192 default RHEF (the same image that bakes
      // into the photoreal Printify default mockup) so the modal's
      // canvas still shows a real Sun on every variant.
      var hasSource = (sourceCanvas && sourceCanvas.width > 0)
        || (shareSrc && (shareSrc.naturalWidth || shareSrc.width));
      if (!hasSource && opts && opts.fallbackSrc) {
        var fb = opts.fallbackSrc;
        if (fb && (fb.naturalWidth || fb.width)) {
          // Route through the share-src path so the per-product
          // framing + crop logic below handles it like any non-edited
          // gallery tile.
          shareSrc = fb;
          // If the caller passed both a canvas and a fallback, drop
          // the empty canvas so the shareSrc path actually runs.
          sourceCanvas = null;
        }
      }

      // Resolve the per-product preview framing (zoom + normalized center).
      // Falls back to a gentle default keyed off aspect so a new product
      // without an explicit entry still looks reasonable.
      function _previewViewFor(pid) {
        var v = PRODUCT_PREVIEW_VIEW[pid];
        if (v) return v;
        return { zoom: 1.0, cx: 0.5, cy: 0.5 };
      }

      // Compute a source rect on `shareSrc` that matches dstW:dstH with the
      // product's preview framing applied. Returns null if we should fall
      // through to letterboxing.
      function _sharedSrcRect(dstW, dstH) {
        if (!shareSrc || !shareSrc.naturalWidth) return null;
        var iw = shareSrc.naturalWidth;
        var ih = shareSrc.naturalHeight;
        var view = _previewViewFor(productId);
        var zoom = Math.max(0.3, Math.min(3.0, view.zoom || 1.0));
        // Start by fitting the destination aspect inside the source, then
        // divide by zoom to get the visible source region.
        var dstAR = dstW / dstH;
        var srcAR = iw / ih;
        var vw, vh;
        if (dstAR >= srcAR) {
          // dst is wider than src — fit width, crop vertically
          vw = iw / zoom;
          vh = vw / dstAR;
        } else {
          vh = ih / zoom;
          vw = vh * dstAR;
        }
        // Clamp the viewport to source bounds. When a zoom<1 and a wide/tall
        // destination aspect push vw or vh past iw/ih, drawImage silently
        // renders transparency in the out-of-bounds portion, leaving a blank
        // strip on the mockup (beta reported this on the mug unwrap). Shrink
        // both dimensions proportionally so dstAR is preserved and the image
        // fully fills the destination — the effective zoom is just capped.
        var scale = Math.min(1, iw / vw, ih / vh);
        vw *= scale;
        vh *= scale;
        var cx = (view.cx != null ? view.cx : 0.5) * iw;
        var cy = (view.cy != null ? view.cy : 0.5) * ih;
        var sx = Math.max(0, Math.min(iw - vw, cx - vw / 2));
        var sy = Math.max(0, Math.min(ih - vh, cy - vh / 2));
        return { sx: sx, sy: sy, sw: vw, sh: vh };
      }

      // Helper: draw the same crop viewport as main canvas and preview (no extra crop).
      // Letterbox so the crop content is never stretched — identical behavior to preview pane.
      function drawCropped(dstX, dstY, dstW, dstH) {
        if (shareSrc) {
          // Fast path for gallery cards: draw straight from the shared raw
          // image using this product's previewView, no editor-state plumbing.
          var r = _sharedSrcRect(dstW, dstH);
          if (!r) return;
          mctx.drawImage(shareSrc, r.sx, r.sy, r.sw, r.sh, dstX, dstY, dstW, dstH);
          return;
        }
        var vp = _getCropViewport();
        if (!vp || vp.sw < 1 || vp.sh < 1) return;
        var vpRatio = vp.sw / vp.sh;
        var drawW, drawH;
        if (vpRatio >= dstW / dstH) {
          drawW = dstW;
          drawH = dstW / vpRatio;
        } else {
          drawH = dstH;
          drawW = dstH * vpRatio;
        }
        var dx = dstX + (dstW - drawW) / 2;
        var dy = dstY + (dstH - drawH) / 2;
        mctx.drawImage(sourceCanvas, vp.sx, vp.sy, vp.sw, vp.sh, dx, dy, drawW, drawH);
      }

      // Helper: cover-fit the source into dst (crop source to dst aspect, fill
      // edge-to-edge, no letterboxing, no horizontal/vertical distortion).
      // Used for mug/tumbler unwraps where the 2:1 printable area must fill
      // completely and the sun must stay circular.
      function drawStretched(dstX, dstY, dstW, dstH) {
        if (shareSrc) {
          // Shared-source path already returns a rect matching dstAR — draw
          // it 1:1 into dst so it fills without distortion.
          var r = _sharedSrcRect(dstW, dstH);
          if (!r) return;
          mctx.drawImage(shareSrc, r.sx, r.sy, r.sw, r.sh, dstX, dstY, dstW, dstH);
          return;
        }
        // Selected-product (live canvas) path: center-crop the viewport to
        // the destination aspect, then draw the crop 1:1 into dst. Without
        // this crop, a square canvas stretched into a 2:1 dst would distort
        // the sun into a horizontal ellipse — beta testers flagged this.
        var vp = _getCropViewport();
        if (!vp || vp.sw < 1 || vp.sh < 1) return;
        var dstAR = dstW / dstH;
        var vpAR = vp.sw / vp.sh;
        var sx = vp.sx, sy = vp.sy, sw = vp.sw, sh = vp.sh;
        if (vpAR > dstAR) {
          sw = vp.sh * dstAR;
          sx = vp.sx + (vp.sw - sw) / 2;
        } else if (vpAR < dstAR) {
          sh = vp.sw / dstAR;
          sy = vp.sy + (vp.sh - sh) / 2;
        }
        mctx.drawImage(sourceCanvas, sx, sy, sw, sh, dstX, dstY, dstW, dstH);
      }

      if (productId === "mug_15oz" || productId === "mug_15oz_black" || productId === "tumbler_20oz") {
        // Unwrapped drinkware view — the printable strip laid flat. The body
        // rect is sized to the variant's effective aspect ratio so the strip
        // here reads identically to what the editor canvas (and the real
        // Printify mockup) shows — beta tester noted the tumbler card looked
        // visibly different from its editor preview because the body was
        // hardcoded to ~1.7:1 while the actual print area is 2:1.
        var isTumbler = (productId === "tumbler_20oz");
        var _muProd = PRODUCTS.find(function(p){ return p.id === productId; });
        var _muAR = _muProd ? getEffectiveAspectRatio(_muProd) : { w: 2, h: 1 };
        // Mugs leave room on each side for the dashed handles; tumblers don't.
        var _muMaxW = isTumbler ? 130 : 116;
        var _muMaxH = 66;
        var _muFit = _fitPrintRectToAR(_muMaxW, _muMaxH, _muAR || { w: 2, h: 1 });
        var bodyW = _muFit.w;
        var bodyH = _muFit.h;
        var bodyL = Math.round((W - bodyW) / 2);
        var bodyT = Math.round(85 - bodyH / 2);
        var bodyR = bodyL + bodyW;
        var bodyB = bodyT + bodyH;

        mctx.save();
        mctx.beginPath();
        mctx.moveTo(bodyL + 3, bodyT);
        mctx.lineTo(bodyR - 3, bodyT);
        mctx.quadraticCurveTo(bodyR, bodyT, bodyR, bodyT + 3);
        mctx.lineTo(bodyR, bodyB - 3);
        mctx.quadraticCurveTo(bodyR, bodyB, bodyR - 3, bodyB);
        mctx.lineTo(bodyL + 3, bodyB);
        mctx.quadraticCurveTo(bodyL, bodyB, bodyL, bodyB - 3);
        mctx.lineTo(bodyL, bodyT + 3);
        mctx.quadraticCurveTo(bodyL, bodyT, bodyL + 3, bodyT);
        mctx.closePath();
        mctx.clip();
        drawStretched(bodyL, bodyT, bodyW, bodyH);
        mctx.restore();

        // Body outline (subtle so the strip reads as a physical object)
        mctx.strokeStyle = "rgba(255,255,255,0.18)";
        mctx.lineWidth = 1;
        mctx.strokeRect(bodyL, bodyT, bodyW, bodyH);

        // Handles: dashed marker on BOTH sides of the mug body to convey
        // "this is where the wrap seams behind the handle." Tumblers have no
        // handle so they render as a plain strip.
        if (!isTumbler) {
          mctx.strokeStyle = "#aaa";
          mctx.lineWidth = 3;
          mctx.setLineDash([3, 3]);
          var handleMidY = (bodyT + bodyB) / 2;
          var handleTop = bodyT + 10;
          var handleBot = bodyB - 10;
          mctx.beginPath();
          mctx.moveTo(bodyR, handleTop);
          mctx.quadraticCurveTo(bodyR + 16, handleTop, bodyR + 16, handleMidY);
          mctx.quadraticCurveTo(bodyR + 16, handleBot, bodyR, handleBot);
          mctx.stroke();
          mctx.beginPath();
          mctx.moveTo(bodyL, handleTop);
          mctx.quadraticCurveTo(bodyL - 16, handleTop, bodyL - 16, handleMidY);
          mctx.quadraticCurveTo(bodyL - 16, handleBot, bodyL, handleBot);
          mctx.stroke();
          mctx.setLineDash([]);
        }

        // Rim highlight (subtle top stroke)
        mctx.strokeStyle = "rgba(255,255,255,0.35)";
        mctx.lineWidth = 1.5;
        mctx.beginPath();
        mctx.moveTo(bodyL + 2, bodyT);
        mctx.lineTo(bodyR - 2, bodyT);
        mctx.stroke();

        // "Unwrapped view" tag so the representation is clear
        mctx.fillStyle = "rgba(255,255,255,0.55)";
        mctx.font = "8px system-ui, sans-serif";
        mctx.textAlign = "center";
        mctx.fillText("unwrapped view", W / 2, bodyB + 12);
        mctx.textAlign = "start";
      } else if (productId === "desk_mat") {
        // Desk mat — wide flat rectangle. Match the editor's effective AR so
        // the preview crop matches what the editor canvas shows.
        var _dmProd = PRODUCTS.find(function(p){ return p.id === productId; });
        var _dmAR = _dmProd ? getEffectiveAspectRatio(_dmProd) : { w: 2, h: 1 };
        var _dmFit = _fitPrintRectToAR(150, 90, _dmAR || { w: 2, h: 1 });
        var dmCx = W / 2, dmCy = 80;
        var dmL = Math.round(dmCx - _dmFit.w / 2);
        var dmT = Math.round(dmCy - _dmFit.h / 2);
        var dmR = dmL + _dmFit.w;
        var dmB = dmT + _dmFit.h;
        mctx.save();
        mctx.beginPath();
        mctx.moveTo(dmL, dmT + 3);
        mctx.quadraticCurveTo(dmL, dmT, dmL + 3, dmT);
        mctx.lineTo(dmR - 3, dmT);
        mctx.quadraticCurveTo(dmR, dmT, dmR, dmT + 3);
        mctx.lineTo(dmR, dmB - 3);
        mctx.quadraticCurveTo(dmR, dmB, dmR - 3, dmB);
        mctx.lineTo(dmL + 3, dmB);
        mctx.quadraticCurveTo(dmL, dmB, dmL, dmB - 3);
        mctx.closePath();
        mctx.clip();
        drawCropped(dmL, dmT, dmR - dmL, dmB - dmT);
        mctx.restore();
        mctx.strokeStyle = "rgba(255,255,255,0.18)";
        mctx.lineWidth = 1;
        mctx.strokeRect(dmL, dmT, dmR - dmL, dmB - dmT);
      } else if (productId === "tshirt_unisex" || productId === "hoodie_pullover" || productId === "crewneck_sweatshirt") {
        // Apparel silhouette with image on chest (1:1 print area).
        // Tinted from the variant's colour option when we can resolve
        // one; falls back to the previous neutral grey so the silhouette
        // still reads as fabric for variants we don't have a hex for.
        var apparelFallback = productId === "tshirt_unisex" ? "#e8e8e8" : "#d0d0d0";
        var apparelTint = variantColorOption(variant);
        mctx.fillStyle = apparelTint ? apparelTint.hex : apparelFallback;
        mctx.beginPath();
        mctx.moveTo(60, 18);
        mctx.quadraticCurveTo(80, 28, 100, 18);
        mctx.lineTo(130, 30);
        mctx.lineTo(155, 55);
        mctx.lineTo(130, 60);
        mctx.lineTo(128, 145);
        mctx.lineTo(32, 145);
        mctx.lineTo(30, 60);
        mctx.lineTo(5, 55);
        mctx.lineTo(30, 30);
        mctx.closePath();
        mctx.fill();
        if (productId === "hoodie_pullover") {
          // Kangaroo pocket — subtle shadow that reads on every base
          // colour without needing per-colour tuning.
          mctx.fillStyle = "rgba(0,0,0,0.12)";
          mctx.fillRect(52, 105, 56, 35);
        }
        mctx.save();
        mctx.beginPath();
        mctx.rect(45, 42, 70, 70);
        mctx.clip();
        drawCropped(45, 42, 70, 70);
        mctx.restore();
      } else if (productId === "poster_matte" || productId === "framed_poster") {
        // Poster — sized to the editor's effective AR so the preview crop
        // matches the editor canvas (variant flips, e.g. portrait↔landscape,
        // would otherwise leave the mockup stuck at a hardcoded 11:14 shape).
        var _pProd = PRODUCTS.find(function(p){ return p.id === productId; });
        var _pAR = _pProd ? getEffectiveAspectRatio(_pProd) : { w: 11, h: 14 };
        var _pFit = _fitPrintRectToAR(120, 140, _pAR || { w: 11, h: 14 });
        var pW = _pFit.w, pH = _pFit.h;
        var pL = Math.round((W - pW) / 2);
        var pT = Math.round((H - pH) / 2 - 5);
        mctx.fillStyle = "rgba(0,0,0,0.4)";
        mctx.fillRect(pL + 4, pT + 4, pW, pH);
        if (productId === "framed_poster") {
          // Frame reflects the selected frame-colour variant (black /
          // white / wood …) so the swatch choice is visible in the
          // preview instead of inert. Layout: coloured frame → white
          // mat → image. Falls back to a neutral dark frame when we
          // can't resolve a colour.
          var _fcol = variantColorOption(variant);
          var _frameHex = _fcol ? _fcol.hex : "#2a2a2a";
          var _mat = 7;
          mctx.fillStyle = _frameHex;
          mctx.fillRect(pL, pT, pW, pH);
          // White mat inside the frame.
          mctx.fillStyle = "#fff";
          mctx.fillRect(pL + _mat, pT + _mat, pW - 2 * _mat, pH - 2 * _mat);
          // Image inside the mat.
          drawCropped(pL + _mat + 4, pT + _mat + 4, pW - 2 * _mat - 8, pH - 2 * _mat - 8);
          // Hairline so a white/pale frame stays visible on the dark bg.
          mctx.strokeStyle = "rgba(0,0,0,0.3)";
          mctx.lineWidth = 1;
          mctx.strokeRect(pL + 0.5, pT + 0.5, pW - 1, pH - 1);
        } else {
          // Matte poster — bare white paper, no frame.
          mctx.fillStyle = "#fff";
          mctx.fillRect(pL, pT, pW, pH);
          drawCropped(pL + 5, pT + 5, pW - 10, pH - 10);
        }
      } else if (productId === "canvas_stretched" || productId === "metal_sign" || productId === "acrylic_print") {
        // Wall art — print rect matches the editor's effective AR (variant
        // dependent), so e.g. an 11×14 metal sign preview is no longer a
        // hardcoded square that crops differently from the editor.
        var _wProd = PRODUCTS.find(function(p){ return p.id === productId; });
        var _wAR = _wProd ? getEffectiveAspectRatio(_wProd) : { w: 1, h: 1 };
        var _wFit = _fitPrintRectToAR(130, 130, _wAR || { w: 1, h: 1 });
        var wW = _wFit.w, wH = _wFit.h;
        var wL = Math.round((W - wW) / 2);
        var wT = Math.round((H - wH) / 2);
        mctx.fillStyle = "rgba(0,0,0,0.35)";
        mctx.fillRect(wL + 5, wT + 5, wW, wH);
        drawCropped(wL, wT, wW, wH);
        if (productId === "canvas_stretched") {
          mctx.strokeStyle = "#444";
          mctx.lineWidth = 3;
          mctx.strokeRect(wL, wT, wW, wH);
        } else if (productId === "acrylic_print") {
          var grad = mctx.createLinearGradient(wL, wT, wL + wW, wT + wH);
          grad.addColorStop(0, "rgba(255,255,255,0.18)");
          grad.addColorStop(0.5, "rgba(255,255,255,0)");
          grad.addColorStop(1, "rgba(255,255,255,0.08)");
          mctx.fillStyle = grad;
          mctx.fillRect(wL, wT, wW, wH);
        }
      } else if (productId === "wall_clock") {
        // Round clock — 1:1 circle; rim/hand color derived from variant
        var cx = 80, cy = 80, r = 65;
        mctx.save();
        mctx.beginPath();
        mctx.arc(cx, cy, r, 0, Math.PI * 2);
        mctx.clip();
        drawCropped(cx - r, cy - r, r * 2, r * 2);
        mctx.restore();

        // Determine colors from variant — clock variants have SEPARATE
        // options.color (base/frame) and options.hands fields. The earlier
        // implementation joined all option values into one string and let a
        // single regex pick both colors, which mis-rendered combos like
        // "Wooden Base / White Hands" as wood-with-brown-hands. Parse them
        // independently so each variant previews its actual pairing.
        function _colorForToken(token, kind) {
          // kind = "frame" or "hand". Defaults bias toward neutral grays.
          if (!token) return kind === "hand" ? "#ffffff" : "#999999";
          var s = String(token).toLowerCase();
          if (/rose.?gold/.test(s))   return kind === "hand" ? "#d4848c" : "#c07880";
          if (/\bgold\b/.test(s))     return kind === "hand" ? "#d4a520" : "#c8a840";
          if (/silver/.test(s))       return kind === "hand" ? "#c8c8d0" : "#b8b8c0";
          if (/black/.test(s))        return kind === "hand" ? "#1a1a1a" : "#333333";
          if (/wood|natural|walnut|bamboo/.test(s)) return kind === "hand" ? "#3a1a04" : "#8B5E3C";
          if (/white/.test(s))        return kind === "hand" ? "#f0f0f0" : "#d8d8d8";
          return kind === "hand" ? "#ffffff" : "#999999";
        }
        var handColor = "#ffffff";
        var frameColor = "#999999";
        if (variant && variant.options) {
          // Frame: prefer options.color (Printify wall_clock convention),
          // fall back to options.frame / options.base.
          var frameToken = variant.options.color
            || variant.options.frame
            || variant.options.base
            || "";
          // Hand: options.hands is the canonical key on Printify.
          var handToken  = variant.options.hands || variant.options.hand || "";
          frameColor = _colorForToken(frameToken, "frame");
          handColor  = _colorForToken(handToken,  "hand");
        }

        // Draw rim
        mctx.strokeStyle = frameColor;
        mctx.lineWidth = 4;
        mctx.beginPath();
        mctx.arc(cx, cy, r, 0, Math.PI * 2);
        mctx.stroke();

        // Clock numbers preview — mirrors state.clockNumbers from the editor.
        // Uses the SAME fixed reference half (256) as the editor's clock
        // numbers draw so font size + stroke are always the same fraction of
        // the clock face, whether rendered on a 65-px-half mockup or a
        // 768-px-half HQ editor canvas. Beta tester noticed the previous
        // formula scaled mockup numerals against the live editor canvas
        // size, so when the editor canvas grew (HQ res bump) the mockup
        // numerals shrunk out of proportion.
        if (state.clockNumbers && state.selectedProduct === "wall_clock") {
          var cn = state.clockNumbers;
          var CLOCK_REF_HALF = 256;
          var radiusPct = (cn.radiusPct != null ? cn.radiusPct : 80) / 100;
          var numR = radiusPct * r;
          var numSize = (cn.size != null ? cn.size : 50) * (r / CLOCK_REF_HALF);
          var numStroke = (cn.strokeWidth || 0) * 2 * (r / CLOCK_REF_HALF);
          mctx.save();
          mctx.font = "bold " + numSize + "px '" + (cn.font || "Inter") + "', sans-serif";
          mctx.textAlign = "center";
          mctx.textBaseline = "middle";
          for (var nh = 1; nh <= 12; nh++) {
            var ang = nh * (Math.PI * 2 / 12);
            var nx = cx + numR * Math.sin(ang);
            var ny = cy - numR * Math.cos(ang);
            var label = (cn.style === "roman") ? ROMAN_NUMERALS[nh] : String(nh);
            if (numStroke > 0) {
              mctx.strokeStyle = cn.strokeColor || "#000";
              mctx.lineWidth = numStroke;
              mctx.lineJoin = "round";
              mctx.strokeText(label, nx, ny);
            }
            mctx.fillStyle = cn.color || "#fff";
            mctx.fillText(label, nx, ny);
          }
          mctx.restore();
        }

        // Draw clock hands (10:10 display position — classic watch ad pose)
        // Hour hand pointing to ~10 o'clock
        var hourAngle = -Math.PI / 2 + (10 / 12) * Math.PI * 2; // 10 o'clock
        var hourLen = 28;
        // Minute hand pointing to ~2 o'clock
        var minAngle = -Math.PI / 2 + (10 / 60) * Math.PI * 2; // 10 minutes past
        var minLen = 40;

        mctx.strokeStyle = handColor;
        mctx.lineCap = "round";

        // Hour hand (thick)
        mctx.lineWidth = 4;
        mctx.beginPath();
        mctx.moveTo(cx - Math.cos(hourAngle) * 10, cy - Math.sin(hourAngle) * 10);
        mctx.lineTo(cx + Math.cos(hourAngle) * hourLen, cy + Math.sin(hourAngle) * hourLen);
        mctx.stroke();

        // Minute hand (thinner, longer)
        mctx.lineWidth = 2.5;
        mctx.beginPath();
        mctx.moveTo(cx - Math.cos(minAngle) * 10, cy - Math.sin(minAngle) * 10);
        mctx.lineTo(cx + Math.cos(minAngle) * minLen, cy + Math.sin(minAngle) * minLen);
        mctx.stroke();

        // Center pin
        mctx.fillStyle = handColor;
        mctx.beginPath();
        mctx.arc(cx, cy, 4, 0, Math.PI * 2);
        mctx.fill();
        mctx.strokeStyle = frameColor;
        mctx.lineWidth = 1;
        mctx.stroke();
      } else if (productId === "mouse_pad" || (function() {
          var _circProd = PRODUCTS.find(function(p){ return p.id === productId; });
          return _circProd && _circProd.printShape === "circle" && productId !== "wall_clock";
        })()) {
        // Round-print products (mouse pad; user-requested circular-print
        // items via printShape: "circle"). wall_clock has its own block
        // above with rim/hand decorations, so it's explicitly excluded
        // here even though it shares the shape flag.
        var cR = 65, cCx = 80, cCy = 80;
        // Soft drop shadow first so the disc sits on the card surface.
        mctx.fillStyle = "rgba(0,0,0,0.22)";
        mctx.beginPath();
        mctx.arc(cCx + 3, cCy + 3, cR, 0, Math.PI * 2);
        mctx.fill();
        mctx.save();
        mctx.beginPath();
        mctx.arc(cCx, cCy, cR, 0, Math.PI * 2);
        mctx.clip();
        drawCropped(cCx - cR, cCy - cR, cR * 2, cR * 2);
        mctx.restore();
        // Faint rim so the product silhouette reads as round even
        // when the artwork itself has an opaque edge.
        mctx.strokeStyle = "rgba(0,0,0,0.18)";
        mctx.lineWidth = 1.5;
        mctx.beginPath();
        mctx.arc(cCx, cCy, cR, 0, Math.PI * 2);
        mctx.stroke();
      } else if (productId === "throw_pillow" || productId === "sherpa_blanket" ||
                 productId === "shower_curtain" || productId === "tapestry" || productId === "crew_socks") {
        // Square-ish soft-goods family. Frame geometry now follows the
        // effective AR so dualPanel products (throw_pillow in "span"
        // mode → 2:1 spread) get a wide pillow instead of a square one
        // letterboxing a stretched design. Non-dualPanel members of
        // this branch were always close to square so the AR-driven
        // sizing reduces to the original 124×124 for them.
        var _pilProd = PRODUCTS.find(function(p) { return p.id === productId; });
        var _pilAR = (_pilProd && typeof getEffectiveAspectRatio === "function")
                       ? getEffectiveAspectRatio(_pilProd)
                       : { w: 1, h: 1 };
        var pilMax = 124;
        var pilArR = _pilAR.w / _pilAR.h;
        var pilW, pilH;
        if (pilArR >= 1) {
          pilW = pilMax;
          pilH = pilW / pilArR;
        } else {
          pilH = pilMax;
          pilW = pilH * pilArR;
        }
        var pilL = (160 - pilW) / 2;
        var pilT = (160 - pilH) / 2;
        mctx.fillStyle = "rgba(0,0,0,0.2)";
        mctx.fillRect(pilL + 4, pilT + 4, pilW, pilH);
        mctx.save();
        mctx.beginPath();
        mctx.moveTo(pilL + 8, pilT);
        mctx.lineTo(pilL + pilW - 8, pilT);
        mctx.quadraticCurveTo(pilL + pilW, pilT, pilL + pilW, pilT + 8);
        mctx.lineTo(pilL + pilW, pilT + pilH - 8);
        mctx.quadraticCurveTo(pilL + pilW, pilT + pilH, pilL + pilW - 8, pilT + pilH);
        mctx.lineTo(pilL + 8, pilT + pilH);
        mctx.quadraticCurveTo(pilL, pilT + pilH, pilL, pilT + pilH - 8);
        mctx.lineTo(pilL, pilT + 8);
        mctx.quadraticCurveTo(pilL, pilT, pilL + 8, pilT);
        mctx.closePath();
        mctx.clip();
        // drawStretched (center-crop fill) instead of drawCropped: the
        // frame AR now matches the canvas AR, so the source fills with
        // no letterbox — and dualPanel "span" mode no longer shows a
        // thin band of design across a black square.
        drawStretched(pilL, pilT, pilW, pilH);
        mctx.restore();
      } else if (productId === "puzzle_1000") {
        // Square puzzle with grid overlay
        drawCropped(10, 10, 140, 140);
        mctx.strokeStyle = "rgba(255,255,255,0.25)";
        mctx.lineWidth = 1;
        for (var px = 10; px <= 150; px += 28) {
          mctx.beginPath(); mctx.moveTo(px, 10); mctx.lineTo(px, 150); mctx.stroke();
        }
        for (var py = 10; py <= 150; py += 28) {
          mctx.beginPath(); mctx.moveTo(10, py); mctx.lineTo(150, py); mctx.stroke();
        }
      } else if (productId === "phone_case") {
        // Phone 9:19 — tall portrait
        var phL = 42, phT = 8, phW = 76, phH = 144, rr = 14;
        mctx.save();
        mctx.beginPath();
        mctx.moveTo(phL + rr, phT);
        mctx.lineTo(phL + phW - rr, phT);
        mctx.quadraticCurveTo(phL + phW, phT, phL + phW, phT + rr);
        mctx.lineTo(phL + phW, phT + phH - rr);
        mctx.quadraticCurveTo(phL + phW, phT + phH, phL + phW - rr, phT + phH);
        mctx.lineTo(phL + rr, phT + phH);
        mctx.quadraticCurveTo(phL, phT + phH, phL, phT + phH - rr);
        mctx.lineTo(phL, phT + rr);
        mctx.quadraticCurveTo(phL, phT, phL + rr, phT);
        mctx.closePath();
        mctx.clip();
        drawCropped(phL, phT, phW, phH);
        mctx.restore();
        mctx.strokeStyle = "#888";
        mctx.lineWidth = 2.5;
        mctx.beginPath();
        mctx.moveTo(phL + rr, phT);
        mctx.lineTo(phL + phW - rr, phT);
        mctx.quadraticCurveTo(phL + phW, phT, phL + phW, phT + rr);
        mctx.lineTo(phL + phW, phT + phH - rr);
        mctx.quadraticCurveTo(phL + phW, phT + phH, phL + phW - rr, phT + phH);
        mctx.lineTo(phL + rr, phT + phH);
        mctx.quadraticCurveTo(phL, phT + phH, phL, phT + phH - rr);
        mctx.lineTo(phL, phT + rr);
        mctx.quadraticCurveTo(phL, phT, phL + rr, phT);
        mctx.stroke();
        mctx.fillStyle = "#222";
        mctx.beginPath();
        mctx.arc(phL + phW - 16, phT + 18, 6, 0, Math.PI * 2);
        mctx.fill();
      } else if (productId === "journal_hardcover") {
        // Hardcover journal — cover-frame geometry follows the effective
        // layout aspect, not a hard-coded landscape rectangle:
        //   • match (default) → portrait single-cover view (~15:22).
        //     Shows the front cover only; user understands "same design
        //     on both covers". No spine line — the front cover of a
        //     closed book doesn't show one.
        //   • span → landscape open-spread view (~1.43:1, back + spine
        //     + front as one continuous design). Spine bar drawn through
        //     the centre to show where the seam falls.
        // Prior version always drew a 140×120 landscape frame in BOTH
        // modes and fit-letterboxed a portrait canvas inside it, which
        // bisected the sun with a spine line + black side bars.
        var _jProd = PRODUCTS.find(function(p) { return p.id === "journal_hardcover"; });
        var _jAR = (_jProd && typeof getEffectiveAspectRatio === "function")
                     ? getEffectiveAspectRatio(_jProd)
                     : { w: 4065, h: 2850 };
        var _jMode = (state.dualPanelModeByProduct && state.dualPanelModeByProduct.journal_hardcover) || "match";
        // Fit the largest rectangle with the effective AR inside the
        // 160×160 mockup canvas (leaving 8 px of breathing room).
        var jMaxW = 144, jMaxH = 144;
        var jArR = _jAR.w / _jAR.h;
        var jW, jH;
        if (jArR >= jMaxW / jMaxH) {
          jW = jMaxW;
          jH = jW / jArR;
        } else {
          jH = jMaxH;
          jW = jH * jArR;
        }
        var jL = (160 - jW) / 2;
        var jT = (160 - jH) / 2;
        var jR = 6;
        // Drop shadow behind the cover.
        mctx.fillStyle = "rgba(0,0,0,0.3)";
        mctx.fillRect(jL + 4, jT + 4, jW, jH);
        // Spine (span mode only — closed-cover view has no spine on the face).
        if (_jMode === "span") {
          mctx.fillStyle = "#4a3728";
          mctx.fillRect(jL + jW / 2 - 3, jT, 6, jH);
        }
        // Cover image (clipped to rounded-corner cover shape).
        mctx.save();
        mctx.beginPath();
        mctx.moveTo(jL + jR, jT);
        mctx.lineTo(jL + jW - jR, jT);
        mctx.quadraticCurveTo(jL + jW, jT, jL + jW, jT + jR);
        mctx.lineTo(jL + jW, jT + jH - jR);
        mctx.quadraticCurveTo(jL + jW, jT + jH, jL + jW - jR, jT + jH);
        mctx.lineTo(jL + jR, jT + jH);
        mctx.quadraticCurveTo(jL, jT + jH, jL, jT + jH - jR);
        mctx.lineTo(jL, jT + jR);
        mctx.quadraticCurveTo(jL, jT, jL + jR, jT);
        mctx.closePath();
        mctx.clip();
        // drawStretched (center-crop fill) instead of drawCropped
        // (fit-inside letterbox). The cover-frame AR now matches the
        // editor-canvas AR, so the source fills edge-to-edge without
        // distortion — no more horizontal black bars around a portrait
        // design squeezed into a landscape frame.
        drawStretched(jL, jT, jW, jH);
        mctx.restore();
        // Spine overlay (span only).
        if (_jMode === "span") {
          mctx.fillStyle = "rgba(0,0,0,0.15)";
          mctx.fillRect(jL + jW / 2 - 2, jT, 4, jH);
        }
        // Border
        mctx.strokeStyle = "#5a4938";
        mctx.lineWidth = 2;
        mctx.beginPath();
        mctx.moveTo(jL + jR, jT);
        mctx.lineTo(jL + jW - jR, jT);
        mctx.quadraticCurveTo(jL + jW, jT, jL + jW, jT + jR);
        mctx.lineTo(jL + jW, jT + jH - jR);
        mctx.quadraticCurveTo(jL + jW, jT + jH, jL + jW - jR, jT + jH);
        mctx.lineTo(jL + jR, jT + jH);
        mctx.quadraticCurveTo(jL, jT + jH, jL, jT + jH - jR);
        mctx.lineTo(jL, jT + jR);
        mctx.quadraticCurveTo(jL, jT, jL + jR, jT);
        mctx.stroke();
      } else if (productId === "laptop_sleeve") {
        // Laptop 4:3 — wide landscape
        var lapL = 8, lapT = 28, lapW = 144, lapH = 108, lapR = 8;
        mctx.save();
        mctx.beginPath();
        mctx.moveTo(lapL + lapR, lapT);
        mctx.lineTo(lapL + lapW - lapR, lapT);
        mctx.quadraticCurveTo(lapL + lapW, lapT, lapL + lapW, lapT + lapR);
        mctx.lineTo(lapL + lapW, lapT + lapH - lapR);
        mctx.quadraticCurveTo(lapL + lapW, lapT + lapH, lapL + lapW - lapR, lapT + lapH);
        mctx.lineTo(lapL + lapR, lapT + lapH);
        mctx.quadraticCurveTo(lapL, lapT + lapH, lapL, lapT + lapH - lapR);
        mctx.lineTo(lapL, lapT + lapR);
        mctx.quadraticCurveTo(lapL, lapT, lapL + lapR, lapT);
        mctx.closePath();
        mctx.clip();
        drawCropped(lapL, lapT, lapW, lapH);
        mctx.restore();
        mctx.strokeStyle = "#666";
        mctx.lineWidth = 2;
        mctx.strokeRect(lapL, lapT, lapW, lapH);
      } else if (productId === "sticker_kiss") {
        // Kiss-cut sticker — rounded square with a white die-cut border so it
        // reads as a sticker laid on the card rather than a framed print.
        var skL = 18, skT = 18, skW = 124, skH = 124, skR = 18;
        // Outer die-cut: slightly larger rounded square behind the art.
        mctx.fillStyle = "#fafafa";
        mctx.beginPath();
        mctx.moveTo(skL - 4 + skR, skT - 4);
        mctx.lineTo(skL + skW + 4 - skR, skT - 4);
        mctx.quadraticCurveTo(skL + skW + 4, skT - 4, skL + skW + 4, skT - 4 + skR);
        mctx.lineTo(skL + skW + 4, skT + skH + 4 - skR);
        mctx.quadraticCurveTo(skL + skW + 4, skT + skH + 4, skL + skW + 4 - skR, skT + skH + 4);
        mctx.lineTo(skL - 4 + skR, skT + skH + 4);
        mctx.quadraticCurveTo(skL - 4, skT + skH + 4, skL - 4, skT + skH + 4 - skR);
        mctx.lineTo(skL - 4, skT - 4 + skR);
        mctx.quadraticCurveTo(skL - 4, skT - 4, skL - 4 + skR, skT - 4);
        mctx.closePath();
        mctx.fill();
        // Clip the art to the inner rounded square so it reads as a sticker face.
        mctx.save();
        mctx.beginPath();
        mctx.moveTo(skL + skR, skT);
        mctx.lineTo(skL + skW - skR, skT);
        mctx.quadraticCurveTo(skL + skW, skT, skL + skW, skT + skR);
        mctx.lineTo(skL + skW, skT + skH - skR);
        mctx.quadraticCurveTo(skL + skW, skT + skH, skL + skW - skR, skT + skH);
        mctx.lineTo(skL + skR, skT + skH);
        mctx.quadraticCurveTo(skL, skT + skH, skL, skT + skH - skR);
        mctx.lineTo(skL, skT + skR);
        mctx.quadraticCurveTo(skL, skT, skL + skR, skT);
        mctx.closePath();
        mctx.clip();
        drawCropped(skL, skT, skW, skH);
        mctx.restore();
        // Subtle drop shadow hint so the sticker sits on the card surface.
        mctx.strokeStyle = "rgba(0,0,0,0.18)";
        mctx.lineWidth = 1;
        mctx.strokeRect(skL - 4, skT - 4, skW + 8, skH + 8);
      } else if (productId === "backpack") {
        // Backpack silhouette — all-over-print body with a front panel that
        // carries the art, plus straps so it reads as a wearable bag.
        mctx.fillStyle = "#2a2a34";
        // Body outline (slight trapezoid, rounded corners)
        mctx.beginPath();
        mctx.moveTo(42, 40);
        mctx.lineTo(118, 40);
        mctx.quadraticCurveTo(130, 42, 132, 60);
        mctx.lineTo(132, 140);
        mctx.quadraticCurveTo(132, 150, 122, 150);
        mctx.lineTo(38, 150);
        mctx.quadraticCurveTo(28, 150, 28, 140);
        mctx.lineTo(28, 60);
        mctx.quadraticCurveTo(30, 42, 42, 40);
        mctx.closePath();
        mctx.fill();
        // Top handle
        mctx.strokeStyle = "#3a3a44";
        mctx.lineWidth = 4;
        mctx.beginPath();
        mctx.moveTo(70, 40);
        mctx.quadraticCurveTo(80, 20, 90, 40);
        mctx.stroke();
        // Shoulder straps (arcing outward at top, tucking behind body)
        mctx.strokeStyle = "#22222a";
        mctx.lineWidth = 6;
        mctx.beginPath();
        mctx.moveTo(45, 46); mctx.quadraticCurveTo(10, 75, 30, 130); mctx.stroke();
        mctx.beginPath();
        mctx.moveTo(115, 46); mctx.quadraticCurveTo(150, 75, 130, 130); mctx.stroke();
        // Front panel with the art (square print area on the body)
        var bpL = 48, bpT = 60, bpW = 64, bpH = 64;
        mctx.save();
        mctx.beginPath();
        mctx.rect(bpL, bpT, bpW, bpH);
        mctx.clip();
        drawCropped(bpL, bpT, bpW, bpH);
        mctx.restore();
        mctx.strokeStyle = "rgba(255,255,255,0.2)";
        mctx.lineWidth = 1;
        mctx.strokeRect(bpL, bpT, bpW, bpH);
        // Front pocket hint below the art
        mctx.fillStyle = "rgba(0,0,0,0.28)";
        mctx.fillRect(bpL + 6, bpT + bpH + 6, bpW - 12, 14);
      } else {
        // Generic fallback for unknown product ids (e.g. user-requested
        // products from the feedback flow). If the product carries
        // printShape === "circle", clip the image to a disc so round
        // print areas (pet-leash button, sticker rounds, etc.) render
        // correctly on the gallery card and the live-preview pane.
        var _fallbackProd = (typeof PRODUCTS !== "undefined")
          ? PRODUCTS.find(function(p) { return p.id === productId; })
          : null;
        if (_fallbackProd && _fallbackProd.printShape === "circle") {
          mctx.save();
          mctx.beginPath();
          mctx.arc(80, 80, 70, 0, Math.PI * 2);
          mctx.clip();
          drawCropped(10, 10, 140, 140);
          mctx.restore();
          // Subtle rim so the disc reads as a printed surface, not just a clip.
          mctx.strokeStyle = "rgba(255,255,255,0.18)";
          mctx.lineWidth = 1;
          mctx.beginPath();
          mctx.arc(80, 80, 70, 0, Math.PI * 2);
          mctx.stroke();
        } else {
          drawCropped(10, 10, 140, 140);
        }
      }
    }

    function getEffectiveAspectRatio(product) {
      if (!product) return null;
      // Dual-panel products: skip the variant-aspect override (which
      // would return the full panel aspect since parseVariantAspect-
      // Ratio reads the placeholder dimensions). In "span" mode use
      // panelAspectRatio; in "match" use the single-face aspectRatio.
      var ar;
      if (product.dualPanel && product.panelAspectRatio && product.aspectRatio) {
        var mode = (state.dualPanelModeByProduct && state.dualPanelModeByProduct[product.id]) || "match";
        // Copy so the forceOrientation / flip logic below mutates a
        // local AR, not the constant on the product entry.
        ar = (mode === "span")
          ? { w: product.panelAspectRatio.w, h: product.panelAspectRatio.h }
          : { w: product.aspectRatio.w,      h: product.aspectRatio.h };
      } else {
        ar = state.variantAspectRatioByProduct && state.variantAspectRatioByProduct[product.id];
        if (!ar || !ar.w || !ar.h) ar = product.aspectRatio || null;
      }
      if (!ar) return null;
      // Some products (e.g. desk mat) report variant sizes as short-side × long-side in their
      // titles, so parseVariantAspectRatio returns portrait even for a landscape product.
      // forceOrientation: "landscape" ensures the effective AR is always landscape (w ≥ h).
      if (product.forceOrientation === "landscape" && ar.h > ar.w) {
        ar = { w: ar.h, h: ar.w };
      }
      // Flip Aspect button: swap w↔h for the current product
      if (state.aspectFlippedByProduct && state.aspectFlippedByProduct[product.id]) {
        ar = { w: ar.h, h: ar.w };
      }
      return ar;
    }



// ── Exports ─────────────────────────────────────────────────
// drawProductMockup is the entry point. getEffectiveAspectRatio is
// exported because 20+ call sites in solar-archive.js + the variant
// picker still need it; everything else (snapshot, viewport, shared
// source, PRODUCT_PREVIEW_VIEW) stays module-private.
export { drawProductMockup, getEffectiveAspectRatio };
