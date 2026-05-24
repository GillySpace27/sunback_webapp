/* ===============================================================
   Solar Archive — beta-mode design bundler

   Step 7/N of the IIFE → ES-modules refactor. The beta-build flow
   replaces "Create on Shopify" with a local "Download your design"
   that bundles the editor canvas (+ JSON-LD provenance sidecar +
   any real Printify mockups for the active product) into a single
   .zip via JSZip, then surfaces a thank-you popup with a
   "design a new product" reset button.

   This is a self-contained UI flow with no callers outside its
   own click handlers and the buy-button branch in solar-archive.js
   (the only external entry point is saveDesignLocally(), exported
   below). Everything else (slug helper, JSZip loader, blob helpers,
   provenance builder, thank-you popup, workflow-reset) stays
   module-private.

   Deps injected:
   - solarCanvas         — editor canvas DOM ref
   - renderCanvas        — function: re-paints solarCanvas
   - dateInput           — #solarDate input DOM ref
   - _solarTimeValue     — function: returns the current solar time HH:MM
   - showToast           — global toast banner
   - API_BASE            — /api/feedback POST target
   - CITATIONS           — provenance acknowledgements
   - _scrollToEl         — embed-aware scroll helper
   - renderProducts      — re-paint after workflow reset
   =============================================================== */

import { state, defaultMockupManifest } from "./state.js";
import { PRODUCTS } from "./products.js";
import { recordStatEvent } from "./stats.js";

const _deps = {
  solarCanvas: null,
  renderCanvas: () => {},
  dateInput: null,
  _solarTimeValue: () => "",
  showToast: () => {},
  API_BASE: "",
  CITATIONS: {},
  _scrollToEl: () => {},
  renderProducts: () => {},
};

export function initBundler(deps) {
  Object.assign(_deps, deps);
}

    function _slugForFilename(s) {
      return String(s || "design").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "design";
    }

    // Lazy-load JSZip from a CDN the first time we need to bundle the
    // canvas + mockups. Cached on window so subsequent downloads in the
    // same session don't re-fetch. Resolves to the JSZip constructor or
    // rejects on script-load failure.
    var _jszipPromise = null;
    function _loadJSZip() {
      if (_jszipPromise) return _jszipPromise;
      if (window.JSZip) { _jszipPromise = Promise.resolve(window.JSZip); return _jszipPromise; }
      _jszipPromise = new Promise(function(resolve, reject) {
        var s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
        s.async = true;
        s.onload = function() {
          if (window.JSZip) resolve(window.JSZip);
          else reject(new Error("JSZip loaded but window.JSZip undefined"));
        };
        s.onerror = function() { reject(new Error("Failed to load JSZip CDN")); };
        document.head.appendChild(s);
      });
      return _jszipPromise;
    }

    // Helper: canvas → Blob via the modern callback API, falling back
    // to a dataURL→Blob conversion for stragglers.
    function _canvasToBlob(canvas, mime) {
      return new Promise(function(resolve, reject) {
        if (typeof canvas.toBlob === "function") {
          canvas.toBlob(function(b) {
            if (b) resolve(b);
            else reject(new Error("toBlob returned null"));
          }, mime || "image/png");
        } else {
          try {
            var dataUrl = canvas.toDataURL(mime || "image/png");
            var byteString = atob(dataUrl.split(",")[1]);
            var buf = new ArrayBuffer(byteString.length);
            var bytes = new Uint8Array(buf);
            for (var i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
            resolve(new Blob([buf], { type: mime || "image/png" }));
          } catch (e) { reject(e); }
        }
      });
    }

    // Helper: fetch a remote image as a Blob. Printify CDN
    // (images.printify.com) serves Access-Control-Allow-Origin:*, so
    // a plain fetch works; we still set mode:"cors" explicitly so any
    // future redirect to a stricter host fails loudly instead of
    // returning an opaque response we can't put in the zip.
    function _fetchImageAsBlob(url) {
      return fetch(url, { mode: "cors", cache: "force-cache" })
        .then(function(r) {
          if (!r.ok) throw new Error("HTTP " + r.status + " fetching " + url);
          return r.blob();
        });
    }

    // Trigger a browser download for a Blob with the given filename.
    function _downloadBlob(blob, fileName) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function() {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 200);
    }

    // ── Patricia P2 (round-2): machine-readable provenance sidecar ──
    // Build a schema.org JSON-LD provenance object that ships alongside
    // each downloaded print. Educators / museums / NASA-EPO reviewers
    // can verify lineage (Frame / Date / Wavelength / Source / Pipeline)
    // without having to hunt through the live site. Source-of-truth
    // strings come from the _deps.CITATIONS block above so wording stays in
    // lockstep with the on-screen credits.
    function _buildProvenanceJsonLd(opts) {
      opts = opts || {};
      var wl = opts.wavelength || "";
      var dateStr = opts.dateStr || "";          // "YYYY-MM-DD"
      var timeStr = opts.timeStr || "";          // "HH:MM" UTC
      var filter = opts.editorFilter || "jpg";   // jpg | raw | rhef | hq_rhef
      var productId = opts.productId || "design";
      var productName = opts.productName || "";

      // Compose ISO 8601 UTC timestamp. Date-only input still produces
      // a valid instant ("…T00:00:00Z") so downstream parsers don't choke.
      var isoDate;
      if (dateStr) {
        var t = timeStr || "00:00";
        isoDate = dateStr + "T" + t + ":00Z";
      } else {
        isoDate = new Date().toISOString();
      }

      // The "qualityTier" is the editor filter the user shipped with —
      // matters because RHEF / HQ-RHEF prints go through SunPy + sunkit-
      // image, while JPG previews come straight from Helioviewer.
      var pipeline;
      if (filter === "rhef" || filter === "hq_rhef") {
        pipeline = "SunPy + sunkit-image (RHEF); per " + _deps.CITATIONS.RHEF_PAPER;
      } else if (filter === "raw") {
        pipeline = "Level-1 AIA FITS via VSO + SunPy normalisation";
      } else {
        pipeline = "Helioviewer JPEG2000 tile composite";
      }

      var nameBits = ["Solar Archive"];
      if (wl) nameBits.push(wl + " Å");
      if (dateStr) nameBits.push(dateStr);
      var displayName = nameBits.join(" — ");

      var distributor = (filter === "raw" || filter === "rhef" || filter === "hq_rhef")
        ? "Joint Science Operations Center (JSOC), Stanford"
        : "Helioviewer Project";
      var via = (filter === "raw" || filter === "rhef" || filter === "hq_rhef")
        ? "Virtual Solar Observatory (VSO)"
        : "Helioviewer JPIP";

      var jsonLd = {
        "@context": "https://schema.org",
        "@type": "ImageObject",
        "name": displayName,
        "dateCreated": isoDate,
        "creator": { "@type": "Organization", "name": "Solar Archive" },
        "contentLocation": "NASA/SDO/AIA",
        "encodingFormat": "image/png",
        "license": "https://sdo.gsfc.nasa.gov/data/rules.php",
        "creditText": _deps.CITATIONS.SDO_ACK,
        "citation": [
          _deps.CITATIONS.SDO_ACK,
          _deps.CITATIONS.AIA_PAPER,
          _deps.CITATIONS.RHEF_PAPER,
          _deps.CITATIONS.HELIOVIEWER_ACK
        ],
        "isBasedOn": [
          {
            "@type": "Dataset",
            "name": "AIA " + (wl || "") + " Å",
            "datePublished": isoDate,
            "distributor": distributor,
            "via": via
          }
        ],
        "potentialAction": {
          "@type": "ViewAction",
          "description": "RHEF (Radial Histogram Equalization Filter); " + _deps.CITATIONS.RHEF_PAPER
        },
        "additionalProperty": [
          { "@type": "PropertyValue", "name": "wavelength", "value": String(wl || ""), "unitText": "Å" },
          { "@type": "PropertyValue", "name": "instrument", "value": "AIA" },
          { "@type": "PropertyValue", "name": "spacecraft", "value": "SDO" },
          { "@type": "PropertyValue", "name": "observationDateUTC", "value": isoDate },
          { "@type": "PropertyValue", "name": "qualityTier", "value": filter },
          { "@type": "PropertyValue", "name": "pipeline", "value": pipeline },
          { "@type": "PropertyValue", "name": "productId", "value": productId },
          { "@type": "PropertyValue", "name": "productName", "value": productName }
        ]
      };
      return jsonLd;
    }

    // Serialise + sanity-parse (catches accidental non-JSON values like
    // undefined slipping in). Returns the canonical string or throws.
    function _serializeProvenance(jsonLd) {
      var str = JSON.stringify(jsonLd, null, 2);
      JSON.parse(str); // assert round-trip; will throw if malformed
      return str;
    }

    function _saveDesignLocally() {
      // Render the canvas with edits baked in (no orange frame border)
      // — same trick the clock/text "burn" path uses.
      if (!_deps.solarCanvas) return;
      var product = state.selectedProduct
        ? PRODUCTS.find(function(p) { return p.id === state.selectedProduct; })
        : null;
      // Conversion signal: a finalized "Download your design" (beta).
      if (product) recordStatEvent(product.id, "buy");
      var prevBurning = state._burningCanvas;
      state._burningCanvas = true;
      try { _deps.renderCanvas(); } catch (_e) {}
      state._burningCanvas = prevBurning || false;
      var dateStr = (_deps.dateInput && _deps.dateInput.value) || "design";
      var timeStr = _deps._solarTimeValue ? _deps._solarTimeValue() : "";
      var wl = state.wavelength || "";
      var pid = product ? product.id : "design";
      var baseName = "solar-archive_" + _slugForFilename(dateStr)
                     + (timeStr ? "_" + _slugForFilename(timeStr) : "")
                     + (wl ? "_" + wl + "A" : "")
                     + "_" + _slugForFilename(pid);
      var canvasFileName = baseName + ".png";
      var provenanceFileName = baseName + ".provenance.json";

      // Patricia P2 (round-2): build the JSON-LD provenance sidecar
      // once up front; reused for both the single-PNG download path
      // (fired as a second <a download> click) and the zip path
      // (added as a file entry in the archive). Failures here are
      // non-fatal — the PNG/zip download must still succeed.
      var provenanceJsonStr = null;
      try {
        var provenanceObj = _buildProvenanceJsonLd({
          wavelength: state.wavelength,
          dateStr: dateStr,
          timeStr: timeStr,
          editorFilter: state.editorFilter,
          productId: pid,
          productName: product ? product.name : ""
        });
        provenanceJsonStr = _serializeProvenance(provenanceObj);
      } catch (e) {
        console.warn("[saveDesign] provenance build failed; skipping sidecar", e);
      }

      // Find any generated Printify mockups for the selected product.
      // If there are any, we'll bundle them with the canvas PNG into a
      // single .zip so the tester walks away with the full preview set.
      var mockupEntry = (state.mockups && pid && state.mockups[pid]) || null;
      var mockupImages = (mockupEntry && Array.isArray(mockupEntry.images))
        ? mockupEntry.images.filter(function(img) { return img && img.src; })
        : [];
      // Phase B fallback: if the user is still on the default landing
      // image and hasn't run a personalized real-mockup generation, use
      // the pre-rendered photorealistic mockup we cached on disk. Same
      // photo the showcase tile is already displaying — counts as "real".
      if (!mockupImages.length
          && state.isDefaultActive
          && defaultMockupManifest
          && pid
          && defaultMockupManifest[pid]
          && defaultMockupManifest[pid].url) {
        mockupImages = [{ src: defaultMockupManifest[pid].url, position: "default" }];
      }

      var startedMessage = mockupImages.length
        ? "Packaging your design + " + mockupImages.length + " mockup" + (mockupImages.length === 1 ? "" : "s") + "…"
        : null;
      if (startedMessage) _deps.showToast(startedMessage);

      _canvasToBlob(_deps.solarCanvas, "image/png").then(function(canvasBlob) {
        if (!mockupImages.length) {
          // No mockups → fall back to the simple single-PNG download.
          _downloadBlob(canvasBlob, canvasFileName);
          // Patricia P2: fire the JSON-LD provenance sidecar as a second
          // <a download> click. Modern browsers (Chrome, Safari 16+,
          // Firefox) allow two back-to-back programmatic downloads from
          // the same user-gesture chain; the setTimeout gives the first
          // save dialog room to register before the second goes out.
          if (provenanceJsonStr) {
            setTimeout(function() {
              try {
                var jsonBlob = new Blob([provenanceJsonStr], { type: "application/ld+json" });
                _downloadBlob(jsonBlob, provenanceFileName);
              } catch (e) {
                console.warn("[saveDesign] provenance download failed", e);
              }
            }, 150);
          }
          return null;
        }
        // Otherwise bundle canvas + mockups into a zip.
        return _loadJSZip().then(function(JSZip) {
          var zip = new JSZip();
          zip.file(canvasFileName, canvasBlob);
          // Patricia P2: drop the JSON-LD provenance into the same zip
          // so the museum / educator unpacks one bundle and gets full
          // lineage. No second-download dance needed in this path.
          if (provenanceJsonStr) {
            zip.file(provenanceFileName, provenanceJsonStr);
          }
          // Fetch each mockup in parallel; tolerate per-mockup failures
          // by zipping only the ones that came back successfully.
          var fetches = mockupImages.map(function(img, i) {
            return _fetchImageAsBlob(img.src)
              .then(function(b) {
                var posSuffix = img.position ? "_" + _slugForFilename(img.position) : "";
                var idxSuffix = "_" + String(i + 1).padStart(2, "0");
                zip.file(baseName + "_mockup" + idxSuffix + posSuffix + ".png", b);
              })
              .catch(function(err) {
                // Log and continue — better to ship a partial zip than fail outright.
                console.warn("[saveDesign] mockup " + i + " failed:", err);
              });
          });
          return Promise.all(fetches).then(function() {
            return zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
          }).then(function(zipBlob) {
            _downloadBlob(zipBlob, baseName + ".zip");
          });
        });
      }).catch(function(e) {
        console.warn("[saveDesign] bundle path failed, falling back to canvas-only PNG", e);
        // Best-effort fallback: just push the canvas PNG so the user
        // still walks away with something.
        _canvasToBlob(_deps.solarCanvas, "image/png")
          .then(function(b) {
            _downloadBlob(b, canvasFileName);
            // Patricia P2: still ship the sidecar on the fallback path.
            if (provenanceJsonStr) {
              setTimeout(function() {
                try {
                  var jsonBlob = new Blob([provenanceJsonStr], { type: "application/ld+json" });
                  _downloadBlob(jsonBlob, provenanceFileName);
                } catch (e) {
                  console.warn("[saveDesign] provenance download failed", e);
                }
              }, 150);
            }
          })
          .catch(function() {
            _deps.showToast("Couldn't save the design — try again or screenshot the canvas.", "error");
          });
      });
      // Re-render once more so the editor goes back to its non-burning
      // state (frame border + handles re-appear).
      try { _deps.renderCanvas(); } catch (_e) {}

      // Notify the operator out-of-band so beta feedback shows up in
      // the same email pipeline as regular comments. Body is a marker
      // string the operator can filter on; structured detail rides in
      // the context object that the email template already prints.
      var noteBody = "[Beta design save] " + (product ? product.name : "(no product)") +
                     " · " + dateStr + (timeStr ? " " + timeStr + " UTC" : "") +
                     (wl ? " · " + wl + " Å" : "") +
                     (mockupImages.length ? " · zipped with " + mockupImages.length + " mockup" + (mockupImages.length === 1 ? "" : "s") : " · canvas only");
      var ctx = (typeof captureContext === "function") ? captureContext() : {};
      ctx.product = pid;
      ctx.product_name = product ? product.name : null;
      ctx.beta_mode = true;
      ctx.bundled_mockups = mockupImages.length;
      // Inline a downscaled PNG snapshot for the operator email so the
      // [Beta design save] notification carries what the tester
      // actually downloaded — same pattern the feedback modal uses,
      // but its _captureCanvasSnapshot helper is scoped inside the
      // feedback IIFE so we re-do the 6 lines here rather than hoist.
      var canvasImageDataUrl = null;
      try {
        var MAX_DIM = 800;
        var sw = _deps.solarCanvas.width, sh = _deps.solarCanvas.height;
        var scale = Math.min(1, MAX_DIM / Math.max(sw, sh));
        if (scale >= 1) {
          canvasImageDataUrl = _deps.solarCanvas.toDataURL("image/png");
        } else {
          var tmp = document.createElement("canvas");
          tmp.width  = Math.max(1, Math.round(sw * scale));
          tmp.height = Math.max(1, Math.round(sh * scale));
          tmp.getContext("2d").drawImage(_deps.solarCanvas, 0, 0, tmp.width, tmp.height);
          canvasImageDataUrl = tmp.toDataURL("image/png");
        }
      } catch (_e) { /* best-effort — email still lands without the image */ }
      // sendFeedback() is scoped inside the feedback IIFE — fire a
      // direct fetch so we don't have to hoist it. Failures here used
      // to be silently swallowed; now we log a console.warn so it's
      // diagnosable when the operator email doesn't arrive. The user's
      // download still succeeds either way.
      try {
        var payload = {
          kind: "comment",
          body: noteBody,
          url: window.location.href,
          user_agent: navigator.userAgent,
          context: ctx,
          canvas_image: canvasImageDataUrl,
        };
        // Attach saved name/email if the tester has filed a feedback
        // entry earlier this session — gives the operator a "who
        // downloaded what" lookup without forcing a second form.
        try {
          var savedRaw = localStorage.getItem("solarArchive.feedbackContact.v1");
          if (savedRaw) {
            var saved = JSON.parse(savedRaw);
            if (saved && saved.name) payload.name = saved.name;
            if (saved && saved.email) payload.email = saved.email;
          }
        } catch (_e) { /* private mode, etc. */ }
        // Drop canvas_image if it's somehow oversized — backend caps at
        // ~2.5MB and rejects payloads larger than that altogether.
        if (canvasImageDataUrl && canvasImageDataUrl.length > 2_300_000) {
          console.warn("[betaSave] canvas dataURL too big (" + canvasImageDataUrl.length + " chars), dropping");
          payload.canvas_image = null;
        }
        fetch(_deps.API_BASE + "/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then(function(r) {
            if (!r.ok) {
              return r.text().then(function(t) {
                console.warn("[betaSave] /api/feedback HTTP " + r.status + ": " + t.slice(0, 300));
              });
            }
          })
          .catch(function(err) {
            console.warn("[betaSave] /api/feedback failed:", err);
          });
      } catch (e) {
        console.warn("[betaSave] fetch threw synchronously:", e);
      }
      var doneToast = mockupImages.length
        ? "Saved! Your design + " + mockupImages.length + " mockup" + (mockupImages.length === 1 ? "" : "s") + " are in the zip."
        : "Design saved! We'll let you know when this product launches.";
      _deps.showToast(doneToast, "success");
      // Surface the thank-you popup a moment after the toast so the
      // download save dialog has time to fire and the toast is visible
      // mid-fade. The popup closes the loop with a clear "what next"
      // CTA — without it the beta felt one-way (user clicks, file
      // appears, nothing acknowledges them).
      if (typeof _showBetaThanksPopup === "function") {
        setTimeout(_showBetaThanksPopup, 400);
      }
    }

    // ── Beta thank-you popup ──────────────────────────────────
    // Shown after _saveDesignLocally completes. "Design a new product"
    // resets the workflow to the top of the page so the tester can
    // run through the editor again with different settings, while
    // keeping their date/wavelength/time intact (those are session-
    // level choices the user almost never wants to redo).
    function _showBetaThanksPopup() {
      var modal = document.getElementById("betaThanksModal");
      if (!modal) return;
      modal.classList.remove("hidden");
      // Trap focus on the primary button so Enter triggers it.
      var primary = document.getElementById("betaThanksReset");
      if (primary) setTimeout(function() { primary.focus(); }, 50);
    }
    function _hideBetaThanksPopup() {
      var modal = document.getElementById("betaThanksModal");
      if (modal) modal.classList.add("hidden");
    }
    function _resetWorkflowFromTop() {
      _hideBetaThanksPopup();
      // Drop product selection + mockups so the picker reads as fresh.
      // We deliberately keep date/wavelength/time — those are higher-
      // level choices the tester would have to re-enter otherwise.
      state.selectedProduct = null;
      state.mockups = {};
      state.mockupSlideIndex = {};
      // Close the live-preview pane if it's open.
      var preview = document.getElementById("selectedProductPreview");
      if (preview) preview.classList.add("hidden");
      // Re-render the product grid so the "Selected" pill clears.
      if (typeof _deps.renderProducts === "function") {
        try { _deps.renderProducts(); } catch (_e) {}
      }
      // Hide the editor section since there's no product selected.
      var editSection = document.getElementById("editSection");
      if (editSection) editSection.classList.add("hidden");
      // Scroll back to the date / wavelength picker so the workflow
      // visibly starts over.
      var top = document.querySelector(".section") || document.body;
      _deps._scrollToEl(top, "start");
    }
    (function _wireBetaThanksPopup() {
      var primary = document.getElementById("betaThanksReset");
      var closeBtn = document.getElementById("betaThanksClose");
      var backdrop = document.getElementById("betaThanksBackdrop");
      if (primary) primary.addEventListener("click", _resetWorkflowFromTop);
      if (closeBtn) closeBtn.addEventListener("click", _hideBetaThanksPopup);
      if (backdrop) backdrop.addEventListener("click", _hideBetaThanksPopup);
      document.addEventListener("keydown", function(e) {
        if (e.key === "Escape" && !document.getElementById("betaThanksModal").classList.contains("hidden")) {
          _hideBetaThanksPopup();
        }
      });
    })();


export { _saveDesignLocally as saveDesignLocally };
