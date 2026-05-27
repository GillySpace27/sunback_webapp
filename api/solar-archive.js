/* ===============================================================
   Solar Archive — Poe Canvas App

   Loaded as an ES module from index.html (<script type="module">).
   Modules are strict-mode by default and have their own top-level
   scope, so the old (function () { … })(); IIFE wrapper that used
   to fence this file is now redundant — the module boundary does
   the same job. As we extract slices into sibling .js files this
   file gradually shrinks; for now it still hosts the bulk of the
   app while we move pieces out one commit at a time.
   =============================================================== */

import { state, defaultMockupManifest, setDefaultMockupManifest } from "./state.js";
import { PRODUCTS } from "./products.js";
import { PRINTIFY_COLOR_HEX, hexForColorName, variantColorOption } from "./colors.js";
import { drawProductMockup, getEffectiveAspectRatio, initMockups } from "./mockups.js";
import { setupFeedback } from "./feedback.js";
import { recordStatEvent, addStatsBadge, productsByPopularity, initStats } from "./stats.js";
import { saveDesignLocally, initBundler } from "./bundler.js";

    // ── Config ───────────────────────────────────────────────────
    // Derive API base from current origin so the same page works in local dev,
    // staging, and production without CORS complexity.
    // When opened via file://, origin is "null" and fetch fails — allow ?api=URL override.
    var isFileProtocol = (window.location.protocol === "file:" || !window.location.origin || window.location.origin === "null");
    var API_BASE = (function() {
      var params = new URLSearchParams(window.location.search);
      if (params.has("api")) return params.get("api").replace(/\/+$/, "");
      if (isFileProtocol) return "";  // no backend when viewing from file without ?api=
      return window.location.origin;
    })();
    var HEALTH_TIMEOUT_MS = 12000;    // 12s to allow cold start
    var FETCH_TIMEOUT_MS  = 90000;    // 90s for preview gen (NASA fetch can be slow)
    var WAKE_RETRY_DELAY  = 5000;     // 5s between retries when waking

    // ── Attribution citation strings ─────────────────────────────
    // Referenced when we wire the per-product attribution work
    // (Patricia's P1 follow-up). Kept here so the strings live
    // next to the code that consumes them, not buried in a doc.
    //
    //   SDO_ACK   — NASA SDO rules-of-the-road acknowledgement;
    //               required on any SDO-derived imagery regardless
    //               of source format.
    //   AIA_PAPER — Lemen 2012 AIA instrument paper. Cite when
    //               the product describes the AIA instrument.
    //   RHEF_PAPER — Gilly et al. 2025, Sol. Phys. 300:174 — the
    //                radial histogram equalization filter method
    //                paper. Cite on the RHEF / HQ RHEF tier
    //                descriptions.
    //   HELIOVIEWER_ACK — Required only when Helioviewer service
    //                     was used to produce the rendered image
    //                     (i.e. JPG tier from takeScreenshot).
    //                     NOT required on FITS-derived prints
    //                     (Raw / RHEF / HQ RHEF) since those go
    //                     through VSO → SunPy bypassing Helioviewer.
    var CITATIONS = {
      // Trimmed from "AIA, EVE, and HMI science teams" to "AIA"
      // only per Patricia's round-2 note: we don't currently surface
      // EVE or HMI imagery, so naming them in the credit reads as
      // cargo-cult to a domain reviewer. Restore the longer form
      // here AND in index.html footer if we add EVE/HMI channels.
      SDO_ACK: "Courtesy of NASA/SDO and the AIA science team.",
      AIA_PAPER: "Lemen, J. R., et al. 2012, Sol. Phys., 275, 17.",
      RHEF_PAPER: "Gilly, C., et al. 2025, Sol. Phys., 300, 174 (https://ui.adsabs.harvard.edu/abs/2025SoPh..300..174G).",
      HELIOVIEWER_ACK: "This work has made use of the Helioviewer Project, an open-source project for visualisation of solar and heliospheric data."
    };

    // ── Back-button: unwind app state instead of leaving the page ──
    // The app pushes a history state when significant transitions
    // happen (currently: opening the editor in commitProductSelection).
    // Pressing the browser back button fires popstate, and we reverse
    // the transition — close the editor, scroll back to the product
    // picker. After all in-app states are unwound, the next back
    // press exits the page (or the Shopify iframe page) normally.
    // The handler is registered lazily inside DOMContentLoaded so
    // editSection / productSection lookups succeed.
    // KNOWN-LIMITATION / REPRO (Tom QA round-2, deferred state-machine
    // item — documented here so it's reproducible end-to-end):
    //   1. Pick product A → open editor → in the variant picker choose
    //      a NON-default variant (e.g. the large size), generate a real
    //      mockup so state.uploadedPrintifyId* + state.mockups[A] fill.
    //   2. Press the browser Back button. This handler hides the editor
    //      and scrolls to the product picker, but intentionally does NOT
    //      clear state.selectedVariantByProduct[A] or the cached mockup/
    //      upload ids — so the picked variant survives (desired) BUT the
    //      mockup cached against it is now detached from the closed
    //      editor session.
    //   3. Re-open product A's editor. It shows the prior variant +
    //      stale mockup without re-verifying that the variant/upload
    //      still match the current edit state.
    // The correct fix is a proper editor-session state machine (reset
    // or re-verify uploadedPrintifyId*/mockups on re-entry), tracked as
    // a deferred item in TODOS.md. This comment exists so the repro
    // isn't lost; the handler below only owns the navigation unwind.
    window.addEventListener("popstate", function() {
      var ed = document.getElementById("editSection");
      // If the editor is visible, treat back as "close the editor."
      if (ed && !ed.classList.contains("hidden")) {
        ed.classList.add("hidden");
        var ps = document.getElementById("productSection");
        if (ps) {
          try { _scrollToEl(ps, "start"); }
          catch (_e) { ps.scrollIntoView(); }
        }
        return;
      }
    });

    // ── Embedded-context detection ───────────────────────────────
    // The app is also served as an iframe on the Shopify storefront
    // (solar-archive.myshopify.com). That iframe is sized to its
    // content height — meaning it has NO internal scroll, the
    // outer Shopify page scrolls instead. Anything we built that
    // depends on internal scroll behaviour stops working there:
    //   - position: sticky has nothing to anchor against, so the
    //     sticky editor canvas + preview pane drift off the visible
    //     viewport as the user scrolls the outer page
    //   - 100dvh inside the iframe = iframe content height, not the
    //     visible window, so modals end up much taller than the
    //     user's actual viewport
    // The .embedded class on <html> lets CSS opt into a flat, no-
    // sticky layout (same shape mobile already uses) and clamp modal
    // heights so they fit the typical visible window.
    try {
      if (window.self !== window.top) {
        document.documentElement.classList.add("embedded");
      }
    } catch (_e) {
      // Cross-origin frame access threw → we ARE in a cross-origin
      // iframe (the try is the detection). Same treatment.
      document.documentElement.classList.add("embedded");
    }

    // ── Embedded-iframe height messaging ─────────────────────────
    // The remaining scroll-fight a tester reported is at the iframe
    // level: Shopify pins the iframe to a fixed height, so when our
    // content extends past it the iframe gets its OWN scrollbar.
    // We can't kill that scrollbar from inside the iframe alone —
    // the iframe's height is set by the parent — so we continuously
    // postMessage our content height. The Shopify theme reads the
    // message and resizes the iframe to match, making the outer page
    // the only scroll surface.
    //
    // Parent-side snippet to add ONCE to the Shopify theme (e.g. in
    // theme.liquid or whichever page hosts the iframe):
    //
    //   <script>
    //     window.addEventListener("message", function (e) {
    //       if (!e.data || e.data.source !== "solar-archive") return;
    //       if (e.data.type !== "resize") return;
    //       document.querySelectorAll(
    //         'iframe[src*="solar-archive.onrender.com"]'
    //       ).forEach(function (f) {
    //         f.style.height = e.data.height + "px";
    //         f.setAttribute("scrolling", "no");
    //       });
    //     });
    //   </script>
    //
    // Without the parent-side listener the messages are silently
    // ignored — same iframe behaviour as today, no regression.
    function _postIframeHeight() {
      if (window.parent === window) return;
      var doc = document.documentElement;
      var bod = document.body;
      if (!doc || !bod) return;
      var h = Math.max(
        doc.scrollHeight || 0,
        bod.scrollHeight || 0,
        doc.offsetHeight || 0,
        bod.offsetHeight || 0
      );
      if (h <= 0) return;
      try {
        window.parent.postMessage(
          { source: "solar-archive", type: "resize", height: h },
          "*"
        );
      } catch (_e) { /* sandboxed iframe, etc. — ignore */ }
    }
    if (document.documentElement.classList.contains("embedded")) {
      // Fire after initial render, after the load event (when images
      // and fonts settle), and on every body resize. The
      // ResizeObserver catches modal opens, tab expansions, image-
      // decode-after-layout, animated transitions, etc. — Priya
      // (round-2 perf) flagged that the prior `setInterval(_, 800)`
      // safety net was redundant with the observer for every realistic
      // case and just kept the event loop awake for nothing. Dropped.
      document.addEventListener("DOMContentLoaded", _postIframeHeight);
      window.addEventListener("load", _postIframeHeight);
      window.addEventListener("resize", _postIframeHeight);
      if (typeof ResizeObserver !== "undefined") {
        try {
          var _saResizeObs = new ResizeObserver(_postIframeHeight);
          _saResizeObs.observe(document.body);
          _saResizeObs.observe(document.documentElement);
        } catch (_e) {
          // Old browser with no ResizeObserver — the 800ms safety net
          // used to back this up. We trade off some rare animated-
          // transition re-fires here; load + resize + DOMContentLoaded
          // still fire, which is good enough for legacy.
        }
      }
    }

    // ── Embedded-iframe FAB anchoring ────────────────────────────
    // The feedback FAB is `position: fixed; bottom: 18px; right: 18px`
    // in standalone — but inside a content-sized iframe `fixed` pins
    // to the iframe's coordinate space (which is the whole content
    // area, not the visible window), so the FAB ends up at the
    // bottom of the iframe's content rather than the bottom of the
    // user's screen. To anchor it to the actual visible viewport we
    // listen for messages from the parent telling us where the
    // visible region falls inside the iframe, then position the FAB
    // absolutely at that coordinate.
    //
    // Parent-side snippet (paste alongside the resize listener you
    // already installed in the Shopify theme):
    //
    //   <script>
    //     function _saSendViewport() {
    //       document.querySelectorAll(
    //         'iframe[src*="solar-archive.onrender.com"]'
    //       ).forEach(function (f) {
    //         var rect = f.getBoundingClientRect();
    //         var visibleBottom = Math.min(window.innerHeight, rect.bottom);
    //         var visibleBottomInIframe = visibleBottom - rect.top;
    //         // visibleTopInIframe = how far the parent has scrolled
    //         // past the iframe's top. Drives the floating editor canvas.
    //         var visibleTopInIframe = Math.max(0, -rect.top);
    //         // topCoverPx = sticky-nav height (_saTopCover()); drives the
    //         // scroll-margin-top so auto-scroll lands below the nav.
    //         f.contentWindow.postMessage({
    //           source: "solar-archive-parent",
    //           type: "viewport",
    //           visibleBottomInIframe: visibleBottomInIframe,
    //           visibleTopInIframe: visibleTopInIframe,
    //           topCoverPx: _saTopCover()
    //         }, "*");
    //       });
    //     }
    //     window.addEventListener("scroll", _saSendViewport, { passive: true });
    //     window.addEventListener("resize", _saSendViewport);
    //     document.addEventListener("DOMContentLoaded", _saSendViewport);
    //
    //     // SCROLL HANDLER — the cross-origin iframe can't scroll the
    //     // parent itself, so it asks; we scroll, offset below the nav.
    //     window.addEventListener("message", function (e) {
    //       if (e.origin !== SA_ORIGIN) return;
    //       var d = e.data;
    //       if (!d || d.source !== "solar-archive" || d.type !== "scrollTo") return;
    //       var f = document.querySelector('iframe[src*="solar-archive.onrender.com"]');
    //       if (!f || typeof d.topInIframe !== "number") return;
    //       if (typeof d.docHeight === "number" && d.docHeight > 0) f.style.height = d.docHeight + "px";
    //       var iframeTopAbs = f.getBoundingClientRect().top + window.scrollY;
    //       var y = iframeTopAbs + d.topInIframe - _saTopCover() - 12;
    //       if (d.block === "center") y = iframeTopAbs + d.topInIframe - (window.innerHeight - (d.height||0))/2;
    //       window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    //     });
    //   </script>
    //
    // Without the parent listener the FAB falls back to whatever its
    // CSS rule provides, and the editor canvas stays static — same
    // iframe behaviour as today. The floating canvas turns on only
    // once the parent adds `visibleTopInIframe` to the payload above.
    // Origins allowed to postMessage into this iframe. The parent
    // Shopify storefront iframe-host is the only legitimate sender;
    // localhost is here for dev. Round-2 audit (Mira Sokolov, P0 HIGH):
    // the previous listener only checked e.data.source, never e.origin,
    // so any framing page could mutate the FAB DOM and would prime an
    // XSS the moment a handler started writing to innerHTML.
    var PARENT_ORIGIN_ALLOWLIST = [
      "https://solar-archive.myshopify.com",
      "https://solar-archive.onrender.com",
      "http://localhost:8000",
      "http://127.0.0.1:8000",
    ];
    // ── Embedded floating canvas (Gilly-approved refactor) ──────────
    // Inside the content-sized Shopify iframe, position:sticky never
    // engages — it anchors to the iframe's content box, which IS the
    // scroll surface, so the editor canvas scrolls off-screen the
    // moment the user reaches the sliders. We re-implement sticky
    // manually: the parent reports where the visible region falls
    // inside the iframe (visibleTopInIframe), and we ride #imageStage
    // along the top of that region — clamped to the editor's vertical
    // bounds — with a placeholder holding the canvas's grid slot so
    // the toolbar below doesn't jump up.
    //
    // GRACEFUL DEGRADATION: this only activates when the parent sends
    // `visibleTopInIframe`. Until the Shopify theme snippet is updated
    // (see the parent snippet documented above — add visibleTopInIframe
    // alongside visibleBottomInIframe), the canvas keeps its current
    // embedded static layout. No regression while the theme catches up.
    var _canvasPlaceholder = null;
    function _ensureCanvasPlaceholder(stage) {
      if (_canvasPlaceholder && _canvasPlaceholder.isConnected) return _canvasPlaceholder;
      var ph = document.createElement("div");
      ph.className = "image-stage-placeholder";
      ph.setAttribute("aria-hidden", "true");
      ph.style.display = "none";
      // Insert right after the stage so it occupies the same grid slot
      // ordering; CSS assigns it grid-area: canvas in embedded mode.
      stage.parentNode.insertBefore(ph, stage.nextSibling);
      _canvasPlaceholder = ph;
      return ph;
    }
    function _unfloatCanvas(stage) {
      if (!stage) stage = document.getElementById("imageStage");
      if (stage) {
        stage.classList.remove("is-floating");
        stage.style.position = "";
        stage.style.top = "";
        stage.style.left = "";
        stage.style.right = "";
        stage.style.width = "";
        stage.style.zIndex = "";
      }
      if (_canvasPlaceholder) {
        _canvasPlaceholder.style.display = "none";
        _canvasPlaceholder.style.height = "";
      }
    }
    var _floatRafPending = false;
    var _lastVisibleTop = null;     // last reported viewport offset (for re-sync on resize)
    var _lastVisibleBottom = null;  // last reported visible-bottom (for centred overlay tracking)
    // Overlays (e.g. the data-credits modal in embedded mode) that want to
    // float at the centre of the visible window and TRACK the user's scroll
    // until closed. Each entry: { el, onClose? }. The viewport message
    // handler re-positions them on every update.
    var _centeredOverlays = [];
    function _centerInVisible(overlay) {
      if (!overlay) return;
      if (typeof _lastVisibleTop !== "number") return;
      var oh = overlay.offsetHeight || 200;
      if (typeof _lastVisibleBottom === "number") {
        // Vertically centre within the visible window; clamp 8px from the top
        // so a tall overlay doesn't slip above the nav.
        var visH = Math.max(0, _lastVisibleBottom - _lastVisibleTop);
        overlay.style.top = (_lastVisibleTop + Math.max(8, (visH - oh) / 2)) + "px";
      } else {
        // No visible-bottom reported yet — fall back to top-pinning
        // (24px below the nav) until the next viewport message lands.
        overlay.style.top = (_lastVisibleTop + 24) + "px";
      }
    }
    function _registerCenteredOverlay(overlay) {
      _centeredOverlays.push(overlay);
      _centerInVisible(overlay);
    }
    function _unregisterCenteredOverlay(overlay) {
      var i = _centeredOverlays.indexOf(overlay);
      if (i >= 0) _centeredOverlays.splice(i, 1);
    }
    function _updateFloatingCanvas(visibleTopInIframe) {
      _lastVisibleTop = visibleTopInIframe;
      // rAF-coalesce: the parent fires this on every scroll tick.
      if (_floatRafPending) return;
      _floatRafPending = true;
      (window.requestAnimationFrame || function(cb){ return setTimeout(cb, 16); })(function() {
        _floatRafPending = false;
        var stage = document.getElementById("imageStage");
        var editor = document.querySelector(".editor-with-preview");
        var editSection = document.getElementById("editSection");
        if (!stage || !editor || !editSection) return;
        // Don't float when the editor isn't on screen.
        if (editSection.classList.contains("hidden")) { _unfloatCanvas(stage); return; }
        var ph = _ensureCanvasPlaceholder(stage);
        // Natural top of the editor region in iframe-document coords.
        // Measure against the placeholder when floating (stable), else
        // the stage itself.
        var floating = stage.style.position === "absolute";
        var editorRect = editor.getBoundingClientRect();
        var editorDocTop = editorRect.top + window.pageYOffset;
        var stageH = (floating && _canvasPlaceholder ? _canvasPlaceholder.offsetHeight : stage.offsetHeight) || 0;
        var margin = 8;
        // Desired top, relative to the editor (its CSS makes it the
        // positioned ancestor in embedded mode).
        var relDesired = (visibleTopInIframe + margin) - editorDocTop;
        // Stop floating before the canvas would overlap the action bar
        // (Generate / Download) that sits at the bottom of the editor —
        // otherwise the floating canvas covers the CTA at the end of the
        // scroll. Reserve its height in the max travel.
        var actionBar = editor.querySelector(".editor-action-bar");
        var actionH = (actionBar && actionBar.offsetParent !== null) ? actionBar.offsetHeight : 0;
        var maxRel = editor.offsetHeight - stageH - actionH - margin * 2;
        if (relDesired <= 0 || maxRel <= 0 || stageH <= 0) {
          _unfloatCanvas(stage);
          return;
        }
        var relTop = Math.min(relDesired, maxRel);
        ph.style.height = stageH + "px";
        ph.style.display = "block";
        stage.classList.add("is-floating");
        stage.style.position = "absolute";
        stage.style.top = relTop + "px";
        stage.style.left = "0";
        stage.style.right = "0";
        // Above the scrolling editor content (toolbar, sliders, product
        // preview, action bar) but below the feedback FAB (9990).
        stage.style.zIndex = "900";
      });
    }

    if (document.documentElement.classList.contains("embedded")) {
      window.addEventListener("message", function(e) {
        if (PARENT_ORIGIN_ALLOWLIST.indexOf(e.origin) === -1) return;
        if (!e.data || e.data.source !== "solar-archive-parent") return;
        if (e.data.type !== "viewport") return;

        // FAB anchoring (existing behaviour).
        var fab = document.getElementById("feedbackFabGroup");
        var vis = e.data.visibleBottomInIframe;
        if (typeof vis === "number" && isFinite(vis)) _lastVisibleBottom = vis;
        if (fab && typeof vis === "number" && isFinite(vis)) {
          var fabH = fab.offsetHeight || 60;
          // Pin FAB so its BOTTOM aligns with the visible viewport's
          // bottom (with the same 18px margin standalone uses). Clamp
          // to 0 so the FAB never sneaks above the iframe's top.
          var topPx = Math.max(0, vis - fabH - 18);
          fab.style.position = "absolute";
          fab.style.top = topPx + "px";
          fab.style.right = "18px";
          fab.style.bottom = "auto";
          fab.style.left = "auto";
          fab.style.zIndex = "9990";
        }

        // Floating editor canvas (new — only when the parent reports
        // visibleTopInIframe; otherwise the canvas stays static).
        var top = e.data.visibleTopInIframe;
        if (typeof top === "number" && isFinite(top)) {
          _updateFloatingCanvas(top);
        }

        // Sticky-nav scroll offset: how much fixed chrome covers the top
        // of the parent viewport. Drives --sa-scroll-offset so the app's
        // scrollIntoView targets (sections, wavelength grid, editor) land
        // BELOW the storefront's nav instead of tucked under it. +12px
        // breathing room. Falls back to the CSS default until reported.
        var cover = e.data.topCoverPx;
        if (typeof cover === "number" && isFinite(cover)) {
          document.documentElement.style.setProperty("--sa-scroll-offset", (Math.max(0, cover) + 12) + "px");
        }

        // Re-position any floating-centered overlays (data-credits modal,
        // etc.) so they track the user's scroll while open.
        if (_centeredOverlays.length) {
          for (var _i = 0; _i < _centeredOverlays.length; _i++) {
            _centerInVisible(_centeredOverlays[_i]);
          }
        }
      });
    }

    // ── Auto-scroll that respects the parent's sticky nav ───────────
    // In standalone, native scrollIntoView is fine. In the embed the
    // iframe is content-sized and cross-origin, so it can neither scroll
    // itself nor (directly) the parent, and scroll-margin-top isn't
    // honored by the parent's reveal-scroll. So we hand the parent the
    // target's position within the iframe and let IT scroll, offset by
    // the sticky-nav height. Requires the parent's `scrollTo` handler
    // (see the documented snippet); falls back to scrollIntoView if the
    // parent doesn't act.
    function _scrollToEl(el, block) {
      if (!el) return;
      block = block || "start";
      if (document.documentElement.classList.contains("embedded")) {
        try {
          // getBoundingClientRect + scrollHeight force a synchronous
          // reflow, so a just-un-hidden section (e.g. the editor on
          // "Continue") is already laid out here. We send docHeight with
          // the request so the parent sets the iframe height BEFORE
          // scrolling — otherwise it scrolls against a stale (shorter)
          // iframe box and lands on the wrong section.
          var rect = el.getBoundingClientRect();
          var sy = window.pageYOffset || document.documentElement.scrollTop || 0;
          window.parent.postMessage({
            source: "solar-archive",
            type: "scrollTo",
            topInIframe: rect.top + sy,   // element's offset within the iframe document
            height: rect.height,
            docHeight: document.documentElement.scrollHeight,
            block: block
          }, "*");
          return;
        } catch (_e) { /* fall through to native */ }
      }
      try { el.scrollIntoView({ behavior: "smooth", block: block }); }
      catch (_e2) { try { el.scrollIntoView(); } catch (_e3) {} }
    }

    // ── User-resizable editor canvas (proportional + centered) ──────
    // A corner grip lets the user scale the editor canvas to fit their
    // device — the floating embed canvas can otherwise dominate a short
    // viewport. Drives --editor-scale on .image-stage (CSS scales width
    // + height caps; margin:auto keeps it centered). Persisted per
    // device in localStorage; double-click resets. Pointer events cover
    // mouse + touch; the handle stops propagation so it never starts a
    // canvas pan/crop.
    var _EDITOR_SCALE_KEY = "sa_editor_scale";
    // Min editor scale: how small the canvas can shrink. Lowered from
    // 0.4 → 0.2 so users can collapse the canvas to a thumbnail and free
    // screen real estate for the sliders/controls (esp. in the embed
    // where the canvas floats over a short viewport).
    var _EDITOR_SCALE_MIN = 0.2;
    function _curEditorScale(stage) {
      var s = parseFloat(getComputedStyle(stage).getPropertyValue("--editor-scale"));
      return (s > 0 && s <= 1) ? s : 1;
    }
    function _resyncFloatAfterResize() {
      if (typeof _lastVisibleTop === "number" && isFinite(_lastVisibleTop)) {
        _updateFloatingCanvas(_lastVisibleTop);
      }
    }
    function setupEditorResize() {
      var stage = document.getElementById("imageStage");
      if (!stage || stage.querySelector(".editor-resize-handle")) return;
      // Restore saved scale.
      try {
        var saved = parseFloat(localStorage.getItem(_EDITOR_SCALE_KEY));
        if (saved >= _EDITOR_SCALE_MIN && saved <= 1) {
          stage.style.setProperty("--editor-scale", saved.toFixed(3));
        }
      } catch (_e) { /* localStorage blocked — fine, defaults to 1 */ }

      var handle = document.createElement("div");
      handle.className = "editor-resize-handle";
      handle.setAttribute("role", "slider");
      handle.setAttribute("tabindex", "0");
      handle.setAttribute("aria-label",
        "Resize editor. Drag to scale; arrow keys adjust; double-click to reset.");
      handle.setAttribute("aria-valuemin", String(Math.round(_EDITOR_SCALE_MIN * 100)));
      handle.setAttribute("aria-valuemax", "100");
      handle.setAttribute("aria-valuenow", String(Math.round(_curEditorScale(stage) * 100)));
      stage.appendChild(handle);

      var dragging = false, startX = 0, startY = 0, startW = 0, fullW = 0;
      function applyScale(scale) {
        scale = Math.max(_EDITOR_SCALE_MIN, Math.min(1, scale));
        stage.style.setProperty("--editor-scale", scale.toFixed(3));
        handle.setAttribute("aria-valuenow", String(Math.round(scale * 100)));
        _resyncFloatAfterResize();
        return scale;
      }
      function persist(scale) {
        try {
          if (scale >= 0.995) localStorage.removeItem(_EDITOR_SCALE_KEY);
          else localStorage.setItem(_EDITOR_SCALE_KEY, scale.toFixed(3));
        } catch (_e) { /* ignore */ }
      }
      handle.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        try { handle.setPointerCapture(e.pointerId); } catch (_e) {}
        startX = e.clientX; startY = e.clientY;
        // 100% reference = the stage's containing block (the grid cell /
        // positioned editor), measured from the parent's width.
        var parent = stage.parentElement;
        fullW = (parent ? parent.getBoundingClientRect().width : stage.getBoundingClientRect().width) || 1;
        startW = stage.getBoundingClientRect().width;
      });
      handle.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        // Diagonal drag: average the two axes so the corner feels
        // natural (out = bigger, in = smaller).
        var delta = ((e.clientX - startX) + (e.clientY - startY)) / 2;
        applyScale((startW + delta) / fullW);
      });
      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(e.pointerId); } catch (_e) {}
        persist(_curEditorScale(stage));
      }
      handle.addEventListener("pointerup", endDrag);
      handle.addEventListener("pointercancel", endDrag);
      handle.addEventListener("dblclick", function (e) {
        e.preventDefault();
        e.stopPropagation();
        applyScale(1);
        persist(1);
      });
      // Keyboard: arrows nudge ±5%, Home/End jump to min/full.
      handle.addEventListener("keydown", function (e) {
        var cur = _curEditorScale(stage), next = cur;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = cur - 0.05;
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = cur + 0.05;
        else if (e.key === "Home") next = _EDITOR_SCALE_MIN;
        else if (e.key === "End") next = 1;
        else return;
        e.preventDefault();
        persist(applyScale(next));
      });
    }
    setupEditorResize();

    // ── Mobile-only: drag-to-resize the sticky preview pane ──────
    // F16 (audit 2026-05-22, round 3): with image-stage hidden on
    // mobile, the mockup preview is now THE canvas. CSS pins it
    // sticky at top:0; this handle lets the user scale the canvas
    // down to free up viewport for sliders (or back up to inspect
    // detail) without scrolling away from the live preview.
    // Mirrors setupEditorResize() above but targets
    // .selected-product-preview and drives --preview-scale.
    function setupMobilePreviewResize() {
      if (!window.matchMedia || !window.matchMedia("(max-width: 749px)").matches) return;
      var pane = document.getElementById("selectedProductPreview");
      if (!pane || pane.querySelector(".preview-resize-handle")) return;
      var KEY = "sa_preview_scale";
      var MIN = 0.4, MAX = 1.2;
      // Restore saved scale (per device).
      try {
        var saved = parseFloat(localStorage.getItem(KEY));
        if (saved >= MIN && saved <= MAX) {
          pane.style.setProperty("--preview-scale", saved.toFixed(3));
        }
      } catch (_e) { /* localStorage blocked — defaults to 1 */ }

      var handle = document.createElement("div");
      handle.className = "preview-resize-handle";
      handle.setAttribute("role", "slider");
      handle.setAttribute("tabindex", "0");
      handle.setAttribute("aria-label",
        "Resize preview. Drag to scale; arrow keys adjust; double-click to reset.");
      handle.setAttribute("aria-valuemin", String(Math.round(MIN * 100)));
      handle.setAttribute("aria-valuemax", String(Math.round(MAX * 100)));
      pane.appendChild(handle);

      function curScale() {
        var s = parseFloat(getComputedStyle(pane).getPropertyValue("--preview-scale"));
        return (s >= MIN && s <= MAX) ? s : 1;
      }
      function applyScale(s) {
        s = Math.max(MIN, Math.min(MAX, s));
        pane.style.setProperty("--preview-scale", s.toFixed(3));
        handle.setAttribute("aria-valuenow", String(Math.round(s * 100)));
        return s;
      }
      function persist(s) {
        try {
          if (Math.abs(s - 1) < 0.005) localStorage.removeItem(KEY);
          else localStorage.setItem(KEY, s.toFixed(3));
        } catch (_e) {}
      }
      // Seed aria-valuenow.
      handle.setAttribute("aria-valuenow", String(Math.round(curScale() * 100)));

      var dragging = false, startX = 0, startY = 0, startScale = 1;
      handle.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        handle.classList.add("dragging");
        try { handle.setPointerCapture(e.pointerId); } catch (_e) {}
        startX = e.clientX; startY = e.clientY;
        startScale = curScale();
      });
      handle.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        // Average X+Y so the corner feels natural: out (right/down) = bigger.
        // 1.0 of scale ≈ 200 px of diagonal drag (felt right on a 390-px viewport).
        var delta = ((e.clientX - startX) + (e.clientY - startY)) / 2;
        applyScale(startScale + delta / 200);
      });
      function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove("dragging");
        try { handle.releasePointerCapture(e.pointerId); } catch (_e) {}
        persist(curScale());
      }
      handle.addEventListener("pointerup", endDrag);
      handle.addEventListener("pointercancel", endDrag);
      handle.addEventListener("dblclick", function (e) {
        e.preventDefault(); e.stopPropagation();
        persist(applyScale(1));
      });
      handle.addEventListener("keydown", function (e) {
        var cur = curScale(), next = cur;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = cur - 0.05;
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = cur + 0.05;
        else if (e.key === "Home") next = MIN;
        else if (e.key === "End") next = MAX;
        else return;
        e.preventDefault();
        persist(applyScale(next));
      });
    }
    setupMobilePreviewResize();

    // ── Dark mode detection ──────────────────────────────────────
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.classList.add("dark");
    }
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function(event) {
      if (event.matches) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
    });

    // ── State + Phase B manifest ─────────────────────────────────
    // The state singleton and the default-mockup manifest now live in
    // ./state.js. Imported at the top of this file. Reads through the
    // `state` and `defaultMockupManifest` identifiers behave exactly
    // like the previous closure-captured vars; the manifest reassign
    // goes through setDefaultMockupManifest() because `let` bindings
    // are read-only from outside their declaring module.

    // ── Product catalog (Printify blueprint/provider/variant model) ──
    // The PRODUCTS array lives in ./products.js and is imported at the
    // top of this file. previewView (per-product framing for the gallery
    // mockup) is still local — it'll migrate with the mockup module in
    // step 4. See products.js for the catalog rationale + how aspect
    // ratios map to Printify print panels.

    // ── Session catalog (user-requested products) ────────────────
    // Products the user submits via the "Request a product" tab are added
    // here for the current session so they can preview/edit/checkout them
    // without waiting for admin approval. Persisted to sessionStorage so
    // a tab refresh keeps them; they clear on tab close. When an admin
    // approves a submission, the approved_catalog.json entry takes over
    // and dedup logic hides the session entry on next load.
    var SESSION_CATALOG_KEY = "solarArchive.sessionCatalog.v1";
    function loadSessionCatalog() {
      try {
        var raw = sessionStorage.getItem(SESSION_CATALOG_KEY);
        if (!raw) return [];
        var arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (_e) { return []; }
    }
    function saveSessionCatalog(arr) {
      try {
        sessionStorage.setItem(SESSION_CATALOG_KEY, JSON.stringify(arr || []));
      } catch (_e) { /* quota — best effort */ }
    }
    // Build a product-catalog entry from a feedback submission's product_request
    // payload plus the Printify variant details we already fetched to populate
    // the feedback UI.
    function makeProductFromRequest(req, opts) {
      if (!req || !req.blueprintId) return null;
      var id = "user_" + req.blueprintId + "_" + (req.printProviderId || "any");
      var title = req.title || ("Blueprint " + req.blueprintId);
      var ar = (opts && opts.aspectRatio) || { w: 1, h: 1 };
      // Opinionated default so the card renders — admin sets final pricing when approving.
      var price = (opts && opts.price) || "Custom — pricing TBD";
      var checkoutPrice = (opts && opts.checkoutPrice) || 2499;
      // Print-area shape: passed in from the request modal (or carried
      // on the request payload if it's already there). "circle" makes
      // the editor clip the image to a disc and centres the vignette
      // on the inscribed circle, matching how products like the round
      // pet-leash button or wall clock face actually print.
      var printShape =
        (opts && opts.printShape) ||
        (req && req.printShape) ||
        "rectangle";
      return {
        id: id,
        name: title,
        desc: req.variantTitle ? ("Variant: " + req.variantTitle) : "User-requested product",
        icon: printShape === "circle" ? "fa-circle" : "fa-sparkles",
        price: price,
        checkoutPrice: checkoutPrice,
        blueprintId: req.blueprintId,
        printProviderId: req.printProviderId || null,
        variantId: req.variantId || null,
        position: "front",
        aspectRatio: ar,
        printShape: printShape,
        _isUserRequested: true,
      };
    }

    function addToSessionCatalog(entry) {
      if (!entry || !entry.id) return;
      var current = loadSessionCatalog();
      // Dedupe: same id replaces the previous entry rather than stacking.
      var filtered = current.filter(function(p) { return p.id !== entry.id; });
      filtered.push(entry);
      saveSessionCatalog(filtered);
    }

    // Merge session-catalog entries into PRODUCTS at boot so every downstream
    // lookup (renderProducts, selectProductCard, checkout) treats them as
    // normal products.
    (function hydrateSessionCatalog() {
      var sessionEntries = loadSessionCatalog();
      sessionEntries.forEach(function(entry) {
        if (!entry || !entry.id) return;
        // Skip if already present (e.g., after admin approval injected the
        // same entry into the main catalog).
        var existing = PRODUCTS.find(function(p) { return p.id === entry.id || (entry.blueprintId && p.blueprintId === entry.blueprintId && p.printProviderId === entry.printProviderId && !p._isUserRequested); });
        if (existing) return;
        PRODUCTS.push(entry);
      });
    })();

    // Fetch admin-approved catalog additions and merge them into PRODUCTS.
    // Runs at boot; any session-only entry that has since been approved gets
    // the admin copy — visually distinct because _isUserRequested is absent.
    (function hydrateApprovedCatalog() {
      var apiBase = (typeof API_BASE !== "undefined" && API_BASE) ? API_BASE : "";
      fetch(apiBase + "/api/catalog/approved")
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (!data || !Array.isArray(data.entries) || !data.entries.length) return;
          var changed = false;
          data.entries.forEach(function(entry) {
            if (!entry || !entry.id) return;
            // If PRODUCTS already has a non-requested entry for this BP+provider,
            // skip — hard-coded catalog wins for consistency.
            var existing = PRODUCTS.find(function(p) {
              if (p._isUserRequested) return false;
              if (p.id === entry.id) return true;
              return entry.blueprintId && p.blueprintId === entry.blueprintId && p.printProviderId === entry.printProviderId;
            });
            if (existing) return;
            // Remove any session-requested placeholder for this BP+provider
            // so we don't show duplicates once the admin approves.
            for (var i = PRODUCTS.length - 1; i >= 0; i--) {
              var p = PRODUCTS[i];
              if (p._isUserRequested && entry.blueprintId && p.blueprintId === entry.blueprintId && p.printProviderId === entry.printProviderId) {
                PRODUCTS.splice(i, 1);
              }
            }
            PRODUCTS.push(entry);
            changed = true;
          });
          if (changed && typeof renderProducts === "function" && state.originalImage) {
            renderProducts();
          }
        })
        .catch(function(e) { console.warn("[catalog] approved fetch failed:", e); });
    })();

    // Per-product gallery-mockup framing. Each entry picks a distinct subset
    // of the shared solar image (state.originalImage) so the gallery reads as
    // variety — a wall of different views of the Sun — rather than the same
    // crop repeated in different outlines. Values are normalized to the source:
    //   zoom:  1.0 fills the frame with the whole image; >1 zooms in; <1 pads.
    //   cx,cy: 0..1, the normalized center of the source rect.
    // Missing entries fall back to a default derived from aspectRatio at draw
    // time, so adding products later doesn't require updating this map.

    // All product IDs are pre-resolved. Mark catalog as ready immediately.
    var catalogResolved = true;

    // ── Font catalog (lazy-loaded from Google Fonts) ────────────
    var FONT_CATALOG = [
      // Sans-Serif
      { name: "Outfit",           category: "Sans-Serif",  gquery: "Outfit:wght@300;400;500;600;700;800" },
      { name: "Inter",            category: "Sans-Serif",  gquery: "Inter:wght@400;500;700" },
      { name: "Montserrat",       category: "Sans-Serif",  gquery: "Montserrat:wght@400;700;900" },
      { name: "Raleway",          category: "Sans-Serif",  gquery: "Raleway:wght@400;700" },
      { name: "Oswald",           category: "Sans-Serif",  gquery: "Oswald:wght@400;700" },
      // Serif
      { name: "Playfair Display", category: "Serif",       gquery: "Playfair+Display:wght@400;700;900" },
      { name: "Merriweather",     category: "Serif",       gquery: "Merriweather:wght@400;700" },
      { name: "Lora",             category: "Serif",       gquery: "Lora:wght@400;700" },
      // Display
      { name: "Bebas Neue",       category: "Display",     gquery: "Bebas+Neue" },
      { name: "Righteous",        category: "Display",     gquery: "Righteous" },
      { name: "Orbitron",         category: "Display",     gquery: "Orbitron:wght@400;700;900" },
      { name: "Audiowide",        category: "Display",     gquery: "Audiowide" },
      // Handwriting
      { name: "Dancing Script",   category: "Handwriting", gquery: "Dancing+Script:wght@400;700" },
      { name: "Caveat",           category: "Handwriting", gquery: "Caveat:wght@400;700" },
      { name: "Pacifico",         category: "Handwriting", gquery: "Pacifico" },
      // Monospace
      { name: "JetBrains Mono",   category: "Monospace",   gquery: "JetBrains+Mono:wght@400;500;700" },
      { name: "Fira Code",        category: "Monospace",   gquery: "Fira+Code:wght@400;700" },
      { name: "Space Mono",       category: "Monospace",   gquery: "Space+Mono:wght@400;700" }
    ];

    var loadedFonts = {};

    // Pre-load fonts that are actively used (Outfit is default body font, JetBrains Mono in footer)
    // Using link elements directly for these to avoid UI delay when user first opens font menu
    (function preloadDefaultFonts() {
      var link1 = document.createElement("link");
      link1.rel = "stylesheet";
      link1.href = "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap";
      document.head.appendChild(link1);

      var link2 = document.createElement("link");
      link2.rel = "stylesheet";
      link2.href = "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap";
      document.head.appendChild(link2);
    })();

    function loadGoogleFont(fontEntry) {
      if (loadedFonts[fontEntry.name]) return Promise.resolve();
      return new Promise(function(resolve) {
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://fonts.googleapis.com/css2?family=" + fontEntry.gquery + "&display=swap";
        link.onload = function() {
          loadedFonts[fontEntry.name] = true;
          // Give the browser a moment to register the font face
          setTimeout(resolve, 50);
        };
        link.onerror = function() { resolve(); }; // don't block on failure
        document.head.appendChild(link);
      });
    }

    function populateFontSelect() {
      var sel = document.getElementById("textFontSelect");
      if (!sel) return;
      sel.innerHTML = "";
      var categories = {};
      FONT_CATALOG.forEach(function(f) {
        if (!categories[f.category]) categories[f.category] = [];
        categories[f.category].push(f);
      });
      Object.keys(categories).forEach(function(cat) {
        var group = document.createElement("optgroup");
        group.label = cat;
        categories[cat].forEach(function(f) {
          var opt = document.createElement("option");
          opt.value = f.name;
          opt.textContent = f.name;
          group.appendChild(opt);
        });
        sel.appendChild(group);
      });
    }

    function populateClockNumbersFontSelect() {
      var sel = document.getElementById("clockNumbersFontSelect");
      if (!sel) return;
      sel.innerHTML = "";
      var categories = {};
      FONT_CATALOG.forEach(function(f) {
        if (!categories[f.category]) categories[f.category] = [];
        categories[f.category].push(f);
      });
      Object.keys(categories).forEach(function(cat) {
        var group = document.createElement("optgroup");
        group.label = cat;
        categories[cat].forEach(function(f) {
          var opt = document.createElement("option");
          opt.value = f.name;
          opt.textContent = f.name;
          group.appendChild(opt);
        });
        sel.appendChild(group);
      });
    }

    function updateClockNumbersButtonVisibility() {
      var clockTab = document.querySelector('.edit-tab[data-tab="clock"]');
      var clockPanel = document.getElementById("tabPanel_clock");
      if (!clockTab || !clockPanel) return;
      if (state.selectedProduct === "wall_clock") {
        clockTab.classList.remove("hidden");
      } else {
        clockTab.classList.add("hidden");
        // If clock tab was active, switch to Geometry
        if (clockTab.classList.contains("active")) {
          var geometryTab = document.querySelector('.edit-tab[data-tab="geometry"]');
          if (geometryTab) {
            geometryTab.click();
          }
        }
        if (!clockPanel.classList.contains("hidden")) {
          clockPanel.classList.add("hidden");
        }
      }
    }

    // ── DOM refs ─────────────────────────────────────────────────
    var $ = function(sel) { return document.querySelector(sel); };
    var dateInput = $("#solarDate");
    var timeInput = $("#solarTime");

    // Helper: read the time field (HH:MM) and normalise to "HH:MM".
    // Defaults to "12:00" when blank or malformed so backends that don't
    // yet honor the time param see the same noon fallback as before.
    function _solarTimeValue() {
      var raw = (timeInput && timeInput.value) || "";
      var m = /^(\d{1,2}):(\d{2})/.exec(raw);
      if (!m) return "12:00";
      var hh = Math.max(0, Math.min(23, parseInt(m[1], 10) || 0));
      var mm = Math.max(0, Math.min(59, parseInt(m[2], 10) || 0));
      return (hh < 10 ? "0" + hh : "" + hh) + ":" + (mm < 10 ? "0" + mm : "" + mm);
    }
    var wlGrid = $("#wlGrid");
    var progressTrack = $("#progressTrack");
    var progressFill = $("#progressFill");
    var statusMsg = $("#statusMsg");
    var editSection = $("#editSection");
    var imageStage = $("#imageStage");
    var solarImg = $("#solarImg");
    var solarCanvas = $("#solarCanvas");
    // mockups.js needs the editor canvas + the renderCanvas function. Both
    // are owned by this module (canvas is a DOM lookup we just did;
    // renderCanvas is a function-hoisted declaration further down). Pass
    // them through the deps registry now so every later drawProductMockup
    // call has its dependencies satisfied.
    initMockups({ solarCanvas: solarCanvas, renderCanvas: renderCanvas });
    // bundler.js (beta-mode .zip export) needs DOM refs + several helpers.
    // Function refs (renderCanvas, _solarTimeValue, showToast, _scrollToEl,
    // renderProducts) all hoist; vars (API_BASE, CITATIONS) are assigned
    // above. Snapshotting now is safe.
    initBundler({
      solarCanvas:     solarCanvas,
      renderCanvas:    renderCanvas,
      dateInput:       dateInput,
      _solarTimeValue: _solarTimeValue,
      showToast:       showToast,
      API_BASE:        API_BASE,
      CITATIONS:       CITATIONS,
      _scrollToEl:     _scrollToEl,
      renderProducts:  renderProducts,
    });
    var cropOverlay = $("#cropOverlay");
    var productSection = $("#productSection");
    var productGrid = $("#productGrid");
    var checkoutProgress = $("#checkoutProgress");
    var btnBuyInEditor = $("#btnBuyInEditor");
    var orderStatus = $("#orderStatus");
    var toastEl = $("#toast");
    var backendBanner = $("#backendBanner");
    var cspNotice = $("#cspNotice");

    // ── Init date ────────────────────────────────────────────────
    (function initDate() {
      dateInput.min = "2010-05-15";
      var maxD = new Date();
      maxD.setDate(maxD.getDate() - 7);
      dateInput.max = maxD.toISOString().split("T")[0];
      // Hide wavelength tiles until the user actively picks a date.
      updateWavelengthSectionDateState();
    })();

    // ── Birthday Sun CTA wiring ──────────────────────────────────
    // Above-the-fold gifting shortcut: type a date → it populates
    // the canonical date input below, reveals the wavelength grid,
    // and scrolls the user down to it. Beta personas Riley (Gen Z
    // social) and Jordan (founder) both flagged birthday/anniversary
    // as the dominant conversion path; this surfaces it as the
    // primary entry without removing the standard date+wavelength
    // flow underneath.
    (function initBirthdayCta() {
      var form = document.getElementById("birthdayCtaForm");
      var input = document.getElementById("birthdayCtaInput");
      if (!form || !input || !dateInput) return;
      // Mirror the same min/max constraints as the main date input —
      // AIA first light to one week ago.
      input.min = dateInput.min;
      input.max = dateInput.max;
      form.addEventListener("submit", function(e) {
        e.preventDefault();
        var v = (input.value || "").trim();
        if (!v) {
          input.focus();
          return;
        }
        // Push the value into the canonical date input and dispatch
        // a 'change' event so any listeners (wavelength tile reveal,
        // thumb cache warmups, etc.) see it.
        dateInput.value = v;
        dateInput.dispatchEvent(new Event("change", { bubbles: true }));
        // Reveal the wavelength grid + scroll to it so the user
        // sees the next step. wlGrid has the .hidden class until
        // a date is picked; clearing it on change isn't this CTA's
        // job — updateWavelengthSectionDateState() handles it —
        // but we still need to scroll into view.
        var wlGrid = document.getElementById("wlGrid");
        if (wlGrid) {
          try { _scrollToEl(wlGrid, "start"); }
          catch (_e) { wlGrid.scrollIntoView(); }
        }
      });
    })();

    // ── Reorder workflow: product-first, then edit ────────────────
    // Moves the product section before the edit section in the DOM,
    // updates step badge numbers, and sets up the product-first flow.
    function reorderWorkflow() {
      var container = productSection.parentNode;
      // Move product section before edit section in DOM order
      container.insertBefore(productSection, editSection);
      // Update step badge numbers
      productSection.querySelector(".step-badge").textContent = "2";
      editSection.querySelector(".step-badge").textContent = "3";
      // Both sections start hidden; productSection shown when wavelength selected,
      // editSection shown when a product card is clicked.
    }
    reorderWorkflow();

    // ── Context-aware product-section header ─────────────────────
    // When the editor is open, the product grid below the editor reads as
    // "also consider these" inspiration — not the primary chooser. Swap the
    // title and intro copy accordingly so it stops nagging the user to pick.
    function updateProductSectionHeader() {
      var title = document.getElementById("productSectionTitle");
      var intro = document.getElementById("productSectionIntro");
      if (!title || !intro) return;
      var editorOpen = editSection && !editSection.classList.contains("hidden");
      if (editorOpen && state.selectedProduct) {
        title.textContent = "Product examples";
        intro.innerHTML = "Your image looks great on all of these. Click any card to switch your selection \u2014 or stick with what you have and scroll up to check out.";
      } else {
        title.textContent = "Choose your product";
        intro.innerHTML = "Click a product to expand its variants, pick a size/color, then <strong>Select this product</strong> to open the editor. You'll finish checkout on Shopify.";
      }
    }

    // ── Product selection via event delegation ──────────────────
    function selectProductCard(productId) {
      var product = PRODUCTS.find(function(p) { return p.id === productId; });
      if (!product) return;

      state.selectedProduct = productId;

      // Clear clock numbers when switching away from wall_clock
      if (productId !== "wall_clock" && state.clockNumbers) {
        state.clockNumbers = null;
        var clockPanel = document.getElementById("tabPanel_clock");
        if (clockPanel) clockPanel.classList.add("hidden");
      }

      // Update selected visual state on product cards
      productGrid.querySelectorAll(".product-card").forEach(function(c) { c.classList.remove("selected"); });
      var selectedCard = productGrid.querySelector('.product-card[data-product-id="' + productId + '"]');
      if (selectedCard) selectedCard.classList.add("selected");

      // Determine crop ratio from effective aspect ratio (variant-specific if loaded, else product default)
      var ar0 = getEffectiveAspectRatio(product);
      var ratio = ar0 ? (ar0.w + ":" + ar0.h) : "1:1";
      state.cropRatio = ratio;

      // Reset pan to ref center, zoom 100% so the fixed frame shows centered image
      var ref = state.originalImage;
      if (ref) {
        var rw = state.rotation % 180 !== 0 ? ref.naturalHeight : ref.naturalWidth;
        var rh = state.rotation % 180 !== 0 ? ref.naturalWidth : ref.naturalHeight;
        state.panX = rw / 2;
        state.panY = rh / 2;
      } else {
        state.panX = 0;
        state.panY = 0;
      }
      // Default cropZoom = 100 (image cover-fits the canvas). A product
      // may override with `initialCropZoom` when its print panel is so
      // extreme that the default leaves big empty bands — e.g. crew
      // socks (1:2.83) zoom to ~136 so the canvas shows the largest
      // sock-aspect rectangle inscribed within the solar disk.
      var initialZoom = (typeof product.initialCropZoom === "number" && product.initialCropZoom > 0)
        ? product.initialCropZoom
        : 100;
      state.cropZoom = initialZoom;
      var cropSlider = $("#cropSlider");
      var cropVal = $("#cropVal");
      if (cropSlider) { cropSlider.value = initialZoom; }
      if (cropVal) { cropVal.textContent = initialZoom + "%"; }

      // Show variant options for this product (no scroll, no edit section reveal)
      if (selectedCard) showVariantPanel(product, selectedCard);

      var toastAR = getEffectiveAspectRatio(product);
      if (toastAR) {
        showToast("Editing for " + product.name + " (" + toastAR.w + ":" + toastAR.h + ")");
      }

      // Resize preview pane to product aspect ratio, then redraw canvas (so both match selection)
      if (typeof updateSelectedProductPreview === "function") updateSelectedProductPreview(product);
      if (typeof updateClockNumbersButtonVisibility === "function") updateClockNumbersButtonVisibility();
      if (typeof renderCanvas === "function") renderCanvas();
    }

    // Event delegation on the product grid (and the user-requested grid, so
    // requested-product cards behave identically to catalog cards). Clicking
    // anywhere on the card toggles its variant pane — same action as the
    // Select disclosure button — so the whole card is a single, forgiving
    // target for "show me the variants of this."
    function _bindGridEvents(gridEl) {
      if (!gridEl) return;
      // Card body (non-button) click + Enter both go to the modal picker too,
      // so the entire card is a consistent "open the variant chooser" target.
      // Variant-panel internals still bubble through their own handlers; the
      // disclosure button's own click handler runs first when clicking it.
      function _cardOpenPicker(card) {
        var productId = card.dataset.productId;
        if (!productId) return;
        var product = PRODUCTS.find(function(p) { return p.id === productId; });
        if (!product) return;
        var btn = card.querySelector(".product-select-btn");
        if (btn && btn.disabled) return;
        if (!state.originalImage || !product.blueprintId || !product.printProviderId) return;
        // Merged product (e.g. mug): pick a colour first, which resolves to
        // the real child product, then run the normal commit/editor flow.
        if (product.colorOptions && product.colorOptions.length > 1 &&
            typeof showColorChooser === "function") {
          showColorChooser(product);
          return;
        }
        showConfirmSelectModal(product, function() { commitProductSelection(product); });
      }
      gridEl.addEventListener("click", function(e) {
        if (e.target.closest(".variant-panel")) return;
        if (e.target.closest(".product-buy-btn")) return;
        var card = e.target.closest(".product-card");
        if (!card) return;
        _cardOpenPicker(card);
      });
      gridEl.addEventListener("keydown", function(e) {
        var card = e.target.closest(".product-card");
        if (!card || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        e.stopPropagation();
        _cardOpenPicker(card);
      });
    }
    _bindGridEvents(productGrid);
    _bindGridEvents(document.getElementById("userRequestsGrid"));

    // ── Side-by-side product preview — persistent canvas approach ──
    // livePreviewCanvas is created once on product selection and reused
    // on every renderCanvas() call so edits are reflected in real-time
    // without any DOM churn.
    var livePreviewCanvas = null;

    // ── Preview pane: extend sticky tracking past the editor row ──
    // .selected-product-preview uses position: sticky inside the
    // flex row .editor-with-preview. Once the row has fully scrolled
    // past its sticky range, the pane releases and scrolls away —
    // but the user wants to keep seeing it as they continue down
    // the page (into the product picker, footer, etc.). When the
    // sticky range is exhausted we add .preview-pinned to switch to
    // position: fixed, with explicit left/width captured from the
    // pane's last natural rect so it stays in its column. Going back
    // up reverses the switch.
    var _previewPaneNaturalGeom = null;
    var _previewPaneRaf = 0;
    function _updatePreviewPanePinning() {
      var preview = document.getElementById("selectedProductPreview");
      if (!preview) return;
      // Hidden / not selected → reset and bail.
      if (preview.classList.contains("hidden")) {
        preview.classList.remove("preview-pinned");
        preview.style.left = "";
        preview.style.width = "";
        preview.style.top = "";
        _previewPaneNaturalGeom = null;
        return;
      }
      // Narrow screens stack vertically (see media query in CSS) — no
      // pinning needed; let the natural document flow handle it.
      if (window.innerWidth <= 740) {
        preview.classList.remove("preview-pinned");
        preview.style.left = "";
        preview.style.width = "";
        preview.style.top = "";
        return;
      }
      var parent = preview.parentElement;  // .editor-with-preview
      if (!parent) return;
      var parentRect = parent.getBoundingClientRect();
      var paneHeight = preview.offsetHeight;
      var TOP_GAP = 20;  // matches the CSS top: 20px

      // Sticky is still doing its job while the parent's bottom edge
      // is below where the pane's top would land if pinned.
      var stickyValid = (parentRect.bottom >= TOP_GAP + paneHeight);

      if (stickyValid) {
        // Capture the pane's natural geometry every frame so we know
        // where to anchor when sticky eventually releases.
        var rect = preview.getBoundingClientRect();
        // Width / left only meaningful when not in pinned mode.
        if (!preview.classList.contains("preview-pinned")) {
          _previewPaneNaturalGeom = { left: rect.left, width: rect.width };
        }
        preview.classList.remove("preview-pinned");
        preview.style.left = "";
        preview.style.width = "";
        preview.style.top = "";
      } else if (_previewPaneNaturalGeom) {
        // Past the sticky parent — pin to viewport with captured geom.
        // Clamp the top so the pane doesn't run over the footer; once
        // we'd overlap, allow it to ride up so its bottom touches the
        // footer's top (then scrolls off-screen with the page).
        var top = TOP_GAP;
        var footer = document.querySelector(".app-footer");
        if (footer) {
          var footerRect = footer.getBoundingClientRect();
          var maxTop = footerRect.top - paneHeight - 10;
          if (top > maxTop) top = maxTop;
        }
        preview.classList.add("preview-pinned");
        preview.style.top = top + "px";
        preview.style.left = _previewPaneNaturalGeom.left + "px";
        preview.style.width = _previewPaneNaturalGeom.width + "px";
      }
    }
    function _schedulePreviewPanePin() {
      if (_previewPaneRaf) return;
      _previewPaneRaf = requestAnimationFrame(function() {
        _previewPaneRaf = 0;
        _updatePreviewPanePinning();
      });
    }
    window.addEventListener("scroll", _schedulePreviewPanePin, { passive: true });
    window.addEventListener("resize", _schedulePreviewPanePin);
    // Layout-changing events that affect the natural slot's geometry:
    // wait one frame so flex has reflowed, then resync.
    function _resyncPreviewPaneSoon() {
      requestAnimationFrame(function() {
        _previewPaneNaturalGeom = null;
        _updatePreviewPanePinning();
      });
    }

    // Called once when the user selects a product: sets labels and creates
    // the persistent canvas inside the preview pane.
    function updateSelectedProductPreview(product) {
      var previewPane = document.getElementById("selectedProductPreview");
      // Sticky bottom action bar (contains btnPreviewMockup +
      // btnBuyInEditor). Lives in its own DOM region now, so we
      // toggle its visibility in lockstep with the preview pane —
      // the action bar only makes sense once a product is selected.
      var actionBar = document.getElementById("editorActionBar");
      if (!previewPane) return;
      if (!product) {
        previewPane.classList.add("hidden");
        if (actionBar) actionBar.classList.add("hidden");
        livePreviewCanvas = null;
        if (typeof _resyncPreviewPaneSoon === "function") _resyncPreviewPaneSoon();
        return;
      }
      previewPane.classList.remove("hidden");
      if (actionBar) actionBar.classList.remove("hidden");
      // Pane just became visible — re-measure its natural geometry on
      // the next frame so pinning has the right left/width to capture.
      if (typeof _resyncPreviewPaneSoon === "function") _resyncPreviewPaneSoon();
      previewPane.querySelector(".preview-product-name").textContent = product.name;
      var ar = getEffectiveAspectRatio(product);
      var arSimple = ar ? simplifyAspectRatio(ar.w, ar.h) : null;
      var ratioText = arSimple ? arSimple.w + ":" + arSimple.h : "flexible";
      previewPane.querySelector(".preview-product-ratio").textContent = "Aspect ratio: " + ratioText;

      // Update create button label. Price intentionally omitted — the price
      // lives in the preview pane; a "create" button that also shows price
      // reads as "buy now" to beta testers and blurs the create vs. purchase
      // steps (purchase happens on Shopify after this).
      // In beta mode the button is a local "Download Your Design" — leave
      // the label untouched and let _applyBetaModeUI() reassert it.
      var buyLabel = document.getElementById("btnBuyLabel");
      if (buyLabel && !BETA_MODE) {
        buyLabel.textContent = "Create on Shopify";
      }
      if (BETA_MODE && typeof _applyBetaModeUI === "function") _applyBetaModeUI();

      // Create (or reuse) the persistent preview canvas.
      // Always use a square canvas — the product shape drawn inside it communicates
      // the proportions without distorting the illustration by squashing the canvas itself.
      // 2026-05-22: on mobile (≤749 px) the preview pane becomes the
      // PRIMARY visual (image-stage is hidden via CSS), so pump the
      // backing-store resolution to keep the upscaled render crisp.
      var mockupContainer = previewPane.querySelector(".preview-mockup");
      var existing = mockupContainer.querySelector("canvas.live-preview-canvas");
      var _isMobileEditor = window.matchMedia && window.matchMedia("(max-width: 749px)").matches;
      var pw = _isMobileEditor ? 360 : 260;
      var ph = pw;
      if (!existing) {
        mockupContainer.innerHTML = "";
        existing = document.createElement("canvas");
        existing.className = "live-preview-canvas";
        existing.width = pw;
        existing.height = ph;
        mockupContainer.appendChild(existing);
      } else {
        existing.width = pw;
        existing.height = ph;
      }
      // Circular preview for round products — wall_clock plus any user-
      // requested product tagged with `printShape === "circle"`.
      if (product.id === "wall_clock" || product.printShape === "circle") {
        existing.classList.add("circular");
      } else {
        existing.classList.remove("circular");
      }
      livePreviewCanvas = existing;

      // Variant selector: load variants and show dropdown so user can override in place
      updatePreviewVariantSelector(product);
      // Dual-panel layout toggle: only shown for throw_pillow / journal
      updatePreviewLayoutToggle(product);
      // Draw immediately so the preview isn't blank on first select
      refreshLivePreview();
      updatePreviewPaneMockupState();
    }

    // Redraw the preview pane fake mockup: same product shape as grid cards (with variant), scaled to fit.
    function refreshLivePreview() {
      if (!livePreviewCanvas || !state.originalImage || solarCanvas.width === 0) return;
      var product = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
      if (!product) return;

      var pw = livePreviewCanvas.width;
      var ph = livePreviewCanvas.height;
      var lctx = livePreviewCanvas.getContext("2d");
      lctx.clearRect(0, 0, pw, ph);

      // Scale the 160×160 mockup coordinate space to fill the square canvas.
      // Using the full canvas dimension (pw/160) so the illustration is as large as possible.
      var scale = pw / 160;
      lctx.save();
      lctx.scale(scale, scale);
      var variant = getSelectedVariantForProduct(product.id);
      drawProductMockup(lctx, product.id, 160, 160, variant);
      lctx.restore();
    }

    function updatePreviewPaneMockupState() {
      var previewPane = document.getElementById("selectedProductPreview");
      var btn = document.getElementById("btnPreviewMockup");
      if (!previewPane || !btn) return;
      if (!state.selectedProduct) return;
      var productId = state.selectedProduct;
      var hasRealMockup = state.mockups[productId] && state.mockups[productId].images && state.mockups[productId].images.length > 0;
      var mockupContainer = previewPane.querySelector(".preview-mockup");
      var labelEl = btn.querySelector(".btn-preview-mockup-label");

      if (hasRealMockup) {
        var images = state.mockups[productId].images;
        var slideIdx = state.mockupSlideIndex[productId] || 0;
        if (slideIdx >= images.length) slideIdx = 0;
        state.mockupSlideIndex[productId] = slideIdx;

        // Hide canvas preview
        var canvasEl = mockupContainer.querySelector("canvas.live-preview-canvas");
        if (canvasEl) canvasEl.style.display = "none";

        // Build slideshow container if needed
        var slideshow = mockupContainer.querySelector(".mockup-slideshow");
        if (!slideshow) {
          slideshow = document.createElement("div");
          slideshow.className = "mockup-slideshow";

          var slideImg = document.createElement("img");
          slideImg.className = "preview-real-mockup";
          slideImg.alt = "Real mockup";
          slideshow.appendChild(slideImg);

          // Translucent "loading next mockup" overlay. Printify's CDN takes
          // noticeable time to serve a fresh mockup — without this, clicking
          // next/prev left the stale image on screen during the fetch and
          // the UI felt broken. Shown on nav-click, hidden on img load/error.
          var slideLoader = document.createElement("div");
          slideLoader.className = "slide-loader hidden";
          slideLoader.innerHTML = '<span class="slide-spinner"></span>';
          slideshow.appendChild(slideLoader);

          var prevBtn = document.createElement("button");
          prevBtn.className = "slide-nav slide-prev";
          prevBtn.innerHTML = "&#8249;";
          prevBtn.setAttribute("aria-label", "Previous mockup");
          slideshow.appendChild(prevBtn);

          var nextBtn = document.createElement("button");
          nextBtn.className = "slide-nav slide-next";
          nextBtn.innerHTML = "&#8250;";
          nextBtn.setAttribute("aria-label", "Next mockup");
          slideshow.appendChild(nextBtn);

          var slideCounter = document.createElement("div");
          slideCounter.className = "slide-counter";
          slideshow.appendChild(slideCounter);

          // Wire load/error on the single <img> so any subsequent src change
          // (from either button) clears the loader when the new image lands.
          function hideSlideLoader() { slideLoader.classList.add("hidden"); }
          function showSlideLoader() { slideLoader.classList.remove("hidden"); }
          slideImg.addEventListener("load", hideSlideLoader);
          slideImg.addEventListener("error", hideSlideLoader);

          function navSlide(delta) {
            var pid = state.selectedProduct;
            var imgs = state.mockups[pid] && state.mockups[pid].images || [];
            if (imgs.length < 2) return;
            var idx = (state.mockupSlideIndex[pid] || 0) + delta;
            if (idx < 0) idx = imgs.length - 1;
            if (idx >= imgs.length) idx = 0;
            state.mockupSlideIndex[pid] = idx;
            showSlideLoader();
            var imgEl = slideshow.querySelector(".preview-real-mockup");
            imgEl.src = imgs[idx].src;
            slideshow.querySelector(".slide-counter").textContent = (idx + 1) + " / " + imgs.length;
            // If the browser served the image from cache, load may have
            // already fired before we attached the listener for this change.
            if (imgEl.complete && imgEl.naturalWidth > 0) hideSlideLoader();
          }

          prevBtn.addEventListener("click", function() { navSlide(-1); });
          nextBtn.addEventListener("click", function() { navSlide(+1); });

          mockupContainer.appendChild(slideshow);
        }

        // Update current slide
        slideshow.querySelector(".preview-real-mockup").src = images[slideIdx].src;
        slideshow.style.display = "";

        var ctrEl = slideshow.querySelector(".slide-counter");
        var prevBtnEl = slideshow.querySelector(".slide-prev");
        var nextBtnEl = slideshow.querySelector(".slide-next");
        if (images.length > 1) {
          ctrEl.textContent = (slideIdx + 1) + " / " + images.length;
          ctrEl.style.display = "";
          prevBtnEl.style.display = "";
          nextBtnEl.style.display = "";
        } else {
          ctrEl.style.display = "none";
          prevBtnEl.style.display = "none";
          nextBtnEl.style.display = "none";
        }

        // Mobile (image-stage hidden): "View live edit" reads more
        // clearly than "Reset to mock mockup" — on a phone the
        // preview pane IS the canvas, so the toggle is the back-out
        // affordance Gilly described in the audit.
        var _isMobileLbl = window.matchMedia && window.matchMedia("(max-width: 749px)").matches;
        if (labelEl) labelEl.textContent = _isMobileLbl ? "Back to live edit" : "Reset to mock mockup";
        btn.title = "Switch back to the live canvas preview.";
      } else {
        var slideshowEl = mockupContainer.querySelector(".mockup-slideshow");
        if (slideshowEl) slideshowEl.style.display = "none";
        var canvasEl = mockupContainer.querySelector("canvas.live-preview-canvas");
        if (canvasEl) canvasEl.style.display = "";
        if (labelEl) labelEl.textContent = "Generate real mockup";
        btn.title = "Generate a real Printify mockup for this product.";
      }
    }

    // ── Deselect product (✕ button in the preview panel) ────────
    var btnDeselectProduct = document.getElementById("btnDeselectProduct");
    if (btnDeselectProduct) {
      btnDeselectProduct.addEventListener("click", function() {
        state.selectedProduct = null;
        state.uploadedPrintifyId = null;
        state.uploadedPrintifyIdRaw = null;
        state.uploadedPrintifyIdFiltered = null;
        var previewPanel = document.getElementById("selectedProductPreview");
        if (previewPanel) previewPanel.classList.add("hidden");
        // Hide the sticky action bar too — its buttons only apply
        // when a product is selected.
        var actionBar = document.getElementById("editorActionBar");
        if (actionBar) actionBar.classList.add("hidden");
        if (editSection) editSection.classList.add("hidden");
        renderCanvas();
        updateProductSectionHeader();
        var productSection = document.getElementById("productSection");
        if (productSection) _scrollToEl(productSection, "start");
      });
    }

    // ── Change wavelength navigation button (in Adjust tab) ─────
    var btnChangeWavelength = document.getElementById("btnChangeWavelength");
    if (btnChangeWavelength) {
      btnChangeWavelength.addEventListener("click", function() {
        var wlGrid = document.getElementById("wlGrid");
        var target = wlGrid || document.querySelector(".section");
        if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
        else window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }

    // Re-open the variant picker for the currently-selected product.
    // Falls back to clicking the matching product card's "Pick a
    // variant" button if showConfirmSelectModal isn't reachable yet
    // (it's defined later in the IIFE; the button lookup runs at
    // page-init time but the click handler runs much later).
    var btnChangeVariant = document.getElementById("btnChangeVariant");
    if (btnChangeVariant) {
      btnChangeVariant.addEventListener("click", function() {
        if (!state.selectedProduct) {
          showToast("Pick a product first.");
          return;
        }
        var product = (typeof PRODUCTS !== "undefined")
          ? PRODUCTS.find(function(p) { return p.id === state.selectedProduct; })
          : null;
        // For a merged product (mug), "Change variant" should re-open the
        // colour chooser so the user can switch White↔Black, not the
        // single-variant modal of whichever colour is active.
        var _mergedParent = (typeof PRODUCTS !== "undefined") ? PRODUCTS.find(function(pp) {
          return pp.colorOptions && pp.colorOptions.some(function(c) { return c.productId === state.selectedProduct; });
        }) : null;
        if (_mergedParent && typeof showColorChooser === "function") {
          showColorChooser(_mergedParent);
          return;
        }
        if (product && typeof showConfirmSelectModal === "function") {
          // Direct modal entry. onContinue is a no-op — the modal's
          // own logic re-selects the variant and updates the editor.
          showConfirmSelectModal(product, function() { /* committed inside modal */ });
          return;
        }
        // Fallback: synth-click the product card's Pick-a-variant
        // button. Works for any layout the modal-direct path doesn't.
        var card = document.querySelector('.product-card[data-product-id="' + state.selectedProduct + '"]');
        var pick = card && card.querySelector(".product-select-btn");
        if (pick) pick.click();
        else showToast("Variant picker isn't ready yet — try again in a moment.");
      });
    }

    var btnChangeProduct = document.getElementById("btnChangeProduct");
    if (btnChangeProduct) {
      btnChangeProduct.addEventListener("click", function() {
        // Scroll the top of the product picker into view. productSection is
        // re-ordered to appear below the editor, so we need to target its
        // header explicitly rather than relying on document order.
        var productSec = document.getElementById("productSection");
        if (productSec) _scrollToEl(productSec, "start");
      });
    }

    var btnPreviewMockup = document.getElementById("btnPreviewMockup");
    if (btnPreviewMockup) {
      // ── Button loading-state helpers ──────────────────────────
      // The button shows a spinner + "Generating mockup…" label while
      // a generation is in flight. We track the call with a token so a
      // stale settle from an aborted run can't clear a fresh spinner.
      var _mockupCallToken = 0;
      // Hard ceiling: if onDone never fires (e.g. a fetch hangs past
      // its own 90s timeout) we still clear the spinner after this
      // long so the button isn't stuck forever. Generous because the
      // upload+mockup chain can take ~60s for big canvases.
      var MOCKUP_BUTTON_WATCHDOG_MS = 150000;
      var _mockupWatchdog = null;
      function _setMockupBtnLoading(loading) {
        var labelEl = btnPreviewMockup.querySelector(".btn-preview-mockup-label");
        if (loading) {
          btnPreviewMockup.classList.add("is-loading");
          btnPreviewMockup.setAttribute("aria-busy", "true");
          btnPreviewMockup.disabled = true;
          if (labelEl) labelEl.textContent = "Generating mockup…";
        } else {
          btnPreviewMockup.classList.remove("is-loading");
          btnPreviewMockup.removeAttribute("aria-busy");
          btnPreviewMockup.disabled = false;
          // Don't force the label here — updatePreviewPaneMockupState()
          // resets it to either "Generate real mockup" or "Reset to mock
          // mockup" based on whether the cache landed.
          if (typeof updatePreviewPaneMockupState === "function") updatePreviewPaneMockupState();
        }
      }
      btnPreviewMockup.addEventListener("click", function() {
        // Belt-and-suspenders double-click guard. A QA tester flagged
        // "Disable+spinner on mousedown, not after fetch resolves"
        // because a rapid double-tap on the live storefront would
        // fire two Printify product-create jobs — that's REAL MONEY
        // per click. We disable as the literal first action of the
        // handler so even synchronous slow-paths (DOM lookups,
        // conditional branches below) can't open a window for a
        // second click to slip in before _setMockupBtnLoading(true).
        if (btnPreviewMockup.disabled || btnPreviewMockup.dataset.busy === "1") return;
        btnPreviewMockup.dataset.busy = "1";
        function _unbusy() { btnPreviewMockup.dataset.busy = ""; }
        if (!state.selectedProduct) { _unbusy(); return; }
        var productId = state.selectedProduct;
        var hasRealMockup = state.mockups[productId] && state.mockups[productId].images && state.mockups[productId].images.length > 0;
        if (hasRealMockup) {
          delete state.mockups[productId];
          delete state.mockupsRaw[productId];
          delete state.mockupsFiltered[productId];
          if (typeof renderProducts === "function") renderProducts();
          updatePreviewPaneMockupState();
          refreshLivePreview();
          if (typeof updateBuyButtonState === "function") updateBuyButtonState();
          showToast("Reset to mock mockup — preview matches canvas again.");
          _unbusy();
        } else {
          // FITS-quality gate: don't burn a Printify mockup on a JPG-
          // resolution canvas, and warn the user if HQ is still
          // rendering. The gate fires the callback synchronously on
          // hq_ready, asynchronously (via confirm modal) on mq_ready,
          // and not at all on jpg_only / no_image (which show their
          // own info modal). The mockup work moves into
          // _proceedWithMockup() so it can fire from either path.
          function _proceedWithMockup() {
            // Disable the button BEFORE any further work so a second click
            // can't sneak in between the conditionals above and the
            // _setMockupBtnLoading(true) call below.
            btnPreviewMockup.disabled = true;
            // Determine the correct variant bucket from the active filter.
            //   "jpg" / "raw" science  →  "raw"   (non-filtered Helioviewer/science slot)
            //   "rhef"                 →  "filtered" (science-processed slot)
            var mockupVariant = (state.editorFilter === "rhef") ? "filtered" : "raw";

            // ALWAYS clear the cached upload ID for this variant before generating
            // a single-product mockup.  Without this, if the user resets and regenerates
            // (or changes the filter between attempts), the old upload ID for a stale
            // canvas export would be reused instead of uploading the current canvas.
            var mkUploadKey = (mockupVariant === "filtered") ? "uploadedPrintifyIdFiltered" : "uploadedPrintifyIdRaw";
            state[mkUploadKey] = null;
            if (mockupVariant === "raw") state.uploadedPrintifyId = null; // legacy alias

            if (typeof autoGenerateMockups === "function") {
              _setMockupBtnLoading(true);
              var myToken = ++_mockupCallToken;
              if (_mockupWatchdog) clearTimeout(_mockupWatchdog);
              _mockupWatchdog = setTimeout(function() {
                // Clear the busy/loading state UNCONDITIONALLY. Tom QA
                // round-2: if a stale token's clearTimeout lost the race
                // (timer already queued before the next click cleared it),
                // the old token-gated branch skipped _unbusy() and the
                // button stayed dataset.busy="1" forever — user had to
                // reload. Un-busying when already clear is harmless.
                _setMockupBtnLoading(false);
                _unbusy();
                // Only the CURRENT call should paint the "taking longer"
                // status — a superseded call's watchdog must not stomp on
                // fresh state.
                if (myToken === _mockupCallToken) {
                  if (mockupStatus && !mockupStatus.querySelector(".fa-check-circle")) {
                    // Static string — no interpolation, no escape needed.
                    mockupStatus.innerHTML = '<span style="color:var(--accent-sun);font-size:12px;"><i class="fas fa-exclamation-triangle"></i> Mockup is taking longer than expected — try again.</span>';
                  }
                }
              }, MOCKUP_BUTTON_WATCHDOG_MS);
              autoGenerateMockups(mockupVariant, productId, function(err) {
                // Drop late callbacks from prior clicks.
                if (myToken !== _mockupCallToken) return;
                if (_mockupWatchdog) { clearTimeout(_mockupWatchdog); _mockupWatchdog = null; }
                _setMockupBtnLoading(false);
                _unbusy();
                if (err) {
                  // Surface a short toast in addition to the mockupStatus
                  // bar so testers don't have to hunt for the error.
                  showToast("Mockup failed: " + (err.message || "unknown error"));
                }
              });
            }
            showToast("Generating real mockup for this product…");
          }

          if (typeof _gatePrintQuality === "function") {
            _gatePrintQuality(function(ok) {
              if (!ok) { _unbusy(); return; }
              _proceedWithMockup();
            });
            return;  // wait for gate callback
          }
          _proceedWithMockup();
        }
      });
    }

    // ── Wavelength selection + instant Helioviewer preview ───────
    wlGrid.addEventListener("click", function(e) {
      var card = e.target.closest(".wl-card");
      if (!card) return;
      wlGrid.querySelectorAll(".wl-card").forEach(function(c) { c.classList.remove("selected"); });
      card.classList.add("selected");
      state.wavelength = parseInt(card.dataset.wl, 10);
      // User picked their own wavelength — landing default no longer
      // active, so product tiles stop using the pre-rendered Printify
      // mockups (which were rendered against the default image) and
      // fall back to live canvas mockups of the user's actual image.
      if (state.wavelength !== 193) state.isDefaultActive = false;

      if (!dateInput.value) {
        showToast("Select a date first", "error");
        return;
      }

      // Request a scroll to the product section once it becomes visible.
      // Suppressed via state.suppressNextProductScroll (one-shot) when
      // the wavelength tile is being clicked programmatically by the
      // vibe-card flow — in that case we want the user to land on
      // section 1 (the HEK picker) NOT scrolled past it to the products.
      if (state.suppressNextProductScroll) {
        state.suppressNextProductScroll = false;
      } else {
        var productSectionEl = document.getElementById("productSection");
        if (productSectionEl && !productSectionEl.classList.contains("hidden")) {
          _scrollToEl(productSectionEl, "start");
        } else {
          state.scrollToProductsOnLoad = true;
        }
      }

      loadHelioviewerPreview(state.wavelength, dateInput.value);
    });

    /**
     * Load a Helioviewer image into the preview canvas when a tile is clicked.
     *
     * Strategy (fastest-first):
     *   1. Reuse the already-loaded thumbnail canvas from thumbCache (instant, no network).
     *      Apply RHEF from cache if toggled, or compute on demand.
     *   2. If thumbnail not yet cached, fetch via proxy at image_scale=12, size=256
     *      (same params that work for the thumbnail grid).
     *
     * In both cases the canvas is exported to a data-URL and installed as state.originalImage
     * so all editing tools work normally on it.
     */
    // ── Retry helper for transient network failures ──────────────
    function fetchWithRetry(url, options, maxRetries, retryDelay) {
      maxRetries = maxRetries || 3;
      retryDelay = retryDelay || 1000;

      function attemptFetch(remaining) {
        return fetch(url, options).catch(function(err) {
          if (remaining <= 0) throw err;
          return new Promise(function(resolve) {
            setTimeout(function() {
              resolve(attemptFetch(remaining - 1));
            }, retryDelay);
          });
        });
      }
      return attemptFetch(maxRetries);
    }

    function loadHelioviewerPreview(wl, dateVal) {
      setStatus('<i class="fas fa-spinner fa-spin"></i> Loading ' + wl + ' Å preview…', true);
      setProgress(10);
      // Show a visible spinner overlay on the image stage so the
      // canvas doesn't look frozen between tile click and image
      // arrival. Cleared in _installPreviewImage and in the error
      // path below. Tester report: "the wavelength tile had to be
      // clicked a couple of times before the images populated."
      var _stage = document.getElementById("imageStage");
      if (_stage) {
        _stage.classList.add("loading");
        _stage.classList.remove("empty");
      }

      // Get raw canvas from thumbCache or fetch fresh
      var cached = thumbCache[String(wl)];
      if (cached && cached.canvas2048) {
        _startPreviewFromCanvas(cached.canvas2048, cached, wl, dateVal);
      } else {
        // Fetch preview for main canvas via backend proxy (512px — fast & reliable from Helioviewer,
        // image_scale=12 → ~1.5 R☉ FOV). 2048px was unreliable; 512px is sufficient for editing.
        var isoDate = dateVal + "T" + _solarTimeValue() + ":00Z";
        var url = API_BASE + "/api/helioviewer_thumb?date=" +
          encodeURIComponent(isoDate) + "&wavelength=" + wl +
          "&image_scale=12&size=512";

        var img = new Image();
        img.onload = function() {
          var rawC = document.createElement("canvas");
          rawC.width = img.naturalWidth || 512;
          rawC.height = img.naturalHeight || 512;
          rawC.getContext("2d").drawImage(img, 0, 0);
          var entry = thumbCache[String(wl)] || { raw: null, rhef: null, canvas2048: null };
          entry.canvas2048 = rawC;
          thumbCache[String(wl)] = entry;
          _startPreviewFromCanvas(rawC, entry, wl, dateVal);
        };
        img.onerror = function() {
          // Image onerror doesn't expose the HTTP status, so re-query the same
          // URL via fetch() to distinguish upstream Helioviewer failures (502
          // from the backend proxy) from real user-network / backend-down
          // cases. Beta testers saw the generic message and assumed their
          // network was broken when it was actually Helioviewer upstream.
          fetch(url, { method: "GET", cache: "no-store" })
            .then(function(r) {
              var msg;
              if (r.status === 502 || r.status === 503 || r.status === 504) {
                msg = "Helioviewer's data service is temporarily unavailable. " +
                      "Try another wavelength, or retry in a minute.";
              } else if (!r.ok) {
                msg = "Preview failed (HTTP " + r.status + "). Try another date or wavelength.";
              } else {
                // Fetch says OK but <img> onerror fired — likely a decode issue.
                msg = "Preview failed — the image couldn't be decoded. Try another wavelength.";
              }
              showPreviewError(msg);
            })
            .catch(function() {
              // Fetch itself failed: the backend proxy isn't reachable at all.
              showPreviewError(
                "Can't reach the backend at " + API_BASE + ". " +
                "Check your connection, or wait for the server to finish waking up."
              );
            });
        };
        function showPreviewError(msg) {
          setStatus('<i class="fas fa-exclamation-triangle" style="color:var(--accent-flare);"></i> ' + msg, false);
          // Drop the canvas spinner so a stale animation doesn't sit
          // over the error message; image-stage falls back to empty state.
          var _errStage = document.getElementById("imageStage");
          if (_errStage) _errStage.classList.remove("loading");
          var retryDiv = document.createElement("div");
          retryDiv.innerHTML = '<button class="retry-btn" style="margin-top:8px;padding:6px 12px;cursor:pointer;">Retry</button>';
          statusMsg.appendChild(retryDiv);
          retryDiv.querySelector(".retry-btn").addEventListener("click", function() {
            statusMsg.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Retrying…';
            loadHelioviewerPreview(state.wavelength, dateVal);
          });
          hideProgress();
        }
        img.src = url;
      }
    }

    /**
     * Install the raw high-res image in the editor immediately (no RHE on load).
     * Science-image request is fired in the background to warm the cache.
     */
    function _startPreviewFromCanvas(rawCanvas, cacheEntry, wl, dateVal) {
      var dataUrl;
      try {
        dataUrl = rawCanvas.toDataURL("image/png");
      } catch(e) {
        setStatus('<i class="fas fa-exclamation-triangle" style="color:var(--accent-flare);"></i> Preview failed — canvas read error: ' + e.message, false);
        hideProgress();
        return;
      }
      var rawImg = new Image();
      rawImg.onload = function() {
        try {
          _installPreviewImage(rawImg, wl, dateVal);
        } catch(e) {
          console.error("[preview] _installPreviewImage threw:", e);
          setStatus('<i class="fas fa-exclamation-triangle" style="color:var(--accent-flare);"></i> Preview install failed: ' + e.message, false);
          hideProgress();
        }
      };
      rawImg.onerror = function() {
        setStatus('<i class="fas fa-exclamation-triangle" style="color:var(--accent-flare);"></i> Preview failed — could not decode image.', false);
        hideProgress();
      };
      rawImg.src = dataUrl;
    }

    /**
     * Install a loaded Image object as the working preview, reset editing state,
     * and reveal the edit / product sections. Called both from Helioviewer click
     * and (legacy path) from the NASA preview flow.
     */
    function _installPreviewImage(img, wl, dateVal) {
      state.originalImage = img;
      // Set accessible alt text for the preview image
      var altText = "Solar image from " + dateVal + ", " + wl + " Angstrom wavelength";
      if (solarImg) solarImg.alt = altText;
      if (solarCanvas) solarCanvas.setAttribute("aria-label", altText);
      // Image is in — drop the "loading" spinner overlay.
      var _stage = document.getElementById("imageStage");
      if (_stage) _stage.classList.remove("loading");
      state.panX = img.naturalWidth / 2;
      state.panY = img.naturalHeight / 2;
      state.rhefImage = null;
      state.rawBackendImage = null;
      state.editorFilter = "jpg";
      state.rotation = 0;
      state.flipH = false;
      state.flipV = false;
      state.inverted = false;
      state.brightness = 0;
      state.contrast = 0;
      state.saturation = 100;
      state.hue = 0;
      state.vignette = 24;
      state.vignetteWidth = 0;
      state.vignetteFade = "black";
      state.vignetteFadeColor = "#000000";
      state.cropEdgeFeatherX = 0;
      state.cropEdgeFeatherY = 0;
      state.textOverlay = null;
      state.textMode = false;
      state.mockups = {};
      state.mockupsRaw = {};
      state.mockupsFiltered = {};
      state.mockupSlideIndex = {};
      state.uploadedPrintifyId = null;
      state.uploadedPrintifyIdRaw = null;
      state.uploadedPrintifyIdFiltered = null;
      state.aspectFlippedByProduct = {};
      state.hqReady = false;
      state.hqImageUrl = null;
      state.hqTaskId = null;
      state.hqFilterImage = null;
      state.hqFormat = null;
      state.hqFetching = false;
      state.jpgImage = null;
      state.rhefFetching = false; if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
      state.rhefFetchPromise = null;
      state.transitionInProgress = false;

      // Reset filter toggle UI to JPG
      _syncFilterToggleUI("jpg");

      // Restore from cache if this wavelength was already fetched this session.
      // Otherwise fire off a background RHE prefetch so the science data has a
      // head-start while the user browses products and edits.  The prefetch does
      // NOT switch the active filter — the user stays on JPG until they choose to toggle.
      if (API_BASE && dateVal && wl) {
        var cachedEntry = thumbCache[String(wl)];
        if (cachedEntry && cachedEntry.rhef) {
          state.rhefImage = cachedEntry.rhef;
          state.rawBackendImage = cachedEntry.rawBackend || null;
          state.jpgImage = cachedEntry.jpg || null;
          setTimeout(function() {
            applyFilterInstant("rhef");
            showToast("Filtered version loaded from cache! Click Raw to switch back.", "info");
            // RHEF preview is ready — kick off HQ generation immediately (also checks hqCache)
            startHqFilterGeneration(dateVal, wl, "rhef");
          }, 100);
        } else {
          // Background prefetch — warm the backend cache without blocking the UI.
          // Store results so the filter toggle can use them instantly later.
          (function prefetchRHE() {
            state.rhefFetching = true;
            if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
            updateFilterStatusLine("Prefetching science data\u2026", "loading");
            state.rhefFetchPromise = fetchBackendRHEPreview(dateVal, wl, function(pct, msg, optData) {
              updateFilterStatusLine(msg || "Generating preview\u2026", "loading");
              if (optData && optData.preview_jpg_url) {
                var jpgUrl = (String(optData.preview_jpg_url).indexOf("http") === 0) ? optData.preview_jpg_url : (API_BASE + optData.preview_jpg_url);
                var jpgImg = new Image();
                jpgImg.crossOrigin = "anonymous";
                jpgImg.onload = function() {
                  state.jpgImage = jpgImg;
                  if (state.editorFilter === "jpg") renderCanvas();
                  if (typeof maybeAutoAdvanceFilter === "function") maybeAutoAdvanceFilter();
                };
                jpgImg.src = jpgUrl;
              }
            }).then(function(ob) {
              state.rhefImage = ob.filteredImg;
              state.rawBackendImage = ob.rawImg || null;
              state.jpgImage = ob.jpgImg || null;
              state.rhefFetching = false; if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
              state.rhefFetchPromise = null;
              var entry = thumbCache[String(wl)] || {};
              entry.rhef = state.rhefImage; entry.rawBackend = state.rawBackendImage; entry.jpg = state.jpgImage;
              thumbCache[String(wl)] = entry;
              updateFilterStatusLine("Science data ready! Generating HQ\u2026", "loading");
              // Stay on whatever filter the user currently has selected — just re-render
              // to make the cached images available.
              renderCanvas();
              if (typeof maybeAutoAdvanceFilter === "function") maybeAutoAdvanceFilter();
              // RHEF preview is ready — kick off HQ generation in the background.
              // The HQ image will auto-upgrade the canvas to hq_rhef when it arrives.
              startHqFilterGeneration(dateVal, wl, "rhef");
            }).catch(function(err) {
              console.warn("[Prefetch] RHE prefetch failed (non-blocking):", err);
              state.rhefFetching = false; if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
              state.rhefFetchPromise = null;
              updateFilterStatusLine("", "");
            });
          })();
        }
      }

      if (typeof updateSendToPrintifyButton === "function") updateSendToPrintifyButton();

      // Reset slider UI
      $("#brightnessSlider").value = 0;
      $("#contrastSlider").value = 0;
      $("#saturationSlider").value = 100;
      $("#vignetteSlider").value = 100 - 24;
      $("#vigWidthSlider").value = 0;
      $("#brightnessVal").textContent = "0";
      $("#contrastVal").textContent = "0";
      $("#saturationVal").textContent = "100";
      $("#vignetteVal").textContent = "24";
      $("#vigWidthVal").textContent = "0";
      if ($("#cropSlider")) { $("#cropSlider").value = 100; $("#cropVal").textContent = "100%"; }
      state.cropZoom = 100;
      // panX/panY already set to image center (naturalWidth/2, naturalHeight/2) above — don't reset to 0.
      if (solarCanvas) applyCanvasView();
      if ($("#textToolPanel")) $("#textToolPanel").classList.add("hidden");
      var textToolBtn = document.querySelector('[data-tool="text"]');
      if (textToolBtn) textToolBtn.classList.remove("active");
      if (solarCanvas) solarCanvas.classList.remove("text-dragging");
      if ($("#mockupStatus")) $("#mockupStatus").innerHTML = "";

      renderCanvas();
      setProgress(100);
      setStatus('<i class="fas fa-check-circle" style="color:#3ddc84;"></i> ' + wl + ' Å loaded — now choose a product below to start editing.');
      showToast(wl + " Å loaded!");

      // Product-first workflow: show product grid, keep editor hidden until product selected
      imageStage.classList.remove("empty");
      productSection.classList.remove("hidden");
      if (state.scrollToProductsOnLoad) {
        state.scrollToProductsOnLoad = false;
        _scrollToEl(productSection, "start");
      }
      renderProducts();
      if (typeof updateSendToPrintifyButton === "function") updateSendToPrintifyButton();

      // If a product was already selected (e.g. user switched wavelength), re-show editor
      // and scroll back down to it so the user lands on the canvas.
      if (state.selectedProduct) {
        editSection.classList.remove("hidden");
        if (btnBuyInEditor) btnBuyInEditor.classList.remove("hidden");
        var product = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
        if (product) updateSelectedProductPreview(product);
        setTimeout(function() {
          _scrollToEl(editSection, "start");
        }, 120);
      }
      updateProductSectionHeader();

      setTimeout(hideProgress, 1200);
    }

    // ── Wavelength thumbnail previews via Helioviewer (proxied + client RHE) ──
    var HELIO_SOURCE_IDS = { 94: 8, 131: 9, 171: 10, 193: 11, 211: 12, 304: 13, 335: 14, 1600: 15, 1700: 16 };
    var lastThumbDate = "";
    var thumbCache = {};  // { "wl": { raw: <canvas>, canvas2048: <canvas>, rhef: <Image> } } — tiles show raw
    // Tiles emit 6+ log lines per wavelength per date (10 wavelengths, 2–3 retries
    // each) which drowns out real errors in the console. Gate them behind a URL
    // flag — `?debug=tiles` or `?debug=1` turns them back on for diagnosis.
    var DEBUG_TILES = /(?:^|[?&])debug=(tiles|1|all)(?:&|$)/.test(location.search);
    function tileLog() {
      if (!DEBUG_TILES) return;
      console.log.apply(console, ["[tiles]"].concat(Array.prototype.slice.call(arguments)));
    }

    /** Clone a canvas element */
    function cloneCanvas(src) {
      var c = document.createElement("canvas");
      c.width = src.width;
      c.height = src.height;
      c.getContext("2d").drawImage(src, 0, 0);
      return c;
    }

    /** Tiles always show unfiltered (raw) thumbnails. */
    function showThumbFilter() {
      document.querySelectorAll(".wl-thumb").forEach(function(div) {
        var wl = div.dataset.wl;
        var entry = thumbCache[wl];
        if (!entry || !entry.raw) return;
        div.innerHTML = "";
        div.appendChild(cloneCanvas(entry.raw));
        div.classList.add("loaded");
      });
    }

    // ── Show/hide wavelength grid based on whether a date is set ──
    function updateWavelengthSectionDateState() {
      if (!wlGrid || !dateInput) return;
      if (dateInput.value && String(dateInput.value).trim()) {
        wlGrid.classList.remove("hidden");
      } else {
        wlGrid.classList.add("hidden");
      }
    }

    function loadWavelengthThumbnails() {
      updateWavelengthSectionDateState();
      var dateVal = (dateInput && dateInput.value) ? String(dateInput.value).trim() : "";
      // No fallback: tiles only load after the user explicitly picks a date.
      var thumbDivs = document.querySelectorAll(".wl-thumb");
      var thumbCount = thumbDivs ? thumbDivs.length : 0;
      // Cache key now includes the time so changing the time-of-day
      // re-fetches the wavelength tiles (otherwise we'd serve thumbs
      // that are stuck at noon while the editor panes refresh to the
      // new time).
      var thumbCacheKey = dateVal + "T" + _solarTimeValue();
      var alreadyLoadedThisDate = thumbCacheKey === lastThumbDate && Object.keys(thumbCache).length > 0;
      tileLog("loadWavelengthThumbnails", { dateVal: dateVal, lastThumbDate: lastThumbDate, thumbCount: thumbCount, alreadyLoadedThisDate: alreadyLoadedThisDate });
      if (!dateVal || alreadyLoadedThisDate) return;
      lastThumbDate = thumbCacheKey;
      thumbCache = {};  // clear cache for new date/time

      var isoDate = dateVal + "T" + _solarTimeValue() + ":00Z";

      thumbDivs.forEach(function(div) {
        var wl = parseInt(div.dataset.wl, 10);
        if (!HELIO_SOURCE_IDS[wl]) return;

        div.innerHTML = '<div class="wl-thumb-spinner"></div>';
        div.classList.remove("loaded");

        // Tile thumbnails must use the backend proxy (same-origin) — the
        // earlier direct-to-Helioviewer URL fails on browsers behind
        // corporate web filters that block outbound to public APIs, leaving
        // the wavelength picker visually empty even when the rest of the
        // app (which already routes through the proxy) loads fine. The
        // backend's helioviewer_thumb endpoint already handles network
        // resilience (direct → env-proxy fallback) and caches responses.
        var directUrl = "https://api.helioviewer.org/v2/takeScreenshot/?" +
          "date=" + encodeURIComponent(isoDate) +
          "&imageScale=11.7&layers=[SDO,AIA,AIA," + wl + ",1,100]" +
          "&x0=0&y0=0&width=256&height=256&display=true&watermark=false";
        // Vibe-cache shortcut: if this (date, time, wl) was pre-warmed
        // for one of the 5 vibe cards (5 × 3 events × 9 wavelengths =
        // 135 cached JPGs on /var/data), serve straight from disk and
        // skip the Helioviewer round-trip. Falls through to the proxy
        // for any combo that isn't in the manifest.
        var cachedThumbUrl = (typeof _cachedWavelengthThumb === "function")
          ? _cachedWavelengthThumb(dateVal, _solarTimeValue(), wl) : null;
        var proxyUrl256 = cachedThumbUrl || (API_BASE
          ? API_BASE + "/api/helioviewer_thumb?date=" +
              encodeURIComponent(isoDate) + "&wavelength=" + wl + "&image_scale=12&size=256"
          : null);

        var tileImg = document.createElement("img");
        tileImg.alt = wl + " Å";
        tileImg.style.width = "100%";
        tileImg.style.height = "100%";
        tileImg.style.objectFit = "cover";
        tileImg.style.borderRadius = "50%";
        tileImg.onload = function() {
          thumbCache[wl] = { raw: null, canvas2048: null, rhef: null };
          div.classList.add("loaded");
          tileLog("loaded", wl);
          // Warm the 512px canvas cache for editor preview. Goes through the
          // same proxy so it's reliable behind corp filters.
          if (API_BASE) {
            var canvasUrl = API_BASE + "/api/helioviewer_thumb?date=" +
              encodeURIComponent(isoDate) + "&wavelength=" + wl + "&image_scale=12&size=512";
            var proxyImg = new Image();
            proxyImg.onload = function() {
              try {
                var c = document.createElement("canvas");
                c.width  = proxyImg.naturalWidth  || 512;
                c.height = proxyImg.naturalHeight || 512;
                c.getContext("2d").drawImage(proxyImg, 0, 0);
                if (thumbCache[String(wl)]) thumbCache[String(wl)].canvas2048 = c;
                tileLog("proxy canvas cached for", wl);
              } catch(e) {
                tileLog("proxy canvas draw error for", wl, e);
              }
            };
            proxyImg.onerror = function() {
              tileLog("proxy canvas fetch failed for", wl);
            };
            proxyImg.src = canvasUrl;
          }
        };
        // If the proxy is unreachable for any reason (backend down, CORS),
        // fall back to a direct Helioviewer fetch — better to occasionally
        // succeed than always-empty tiles.
        var triedFallback = false;
        tileImg.onerror = function() {
          if (!triedFallback && proxyUrl256 && tileImg.src !== directUrl) {
            triedFallback = true;
            tileLog("tile proxy failed, falling back to direct for", wl);
            tileImg.src = directUrl;
            return;
          }
          div.innerHTML = "";
          tileLog("error", wl);
        };
        div.innerHTML = "";
        div.appendChild(tileImg);
        tileImg.src = proxyUrl256 || directUrl;
      });
    }

    /**
     * Load RHE image from backend (FITS→RHEF PNG). Returns a Promise that resolves with an Image
     * or rejects. Uses POST /api/generate_preview; if 202, polls for the preview URL until ready.
     * onProgress(pct, message) is optional and called during request/poll/load.
     */
    // Helper: stash the latest server-reported queue depth so the
    // loading-indicator chip can surface it (Queued · N ahead) when
    // multiple users are pushing the heavy-render slot at once.
    function _recordQueueDepth(data) {
      if (!data || typeof data.queue_depth !== "number") return;
      state._hqQueueDepth = data.queue_depth;
      if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
    }

    function fetchBackendRHEPreview(dateStr, wavelength, onProgress) {
      dateStr = (dateStr || "").trim();
      if (!dateStr || !wavelength) return Promise.reject(new Error("Missing date or wavelength"));
      if (onProgress) onProgress(10, "Requesting RHE…");
      var timeStr = _solarTimeValue();
      return fetch(API_BASE + "/api/generate_preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr, time: timeStr, wavelength: wavelength, mission: "SDO" })
      }).then(function(res) { return res.json().then(function(data) { return { status: res.status, data: data }; }); })
        .then(function(result) {
          _recordQueueDepth(result.data);
          if (result.data.preview_url) {
            if (onProgress) onProgress(85, "Loading preview images…");
            var rawUrl = result.data.preview_raw_url ? API_BASE + result.data.preview_raw_url : null;
            var jpgUrl = result.data.preview_jpg_url ? API_BASE + result.data.preview_jpg_url : null;
            return { filteredUrl: API_BASE + result.data.preview_url, rawUrl: rawUrl, jpgUrl: jpgUrl };
          }
          if (result.status === 202 || (result.status === 200 && result.data.status === "rhef_generating")) {
            if (result.data.status === "rhef_generating" && result.data.preview_jpg_url && onProgress) {
              onProgress(40, "JPG ready; generating RHE…", { preview_jpg_url: result.data.preview_jpg_url });
            }
            return new Promise(function(resolve, reject) {
              var attempts = 0;
              // `maxAttempts` now only scales the progress bar (the
              // 20→70% band). Termination is wall-clock based — see
              // POLL_DEADLINE_MS below. (Tom QA round-2: the old
              // attempt-count cap claimed "2 minutes" but on a slow
              // link, where each attempt could burn the full 15s
              // per-request timeout + 1.5s gap, 60 attempts was up to
              // ~16 min of real time. The reject text lied. We now cap
              // by elapsed wall-clock and report the true elapsed.)
              var maxAttempts = 60;
              var POLL_PER_REQUEST_TIMEOUT_MS = 15000;
              var POLL_DEADLINE_MS = 4 * 60 * 1000; // honest hard cap
              var pollStart = Date.now();
              function _pollElapsedMs() { return Date.now() - pollStart; }
              function _pollTimedOut() { return _pollElapsedMs() >= POLL_DEADLINE_MS; }
              function _pollTimeoutError() {
                var mins = Math.max(1, Math.round(_pollElapsedMs() / 60000));
                return new Error(
                  "RHE preview timed out after about " + mins + " minute" +
                  (mins === 1 ? "" : "s") +
                  ". The science data is slow to retrieve right now — try again, " +
                  "or pick a nearby date or time."
                );
              }
              function poll() {
                if (onProgress) onProgress(20 + Math.min(50, (attempts / maxAttempts) * 50), "Generating RHE from science data…");
                // Each poll attempt gets its own AbortController so a
                // slow-network hang (3G, hotel wifi) can't pause the
                // polling loop forever — a QA tester flagged that
                // refresh-mid-RHEF + slow link left the user staring
                // at "Generating preview…" indefinitely with no retry.
                // If a single attempt times out, we count it as an
                // attempt and schedule the next one.
                var abortCtrl = new AbortController();
                var perReqTimer = setTimeout(function() { abortCtrl.abort(); }, POLL_PER_REQUEST_TIMEOUT_MS);
                fetch(API_BASE + "/api/generate_preview", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ date: dateStr, time: timeStr, wavelength: wavelength, mission: "SDO" }),
                  signal: abortCtrl.signal
                }).then(function(r) { clearTimeout(perReqTimer); return r.json().then(function(d) { return { status: r.status, data: d }; }); })
                  .then(function(pollResult) {
                    var d = pollResult.data;
                    _recordQueueDepth(d);
                    if (d.preview_url) {
                      if (onProgress) onProgress(85, "Loading preview images…");
                      var rawU = d.preview_raw_url ? API_BASE + d.preview_raw_url : null;
                      var jpgU = d.preview_jpg_url ? API_BASE + d.preview_jpg_url : null;
                      resolve({ filteredUrl: API_BASE + d.preview_url, rawUrl: rawU, jpgUrl: jpgU });
                      return;
                    }
                    if (pollResult.status === 200 && !d.preview_url) {
                      if (d.status === "rhef_generating" && d.preview_jpg_url) {
                        if (onProgress) onProgress(40, "JPG ready; generating RHE…", { preview_jpg_url: d.preview_jpg_url });
                        attempts++;
                        if (_pollTimedOut()) reject(_pollTimeoutError());
                        else setTimeout(poll, 1500);
                        return;
                      }
                      reject(new Error(d.error || "No VSO data for this date"));
                      return;
                    }
                    attempts++;
                    if (_pollTimedOut()) reject(_pollTimeoutError());
                    else setTimeout(poll, 1500);
                  })
                  .catch(function(err) {
                    clearTimeout(perReqTimer);
                    // AbortError → this single poll attempt timed out
                    // on the wire. Don't fail the whole flow; surface
                    // a slow-network hint via onProgress, count the
                    // attempt, and try again.
                    if (err && err.name === "AbortError") {
                      attempts++;
                      if (_pollTimedOut()) {
                        reject(new Error("Connection too slow — RHE preview attempts timed out repeatedly. Retry on a stronger network."));
                        return;
                      }
                      if (onProgress) onProgress(20 + Math.min(50, (attempts / maxAttempts) * 50), "Slow connection — retrying…");
                      setTimeout(poll, 1500);
                      return;
                    }
                    // Any other error → bubble up to the .catch on the
                    // outer .then chain so the user sees the real
                    // failure mode.
                    reject(err);
                  });
              }
              // Give the background task a head-start before first poll (JPG often ready in ~3s)
              setTimeout(poll, 2500);
            });
          }
          return Promise.reject(new Error(result.data.error || result.data.detail || "No preview_url"));
        })
        .then(function(urls) {
          return new Promise(function(resolve, reject) {
            var filteredImg = new Image();
            var rawImg = urls.rawUrl ? new Image() : null;
            var jpgImg = urls.jpgUrl ? new Image() : null;
            var need = 1 + (rawImg ? 1 : 0) + (jpgImg ? 1 : 0);
            var done = 0;
            function maybeResolve() {
              if (++done >= need) {
                if (onProgress) onProgress(100, "Done");
                resolve({ filteredImg: filteredImg, rawImg: rawImg, jpgImg: jpgImg });
              }
            }
            filteredImg.crossOrigin = "anonymous";
            filteredImg.onload = maybeResolve;
            filteredImg.onerror = function() {
              var img2 = new Image();
              img2.onload = function() { maybeResolve(); };
              img2.onerror = function() { reject(new Error("Failed to load filtered preview")); };
              img2.src = urls.filteredUrl;
            };
            filteredImg.src = urls.filteredUrl;
            if (rawImg) {
              rawImg.crossOrigin = "anonymous";
              rawImg.onload = maybeResolve;
              rawImg.onerror = function() { rawImg = null; maybeResolve(); };
              rawImg.src = urls.rawUrl;
            }
            if (jpgImg && urls.jpgUrl) {
              jpgImg.crossOrigin = "anonymous";
              jpgImg.onload = maybeResolve;
              jpgImg.onerror = function() { jpgImg = null; maybeResolve(); };
              jpgImg.src = urls.jpgUrl;
            }
          });
        });
    }

    /**
     * Apply filter instantly (no animation). Updates canvas and mockups.
     * Use when the target image is already cached so toggle feels immediate.
     */
    function applyFilterInstant(newFilter) {
      if (newFilter === state.editorFilter) return;
      state.editorFilter = newFilter;
      renderCanvas();
      _syncFilterToggleUI(newFilter);
      updateMockupDisplay();
    }

    /**
     * Apply RHEF filter with a radial-outwards wipe from center. Used when RHEF has just loaded.
     */
    function applyFilterWithRadialWipe(newFilter, done) {
      if (newFilter !== "rhef" || !solarCanvas) {
        if (done) done();
        return;
      }
      var cw = solarCanvas.width;
      var ch = solarCanvas.height;
      if (cw <= 0 || ch <= 0) {
        applyFilterInstant("rhef");
        if (done) done();
        return;
      }
      var dataUrlA = solarCanvas.toDataURL("image/png");
      state.editorFilter = "rhef";
      renderCanvas();
      var dataUrlB = solarCanvas.toDataURL("image/png");
      var imgA = new Image();
      var imgB = new Image();
      var loaded = 0;
      function maybeStart() {
        if (++loaded < 2) return;
        var ctx = solarCanvas.getContext("2d");
        var cx = cw / 2, cy = ch / 2;
        var maxR = Math.sqrt(cx * cx + cy * cy) * 1.05;
        var dur = 400;
        var start = performance.now();
        function frame(t) {
          var elapsed = t - start;
          var r = elapsed >= dur ? maxR : (elapsed / dur) * maxR;
          ctx.drawImage(imgA, 0, 0);
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, 2 * Math.PI);
          ctx.clip();
          ctx.drawImage(imgB, 0, 0);
          ctx.restore();
          if (r < maxR) requestAnimationFrame(frame);
          else {
            _syncFilterToggleUI("rhef");
            updateMockupDisplay();
            if (done) done();
          }
        }
        requestAnimationFrame(frame);
      }
      imgA.onload = maybeStart;
      imgB.onload = maybeStart;
      imgA.src = dataUrlA;
      imgB.src = dataUrlB;
    }

    // ── Filter quality timeline ──
    // The four image versions form a progression: JPG (instant) → Raw → RHEF
    // → HQ RHEF (highest quality). Each step's status icon reflects whether
    // its underlying image is locked, loading, or ready. Selection auto-
    // advances forward as new versions land — unless the user manually
    // clicked an earlier step, in which case we honor their choice and don't
    // override it on subsequent ready events. All four images are
    // co-registered in renderCanvas via the per-format scaleImg adjustment,
    // so panning/cropping survives a quality jump.
    var FILTER_ORDER = ["jpg", "raw", "rhef", "hq_rhef"];
    function _filterIsReady(f) {
      if (f === "jpg") return !!(state.jpgImage || state.originalImage);
      if (f === "raw") return !!state.rawBackendImage;
      if (f === "rhef") return !!state.rhefImage;
      if (f === "hq_rhef") return !!(state.hqFilterImage && state.hqFormat === "rhef");
      return false;
    }
    function _filterIsLoading(f) {
      if (f === "raw" || f === "rhef") return !!state.rhefFetching;
      if (f === "hq_rhef") return !!state.hqFetching;
      return false;
    }
    function updateFilterTimelineUI() {
      var toggleEl = document.getElementById("editorFilterToggle");
      if (!toggleEl) return;
      var current = state.editorFilter;
      // Determine the highest-index ready step — used so the connectors
      // between ready steps render in the "completed" color.
      var maxReadyIdx = -1;
      FILTER_ORDER.forEach(function(f, i) { if (_filterIsReady(f)) maxReadyIdx = i; });
      toggleEl.querySelectorAll(".filter-step").forEach(function(step, idx) {
        var f = step.dataset.filter;
        var ready = _filterIsReady(f);
        var loading = _filterIsLoading(f);
        var active = (f === current);
        var status = active ? "active" : (loading ? "loading" : (ready ? "ready" : "locked"));
        step.classList.toggle("active", active);
        step.classList.toggle("ready", ready && !active);
        step.classList.toggle("loading", loading);
        step.classList.toggle("locked", !ready && !loading && !active);
        var statusEl = step.querySelector(".filter-step-status");
        if (statusEl) statusEl.dataset.status = status;
        var radio = step.querySelector('input[name="editorFilter"]');
        if (radio) radio.checked = active;
      });
      toggleEl.querySelectorAll(".filter-step-connector").forEach(function(c, i) {
        // connector at index i sits between step i and step i+1.
        c.classList.toggle("completed", i < maxReadyIdx);
      });
    }
    // Backwards-compat: existing call sites pass the *intended* filter value
    // and expect us to redraw the toggle to match. Do NOT mutate
    // state.editorFilter here — applyFilterInstant() short-circuits when
    // newFilter === state.editorFilter, so setting it here before that call
    // would silently no-op every quality click. The visual update reads
    // state.editorFilter directly.
    function _syncFilterToggleUI(_filterValue) {
      updateFilterTimelineUI();
    }
    /**
     * Auto-advance to the highest-quality ready filter when a new tier lands,
     * unless the user has explicitly clicked an earlier step. Tracked via
     * `state._userFilterPick` set in the click handler — we only advance past
     * what they last picked. Falls through to renderCanvas to keep crop/pan
     * co-registered.
     */
    function maybeAutoAdvanceFilter() {
      if (!state.originalImage) return;
      var current = state.editorFilter;
      var pinIdx = state._userFilterPick != null ? FILTER_ORDER.indexOf(state._userFilterPick) : -1;
      var bestIdx = -1;
      FILTER_ORDER.forEach(function(f, i) { if (_filterIsReady(f)) bestIdx = i; });
      if (bestIdx < 0) { updateFilterTimelineUI(); return; }
      var currentIdx = FILTER_ORDER.indexOf(current);
      // Don't downgrade on a re-render. Only move FORWARD, and only past the
      // user's manually-pinned step (so they can stay on JPG if they want to).
      var target = current;
      if (bestIdx > currentIdx && bestIdx > pinIdx) {
        target = FILTER_ORDER[bestIdx];
      }
      if (target !== current) {
        state.editorFilter = target;
        updateFilterTimelineUI();
        if (typeof renderCanvas === "function") renderCanvas();
      } else {
        updateFilterTimelineUI();
      }
    }

    // ── Mockup display switching ────────────────────────────────
    function updateMockupDisplay() {
      if (state.editorFilter === "raw") {
        state.mockups = state.mockupsRaw;
      } else {
        state.mockups = Object.keys(state.mockupsFiltered).length > 0
          ? state.mockupsFiltered : state.mockupsRaw;
      }
      if (typeof renderProducts === "function") renderProducts();
      if (typeof updatePreviewPaneMockupState === "function") updatePreviewPaneMockupState();
    }

    // ── Editor filter: JPG | Raw | RHEF (all from preview); HQ is separate button ──
    var editorFilterToggleEl = document.getElementById("editorFilterToggle");
    function ensurePreviewFetchedThenApply(filterValue, preferWipe) {
      var dateVal = dateInput ? dateInput.value : "";
      if (!API_BASE || !dateVal) {
        editorFilterToggleEl.querySelector('input[name="editorFilter"][value="' + state.editorFilter + '"]').checked = true;
        showToast("Preview requires backend and date.", "error");
        return;
      }
      if (state.rhefFetching) {
        showToast("Preview images are generating, please wait\u2026", "info");
        editorFilterToggleEl.querySelector('input[name="editorFilter"][value="' + state.editorFilter + '"]').checked = true;
        return;
      }
      if (state.hqFetching && state.editorFilter === "hq_rhef") {
        showToast("High-resolution image is generating in background. It will appear automatically when ready.", "info");
        editorFilterToggleEl.querySelector('input[name="editorFilter"][value="' + state.editorFilter + '"]').checked = true;
        return;
      }
      if (state.rhefFetchPromise) {
        // A fetch is already in-flight — chain onto it; only apply the filter if the user
        // hasn't switched to something else by the time the fetch completes.
        state.rhefFetchPromise.then(function() {
          if (state.editorFilter !== filterValue) { renderCanvas(); return; }
          if (filterValue === "rhef" && preferWipe) applyFilterWithRadialWipe("rhef", function() {});
          else applyFilterInstant(filterValue);
        });
        return;
      }
      state.rhefFetching = true; if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
      updateFilterStatusLine("Requesting preview\u2026", "loading");
      state.rhefFetchPromise = fetchBackendRHEPreview(dateVal, state.wavelength, function(pct, msg, optionalData) {
        updateFilterStatusLine(msg || "Generating preview\u2026", "loading");
        if (optionalData && optionalData.preview_jpg_url) {
          var jpgUrl = (String(optionalData.preview_jpg_url).indexOf("http") === 0) ? optionalData.preview_jpg_url : (API_BASE + optionalData.preview_jpg_url);
          var jpgImg = new Image();
          jpgImg.crossOrigin = "anonymous";
          jpgImg.onload = function() {
            state.jpgImage = jpgImg;
            // Cache the early JPG preview but don't force-switch the user's active filter.
            // Only re-render so the cached image is used if editorFilter is already "jpg".
            if (state.editorFilter === "jpg") renderCanvas();
            if (typeof maybeAutoAdvanceFilter === "function") maybeAutoAdvanceFilter();
          };
          jpgImg.src = jpgUrl;
        }
      }).then(function(ob) {
        state.rhefImage = ob.filteredImg;
        state.rawBackendImage = ob.rawImg || null;
        state.jpgImage = ob.jpgImg || null;
        state.rhefFetching = false; if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
        state.rhefFetchPromise = null;
        var entry = thumbCache[String(state.wavelength)] || {};
        entry.rhef = state.rhefImage; entry.rawBackend = state.rawBackendImage; entry.jpg = state.jpgImage;
        thumbCache[String(state.wavelength)] = entry;
        updateFilterStatusLine("Preview ready!", "success");
        // Only apply the requested filter if the user hasn't switched away since the fetch started.
        if (state.editorFilter === filterValue) {
          if (filterValue === "rhef" && preferWipe) applyFilterWithRadialWipe("rhef", function() {});
          else applyFilterInstant(filterValue);
        } else {
          // User is on a different filter — re-render so the newly cached images are available
          // (e.g. user is on "raw" and rawBackendImage just arrived).
          renderCanvas();
        }
        if (typeof maybeAutoAdvanceFilter === "function") maybeAutoAdvanceFilter();
      }).catch(function(err) {
        console.error("[Preview] Fetch failed:", err);
        state.rhefFetching = false; if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
        state.rhefFetchPromise = null;
        editorFilterToggleEl.querySelector('input[name="editorFilter"][value="' + state.editorFilter + '"]').checked = true;
        updateFilterStatusLine("Preview unavailable: " + (err.message || err), "error");
      });
    }
    if (editorFilterToggleEl) {
      function handleFilterChange(radio) {
        if (!radio || radio.name !== "editorFilter" || radio.type !== "radio") return;
        var newFilter = radio.value;
        if (newFilter === state.editorFilter) return;
        if (newFilter === "jpg") {
          // state.originalImage is always available as a JPG fallback (renderCanvas uses
          // jpgImage || originalImage), so we can always switch to JPG instantly without
          // waiting for an async fetch.  The old path through ensurePreviewFetchedThenApply
          // was broken: it never updated state.editorFilter before the async fetch, so the
          // resolution check (state.editorFilter === "jpg") always failed and the canvas
          // stayed on whatever it had before.
          applyFilterInstant("jpg");
          return;
        }
        if (newFilter === "rhef") {
          if (state.rhefImage) applyFilterInstant("rhef");
          else ensurePreviewFetchedThenApply("rhef", true);
          return;
        }
        if (newFilter === "raw") {
          // If the backend raw image is already loaded, show it immediately.
          // Otherwise trigger the shared fetch (which retrieves raw + rhef + jpg together).
          if (state.rawBackendImage) applyFilterInstant("raw");
          else ensurePreviewFetchedThenApply("raw", false);
          return;
        }
        if (newFilter === "hq_rhef") {
          var dateForHQ = dateInput ? dateInput.value : "";
          if (state.hqFilterImage && state.hqFormat === "rhef") {
            // HQ already loaded — switch instantly, no dialog needed
            applyFilterInstant("hq_rhef");
          } else {
            // HQ not yet ready: show an info dialog.
            // Do NOT switch the filter — user stays on their current filter (JPG/RAW/RHEF).
            // The HQ will be available when they explicitly switch to hq_rhef.
            var msg = state.hqFetching
              ? "The high-resolution RHEF image is currently being generated in the background and will appear automatically when ready.\n\nAny edits you make now — crop, zoom, pan, adjustments — will be represented in the final product. It is recommended to wait for the high-resolution image to appear before sending to Shopify."
              : "This high-resolution image may take a couple of minutes to generate.\n\nAny edits you make now — crop, zoom, pan, adjustments — will be represented in the final product. It is recommended to wait for the high-resolution image to appear before sending to Shopify.";
            showInfo("HQ RHEF", msg);
            // Start generating if not already in flight (user stays on current filter)
            if (!state.hqFetching && dateForHQ && state.wavelength) {
              startHqFilterGeneration(dateForHQ, state.wavelength, "rhef");
            }
          }
          return;
        }
        applyFilterInstant(newFilter);
      }
      // Click delegate covers both the new .filter-step timeline buttons and
      // any leftover .filter-opt labels (defensive, in case some other code
      // path renders the old markup). preventDefault keeps the underlying
      // radio's default-label behavior from double-firing during async
      // fetches and reverting the user's pick.
      editorFilterToggleEl.addEventListener("click", function(e) {
        var opt = e.target.closest(".filter-step, .filter-opt");
        if (!opt || !editorFilterToggleEl.contains(opt)) return;
        var radio = opt.querySelector('input[name="editorFilter"]');
        if (!radio) return;
        e.preventDefault();
        if (radio.value === state.editorFilter) return;
        // Track the user's manual pick so the auto-advance respects it. If
        // they tap a step that isn't ready yet, treat it as a request (the
        // existing handleFilterChange flow shows the right toast/dialog and
        // schedules the fetch).
        state._userFilterPick = radio.value;
        radio.checked = true;
        _syncFilterToggleUI(radio.value);
        handleFilterChange(radio);
      });
      _syncFilterToggleUI(state.editorFilter);
    }

    // Load thumbnails on date change and on initial page load.
    // Round-2 perf audit (Priya Iyer, P2): `input` fires on every
    // keystroke as the user types a date — N wavelength fetches per
    // character. 250ms trailing-edge debounce holds the request until
    // the typing pauses, so a single date entry costs one network burst
    // instead of 8. The "change" event stays unbuffered because it
    // fires once on commit (picker selection, blur, Enter).
    // ── HEK best-time-of-day auto-fill ──────────────────────────────
    // For each date the user picks, query the backend's HEK endpoint and
    // (a) auto-populate the time-of-day input with the peak time of the
    // most striking event, and (b) surface a small badge above the
    // wavelength grid describing the event. Ranking is server-side and
    // locked: CMEs / prominence eruptions above flares (flares oversaturate
    // at 193 Å), then largest active region, then noon fallback.
    //
    // We DON'T fire on the fixed landing date 2014-10-24: the persistent
    // HQ + Printify-mockup cache is keyed at 12:00 UTC, and shifting the
    // time would defeat both caches on the very first paint. The badge is
    // hidden in that case — the user sees the eye-candy default at noon
    // and the HEK pick kicks in the moment they choose their own date.
    var hekPickerSection = document.getElementById("hekPickerSection");
    var hekTileGrid = document.getElementById("hekTileGrid");
    var wlSuggestCaption = document.getElementById("wlSuggestCaption");
    // Latch: once the user manually edits the time input we stop
    // overwriting it from HEK. Avoids surprising the user who wants a
    // specific UTC hour.
    var _userTouchedTime = false;
    var _userTouchedWavelength = false;
    if (timeInput) {
      timeInput.addEventListener("input", function () { _userTouchedTime = true; });
    }

    // ── Wavelength auto-suggest from HEK event type ────────────────
    // Locked policy plus on-disk-vs-limb branch for filament eruptions:
    //   CME                        → 193 (warm corona; bright disturbances)
    //   Filament/prominence on-disk → 193 (arcade + dimming dominate;
    //                                 chromospheric foot-points overwhelm 304)
    //   Filament/prominence off-limb→ 304 (cool He II glows in prominences)
    //   Flare ≥ M5                 → 131 (hot Fe XXI / Fe XXIII, ~10–15 MK)
    //   Flare  < M5                → 171 (post-flare loops dominate)
    //   Active region              → 171 (loop tracers, Patricia-confirmed)
    //   Quiet day                  → 171 (default photogenic corona)
    function _suggestWavelengthFor(event) {
      if (!event || event.fallback) {
        return { wl: 171, why: "171 Å shows the quiet corona well" };
      }
      var code = event.event_code;
      if (code === "CE") return { wl: 193, why: "CMEs show best in the warm corona" };
      if (code === "FE") {
        // on_disk may be true, false, or null (unknown). Default to disk
        // because most FEs catalogued by HEK are on-disk filament rises.
        if (event.on_disk === false) {
          return { wl: 304, why: "off-limb prominences glow brightest in cool helium" };
        }
        return { wl: 193, why: "on-disk filament arcade + dimming show best in the warm corona" };
      }
      if (code === "FL") {
        var goes = String(event.goes_class || "").toUpperCase();
        // Magnitude > 5 within letter, or X-class always
        var bigFlare = goes.charAt(0) === "X" ||
                       (goes.charAt(0) === "M" && parseFloat(goes.slice(1)) >= 5);
        // 131 Å (Fe XXI ~10 MK) is technically where flaring plasma peaks,
        // but it saturates ferociously at X-class peaks (Lemen 2012's
        // dynamic range can't hold the bloom), and the resulting raw
        // frame is a washed-out blob. 211 Å (Fe XIV ~2 MK) shows the
        // active region around the flare cleanly without the saturation
        // bloom — the picture you actually want printed.
        if (bigFlare) return { wl: 211, why: "211 Å shows the flare's active region without 131 Å's saturation bloom" };
        return { wl: 171, why: "post-flare loops show best in the warm corona" };
      }
      if (code === "AR") return { wl: 171, why: "active-region loops trace magnetic structure" };
      return { wl: 193, why: "193 Å is the default photogenic corona view" };
    }

    var _lastSuggestionKey = "";  // dedup aria-live announcements
    function _applyWavelengthSuggestion(event) {
      var s = _suggestWavelengthFor(event);
      // If the user has already explicitly picked a wavelength (e.g. via
      // a vibe-card), the suggestion would contradict their choice. Only
      // surface the caption when the suggestion matches their current
      // wavelength OR they haven't touched a wavelength tile yet.
      var currentWl = state && state.wavelength ? parseInt(state.wavelength, 10) : null;
      var captionApplies = !_userTouchedWavelength || currentWl === s.wl;
      if (wlSuggestCaption) {
        if (captionApplies) {
          // Pull the colour tone from the existing wavelength tile label so
          // the suggestion reads in plain language ("the amber view") and
          // anchors the number to the visual.
          var tone = "";
          if (wlGrid) {
            var tile = wlGrid.querySelector('.wl-card[data-wl="' + s.wl + '"] .wl-label');
            if (tile) {
              var first = (tile.textContent || "").split("·")[0].trim();
              if (first) tone = first.toLowerCase();
            }
          }
          var toneFrag = tone ? " (the " + escapeHtml(tone) + " view)" : "";
          // Dedup: if the same suggestion is being re-applied, skip the
          // DOM rewrite so aria-live doesn't spam screen readers.
          var key = s.wl + "|" + tone + "|" + s.why;
          if (key === _lastSuggestionKey) return;
          _lastSuggestionKey = key;
          wlSuggestCaption.classList.remove("hidden");
          wlSuggestCaption.innerHTML =
            "We picked <strong>" + s.wl + " Å</strong>" + toneFrag + " — " +
            escapeHtml(s.why) + ". Want a different look? Tap any tile.";
        } else {
          // Suggestion conflicts with user's explicit pick — stay quiet.
          _lastSuggestionKey = "";
          wlSuggestCaption.classList.add("hidden");
          wlSuggestCaption.innerHTML = "";
        }
      }
      // Visual ring on the suggested tile, only if the user hasn't picked
      // their own wavelength yet.
      if (wlGrid && !_userTouchedWavelength) {
        wlGrid.querySelectorAll(".wl-card.is-suggested").forEach(function (el) {
          el.classList.remove("is-suggested");
        });
        var ringTile = wlGrid.querySelector('.wl-card[data-wl="' + s.wl + '"]');
        if (ringTile) ringTile.classList.add("is-suggested");
      }
    }

    // ── HEK 4-tile picker ──────────────────────────────────────────
    var _hekFetchToken = 0;
    var _hekCurrentEvents = [];   // events currently rendered in the grid
    var _hekSelectedRank = null;  // 1-based rank of the picked tile, or "custom"

    // Time arithmetic for the [-]/[+] fine-tuner. ±1 minute steps,
    // wrapping at the day boundary so step-back at 00:00 goes to 23:59.
    function _hhmmAddMinutes(hhmm, delta) {
      var m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
      var hh = m ? parseInt(m[1], 10) : 12;
      var mm = m ? parseInt(m[2], 10) : 0;
      var total = ((hh * 60 + mm + delta) % 1440 + 1440) % 1440;
      var nh = Math.floor(total / 60), nm = total % 60;
      return (nh < 10 ? "0" + nh : nh) + ":" + (nm < 10 ? "0" + nm : nm);
    }

    function _updateCustomTimeDisplay(hhmm) {
      var d = document.getElementById("hekTimeDisplay");
      if (d) d.textContent = hhmm;
      // Keep the exact-time input in sync so the picker opens at the
      // current value and reflects [-]/[+] step changes.
      var ex = document.getElementById("hekTimeExact");
      if (ex && ex.value !== hhmm) ex.value = hhmm;
    }

    // Debounced JPG-preview refresh: after the user stops clicking
    // [-]/[+] for ~1.5 s, fire a "change" on #solarTime so the existing
    // pipeline (loadWavelengthThumbnails + active wavelength reload)
    // picks up the new time. While the user is still tapping, the
    // display updates immediately but the network calls are coalesced.
    var _fineTuneTimer = null;
    var _FINE_TUNE_DEBOUNCE_MS = 1500;
    function _scheduleFineTuneRefresh() {
      if (!timeInput) return;
      clearTimeout(_fineTuneTimer);
      _fineTuneTimer = setTimeout(function () {
        timeInput.dispatchEvent(new Event("change", { bubbles: true }));
      }, _FINE_TUNE_DEBOUNCE_MS);
    }

    function _eventTileAccessibleName(event) {
      // Per a11y agent: rank goes IN the accessible name, not just visual.
      var rankPhrase =
        event.rank === 1 ? "Top pick. " :
        event.rank === 2 ? "Second pick. " :
        event.rank === 3 ? "Third pick. " : "";
      var typePhrase = event.event_type || "Event";
      var timePhrase = "at " + event.time_utc + " UTC";
      var metaPhrase = "";
      if (event.goes_class) {
        metaPhrase = "GOES class " + event.goes_class + ". ";
      } else if (event.intensity_label) {
        metaPhrase = event.intensity_label + ". ";
      } else if (event.ar_number) {
        metaPhrase = "NOAA active region " + event.ar_number + ". ";
      }
      return rankPhrase + typePhrase + " " + timePhrase + ". " + metaPhrase + "Tap to select.";
    }

    function _eventTileHTML(event, isFirstRadio) {
      var rankClass = event.rank === 1 ? "is-top" : "";
      var fallbackClass = event.fallback ? "is-fallback" : "";
      var rankLabel = escapeHtml(event.rank_label || "");
      var time = escapeHtml(event.time_utc || "12:00");
      var type = escapeHtml(event.event_type || "—");
      var metaHtml = "";
      if (event.goes_class) {
        var cls = String(event.goes_class).charAt(0).toUpperCase();
        metaHtml = '<span class="hek-tile-goes" data-cls="' + escapeHtml(cls) + '">' +
                   escapeHtml(event.goes_class) + '-class flare</span>';
      } else if (event.intensity_label) {
        metaHtml = '<span class="hek-tile-meta">' + escapeHtml(event.intensity_label) + '</span>';
      } else if (event.ar_number) {
        metaHtml = '<span class="hek-tile-meta">NOAA AR ' + escapeHtml(String(event.ar_number)) + '</span>';
      } else if (event.fallback) {
        metaHtml = '<span class="hek-tile-meta">No notable events catalogued</span>';
      }
      // Roving tabindex per WAI-ARIA radiogroup pattern: only the first
      // (or currently-checked) radio is tabbable; the rest are tabindex=-1
      // and reached via arrow keys. _selectHekTile keeps this in sync.
      var tabIndex = isFirstRadio ? "0" : "-1";
      return '<button type="button" class="hek-tile ' + rankClass + ' ' + fallbackClass + '"' +
             ' role="radio" aria-checked="false" tabindex="' + tabIndex + '"' +
             ' data-hek-rank="' + event.rank + '"' +
             ' data-hek-time="' + escapeHtml(event.time_utc || "12:00") + '"' +
             ' aria-label="' + escapeHtml(_eventTileAccessibleName(event)) + '">' +
             '<span class="hek-tile-rank">' + rankLabel + '</span>' +
             '<span class="hek-tile-time">' + time + ' UTC</span>' +
             '<span class="hek-tile-type">' + type + '</span>' +
             metaHtml +
             '</button>';
    }

    function _customTileHTML(initialTime) {
      var display = initialTime && /^\d{2}:\d{2}/.test(initialTime) ? initialTime.slice(0, 5) : "12:00";
      // role="group" (not "radio") per the a11y audit: a radio cannot
      // contain interactive descendants (the [-] / [+] buttons). The
      // tile lives as a sibling of the event radios in the same CSS
      // grid; the radiogroup's arrow-key handler skips it.
      //
      // Time is mutated by [-] / [+] (±1 minute each), which writes back
      // to #solarTime. After 1.5s with no further clicks (a debounced
      // window), a "change" event fires on #solarTime so the JPG preview
      // pipeline (loadWavelengthThumbnails) reloads at the new time.
      // Hour rolls over at 24, minute rolls over at 60 (wraps the hour).
      return '<div class="hek-tile hek-tile-custom" role="group"' +
             ' data-hek-rank="custom" aria-label="Fine-tune the time of day">' +
             '<span class="hek-tile-rank">Fine-tune time</span>' +
             '<div class="hek-time-fine">' +
               '<button type="button" class="hek-time-step" data-step="-5" aria-label="Decrease time by five minutes">−</button>' +
               '<span class="hek-time-display" id="hekTimeDisplay" aria-live="polite">' + escapeHtml(display) + '</span>' +
               '<button type="button" class="hek-time-step" data-step="5" aria-label="Increase time by five minutes">+</button>' +
             '</div>' +
             '<div class="hek-time-exact">' +
               '<label for="hekTimeExact" class="hek-time-exact-label">Or pick exact:</label>' +
               '<input type="time" id="hekTimeExact" class="hek-time-exact-input"' +
                 ' step="60" value="' + escapeHtml(display) + '"' +
                 ' aria-label="Pick an exact time of day">' +
             '</div>' +
             '<span class="hek-tile-meta">UTC</span>' +
             '</div>';
    }

    function _renderHekSkeleton() {
      if (!hekTileGrid) return;
      hekTileGrid.innerHTML =
        '<div class="hek-tile is-skeleton" aria-hidden="true"></div>' +
        '<div class="hek-tile is-skeleton" aria-hidden="true"></div>' +
        '<div class="hek-tile is-skeleton" aria-hidden="true"></div>' +
        _customTileHTML(timeInput ? timeInput.value : "12:00");
    }

    function _renderHekTiles(payload, dateStr) {
      if (!hekTileGrid || !hekPickerSection) return;
      hekPickerSection.classList.remove("hidden");
      _hekCurrentEvents = (payload && payload.events) ? payload.events.slice(0, 3) : [];
      var html = _hekCurrentEvents.map(function (e, i) {
        return _eventTileHTML(e, i === 0);
      }).join("");
      html += _customTileHTML(timeInput ? timeInput.value : "12:00");
      hekTileGrid.innerHTML = html;
      _hekSelectedRank = null;
      // Update subhead per state
      var sub = document.getElementById("hekPickerSub");
      if (sub) {
        if (!_hekCurrentEvents.length || (_hekCurrentEvents.length === 1 && _hekCurrentEvents[0].fallback)) {
          sub.textContent = "No notable events catalogued for " + dateStr + ". Use noon UTC or set a custom time.";
        } else {
          sub.textContent = "Top " + _hekCurrentEvents.length +
            " event" + (_hekCurrentEvents.length === 1 ? "" : "s") +
            " for " + dateStr + ", or set a custom time.";
        }
      }
    }

    function _selectHekTile(tile) {
      if (!tile) return;
      hekTileGrid.querySelectorAll('.hek-tile[role="radio"]').forEach(function (t) {
        t.setAttribute("aria-checked", "false");
        t.setAttribute("tabindex", "-1");
      });
      tile.setAttribute("aria-checked", "true");
      tile.setAttribute("tabindex", "0");  // roving tabindex follows selection
    }

    function _applyHekTimePick(timeStr, eventOrNull) {
      // Push the time into the canonical time input and re-trigger the
      // tile-thumbnail / preview pipeline. Mark the user as "not having
      // touched" the time so the latch doesn't fight subsequent picks.
      if (!timeInput) return;
      _userTouchedTime = false;
      if (timeInput.value !== timeStr) {
        timeInput.value = timeStr;
        timeInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // Mirror the chosen time into the fine-tune display so the
      // [-]/[+] starting point matches the picked event.
      _updateCustomTimeDisplay(timeStr);
      // Wavelength suggestion — only when picking a real event.
      if (eventOrNull) _applyWavelengthSuggestion(eventOrNull);
    }

    function _pickEventTile(tile) {
      var rank = parseInt(tile.getAttribute("data-hek-rank"), 10);
      var t = tile.getAttribute("data-hek-time") || "12:00";
      var event = _hekCurrentEvents[rank - 1] || null;
      _selectHekTile(tile);
      _hekSelectedRank = rank;
      _applyHekTimePick(t, event);
    }

    // Shared time-set helper used by both the [-]/[+] step buttons and
    // the native <input type="time"> exact picker. Mutates #solarTime
    // (without firing change yet), updates the display + exact input,
    // un-checks event radios, marks user-touched, schedules refresh.
    function _applyFineTuneTime(next) {
      if (!timeInput) return;
      timeInput.value = next;
      _updateCustomTimeDisplay(next);
      if (hekTileGrid) {
        hekTileGrid.querySelectorAll('.hek-tile[role="radio"]').forEach(function (t) {
          t.setAttribute("aria-checked", "false");
        });
      }
      _hekSelectedRank = "custom";
      _userTouchedTime = true;
      _scheduleFineTuneRefresh();
    }

    if (hekTileGrid) {
      hekTileGrid.addEventListener("click", function (e) {
        // [-] / [+] fine-tune buttons: ±5-min step, immediate display
        // update, debounced JPG-preview refresh.
        var stepBtn = e.target.closest(".hek-time-step");
        if (stepBtn) {
          var delta = parseInt(stepBtn.getAttribute("data-step"), 10) || 0;
          var current = (timeInput && timeInput.value) || "12:00";
          _applyFineTuneTime(_hhmmAddMinutes(current, delta));
          return;
        }
        var tile = e.target.closest(".hek-tile[role='radio']");
        if (!tile) return;
        _pickEventTile(tile);
      });

      // Native <input type="time"> exact-pick listener — delegated since
      // the input is rebuilt by _renderHekTiles on every date change.
      // Same flow as a [-]/[+] step: stamps #solarTime, updates the
      // display, un-checks radios, debounces the preview refresh.
      hekTileGrid.addEventListener("input", function (e) {
        var t = e.target.closest("#hekTimeExact");
        if (!t) return;
        var v = t.value;
        if (!/^\d{2}:\d{2}/.test(v)) return;
        _applyFineTuneTime(v.slice(0, 5));
      });

      // WAI-ARIA radiogroup keyboard pattern: arrow keys cycle through
      // role="radio" siblings (skipping the custom group), Home/End jump
      // to ends, Space/Enter activate the focused radio. Without this,
      // keyboard users could Tab through but not arrow-select, which
      // regresses Sam's editor-tablist precedent from May 2026.
      hekTileGrid.addEventListener("keydown", function (e) {
        var current = e.target.closest('.hek-tile[role="radio"]');
        if (!current) return;
        var radios = Array.prototype.slice.call(
          hekTileGrid.querySelectorAll('.hek-tile[role="radio"]')
        );
        if (!radios.length) return;
        var idx = radios.indexOf(current);
        var nextIdx = null;
        switch (e.key) {
          case "ArrowRight":
          case "ArrowDown":
            nextIdx = (idx + 1) % radios.length;
            break;
          case "ArrowLeft":
          case "ArrowUp":
            nextIdx = (idx - 1 + radios.length) % radios.length;
            break;
          case "Home":
            nextIdx = 0;
            break;
          case "End":
            nextIdx = radios.length - 1;
            break;
          case " ":
          case "Enter":
            e.preventDefault();
            _pickEventTile(current);
            return;
          default:
            return;
        }
        if (nextIdx !== null) {
          e.preventDefault();
          var next = radios[nextIdx];
          _pickEventTile(next);  // selection follows focus inside radiogroup
          next.focus({ preventScroll: false });
        }
      });
    }

    function fetchHEKEvents(dateStr) {
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return;
      // Skip the fixed landing default so we don't bust the noon-keyed
      // HQ + Printify-mockup caches on first paint.
      if (dateStr === "2014-10-24" && state.isDefaultActive) {
        if (hekPickerSection) hekPickerSection.classList.add("hidden");
        return;
      }
      var token = ++_hekFetchToken;
      _renderHekSkeleton();
      if (hekPickerSection) hekPickerSection.classList.remove("hidden");
      var sub = document.getElementById("hekPickerSub");
      if (sub) sub.textContent = "Looking up the day’s top events…";
      fetch("/api/hek/best_time?date=" + encodeURIComponent(dateStr), { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (token !== _hekFetchToken) return;
          if (!data) {
            _renderHekTiles({ events: [{
              rank: 1, rank_label: "Noon UTC (couldn't reach HEK)",
              time_utc: "12:00", peak_time_iso: dateStr + "T12:00:00",
              event_type: "Noon UTC", event_code: null, family: null, tier: 4,
              fallback: true,
            }] }, dateStr);
            return;
          }
          _renderHekTiles(data, dateStr);
          // Auto-fill the time. If the user has already set the time
          // input (e.g. via vibe-card preset), try to match it to one of
          // the returned events within 5 min and pre-check that tile —
          // gives the visual confirmation that the vibe card's choice
          // lined up with a real catalogued event. Otherwise pre-check
          // the top pick.
          var presetTime = timeInput && _userTouchedTime ? timeInput.value : null;
          var events = (data.events || []);
          var matchIdx = -1;
          if (presetTime && /^\d{2}:\d{2}/.test(presetTime)) {
            var presetMin = parseInt(presetTime.slice(0, 2), 10) * 60 +
                            parseInt(presetTime.slice(3, 5), 10);
            for (var i = 0; i < events.length; i++) {
              if (!events[i].time_utc) continue;
              var em = parseInt(events[i].time_utc.slice(0, 2), 10) * 60 +
                       parseInt(events[i].time_utc.slice(3, 5), 10);
              if (Math.abs(em - presetMin) <= 5) { matchIdx = i; break; }
            }
          }
          var picked = matchIdx >= 0 ? events[matchIdx] : (events[0] || null);
          if (picked && timeInput) {
            // Only overwrite the time field if there's no preset OR the
            // preset matches an event (in which case we snap to the
            // event's exact peak time).
            var shouldWriteTime = !presetTime || matchIdx >= 0;
            if (shouldWriteTime && timeInput.value !== picked.time_utc) {
              timeInput.value = picked.time_utc;
              timeInput.dispatchEvent(new Event("change", { bubbles: true }));
            }
            _updateCustomTimeDisplay(timeInput.value || picked.time_utc);
            var pickedRank = matchIdx >= 0 ? (matchIdx + 1) : 1;
            var pickedTile = hekTileGrid.querySelector('.hek-tile[data-hek-rank="' + pickedRank + '"]');
            if (pickedTile) pickedTile.setAttribute("aria-checked", "true");
            _hekSelectedRank = pickedRank;
            if (!_userTouchedWavelength) _applyWavelengthSuggestion(picked);
          } else if (timeInput) {
            // No events at all (edge case) — just update the display.
            _updateCustomTimeDisplay(timeInput.value || "12:00");
          }
        })
        .catch(function () {
          if (token !== _hekFetchToken) return;
          _renderHekTiles({ events: [{
            rank: 1, rank_label: "Noon UTC (couldn't reach HEK)",
            time_utc: "12:00", peak_time_iso: dateStr + "T12:00:00",
            event_type: "Noon UTC", event_code: null, family: null, tier: 4,
            fallback: true,
          }] }, dateStr);
        });
    }

    // Backward-compat alias (some earlier code paths reference fetchHEKBestTime).
    var fetchHEKBestTime = fetchHEKEvents;

    // Track explicit wavelength clicks so we don't override the user's
    // pick when a later HEK call suggests something else.
    if (wlGrid) {
      wlGrid.addEventListener("click", function (e) {
        if (e.target && e.target.closest(".wl-card")) {
          _userTouchedWavelength = true;
        }
      }, true);
    }

    // ── Vibe-grid card click handlers ──────────────────────────────
    // A vibe card pre-fills date + wavelength + time, then scrolls down
    // to the configurator and fires the existing pipeline. Today's card
    // gets its date set dynamically on landing.
    function _prefersReducedMotion() {
      try { return matchMedia("(prefers-reduced-motion: reduce)").matches; }
      catch (_e) { return false; }
    }
    // Manifest of pre-warmed HQ Raw + RHEF tiles. Populated async on load
    // from /asset/default/vibe_manifest.json. Used by the vibe cards to
    // (a) show the high-fidelity thumb instead of a Helioviewer JPG, and
    // (b) enable the per-card Raw/RHEF tier toggle once the narrative
    // master reveal has fired.
    var _vibeManifest = null;
    function _loadVibeManifest() {
      return fetch("/asset/default/vibe_manifest.json", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (json) {
          _vibeManifest = (json && json.vibes) ? json.vibes : null;
          _buildWlThumbCacheIndex();
          return _vibeManifest;
        });
    }

    // ── In-memory thumb URL → loaded Image() LRU cache ────────────
    // Per the rate-limit agent's recommendation: a small front-end
    // cache eliminates duplicate Helioviewer fetches when the user
    // toggles Raw/RHEF or fine-tunes the time. 20 entries × ~100KB
    // ≈ 2 MB; trivial. Eviction is FIFO via Map insertion order.
    var _THUMB_CACHE_MAX = 20;
    var _thumbCache = new Map();
    function _thumbCacheGet(url) {
      if (!_thumbCache.has(url)) return null;
      // Touch (re-insert) to push it to the back of the LRU order.
      var v = _thumbCache.get(url);
      _thumbCache.delete(url);
      _thumbCache.set(url, v);
      return v;
    }
    function _thumbCacheSet(url, img) {
      if (_thumbCache.has(url)) _thumbCache.delete(url);
      _thumbCache.set(url, img);
      while (_thumbCache.size > _THUMB_CACHE_MAX) {
        var first = _thumbCache.keys().next().value;
        _thumbCache.delete(first);
      }
    }

    // Pick the thumb URL for a vibe CARD and tier. Falls back to the
    // Helioviewer JPG when the manifest doesn't have the slug yet
    // (i.e., warm hasn't been run).
    //
    // Tier semantics (all three render at HQ in the vibe card now that
    // warm_vibe_jpg_hq.py + the HQ Raw/RHEF warm have populated the
    // slug-level *_full / jpg_hq fields):
    //   "jpg"  — 1024² Helioviewer JPG (jpg_hq_url). Falls back to the
    //            primary event's 256² jpg_thumb_url, then to the live
    //            Helioviewer proxy.
    //   "raw"  — 4096² FITS-derived percentile-clipped PNG
    //            (raw_full_url). Falls back to 256² raw_thumb_url.
    //   "rhef" — 4096² Radial Histogram Equalization Filter applied to
    //            the Raw (rhef_full_url). Falls back to 256²
    //            rhef_thumb_url.
    function _vibeThumbUrl(slug, tier, fallbackArgs) {
      tier = tier || "raw";
      var entry = _vibeManifest && _vibeManifest[slug];
      if (entry) {
        // HQ tiers (full-resolution master-toggle preview). Each falls
        // back to its 256² thumb if HQ isn't cached yet — this is what
        // happens on a fresh deploy before the HQ warm bundle uploads.
        if (tier === "raw") {
          return entry.raw_full_url || entry.raw_thumb_url || null;
        }
        if (tier === "rhef") {
          return entry.rhef_full_url || entry.rhef_thumb_url || null;
        }
        if (tier === "jpg") {
          // Prefer the 1024² HQ JPG cached by warm_vibe_jpg_hq.py.
          // Falls back to the primary-event/primary-wavelength 256²
          // jpg_thumb_url, then to the live Helioviewer proxy below.
          if (entry.jpg_hq_url) return entry.jpg_hq_url;
          var ev1 = (entry.events || [])[0];
          if (ev1 && ev1.wavelengths) {
            var primaryWl = String(fallbackArgs && fallbackArgs.wl ? fallbackArgs.wl : "171");
            var w = ev1.wavelengths[primaryWl] ||
                    ev1.wavelengths[Object.keys(ev1.wavelengths)[0]];
            if (w && w.jpg_thumb_url) return w.jpg_thumb_url;
          }
        }
      }
      // fallbackArgs = {date, wl, time}. Build a Helioviewer thumb URL.
      if (!fallbackArgs || !fallbackArgs.date) return null;
      var iso = fallbackArgs.date + "T" + (fallbackArgs.time || "12:00") + ":00Z";
      return API_BASE + "/api/helioviewer_thumb?date=" +
        encodeURIComponent(iso) + "&wavelength=" + encodeURIComponent(fallbackArgs.wl || "171") +
        "&image_scale=12&size=256";
    }

    // Cached-wavelength-thumb index: pre-built (tier, date, time, wl) →
    // cached URL map from the manifest's per-event wavelength entries.
    // Populated when _loadVibeManifest resolves; loadWavelengthThumbnails
    // checks it before falling back to /api/helioviewer_thumb so the
    // 9 wavelength tiles per click hit /var/data instead of Helioviewer.
    //
    // Three tiers populated when present in the manifest:
    //   "jpg"  → jpg_thumb_url   (always populated after Phase A warm)
    //   "raw"  → raw_thumb_url   (populated by Phase C MQ warm)
    //   "rhef" → rhef_thumb_url  (populated by Phase C MQ warm)
    var _wlThumbCacheIndex = {};
    function _buildWlThumbCacheIndex() {
      _wlThumbCacheIndex = {};
      if (!_vibeManifest) return;
      Object.keys(_vibeManifest).forEach(function (slug) {
        var v = _vibeManifest[slug];
        if (!v || !v.events || !v.date) return;
        v.events.forEach(function (ev) {
          if (!ev || !ev.wavelengths || !ev.time_utc) return;
          var keyPrefix = v.date + "T" + ev.time_utc + "/";
          Object.keys(ev.wavelengths).forEach(function (wl) {
            var w = ev.wavelengths[wl];
            if (!w) return;
            if (w.jpg_thumb_url)  _wlThumbCacheIndex["jpg/"  + keyPrefix + wl] = w.jpg_thumb_url;
            if (w.raw_thumb_url)  _wlThumbCacheIndex["raw/"  + keyPrefix + wl] = w.raw_thumb_url;
            if (w.rhef_thumb_url) _wlThumbCacheIndex["rhef/" + keyPrefix + wl] = w.rhef_thumb_url;
          });
        });
      });
    }
    // Tier-aware lookup. Tier defaults to the currently active master
    // toggle setting (state.vibeMasterTier); falls back through
    // rhef → raw → jpg if the requested tier isn't cached for this
    // combo, so the user always sees SOMETHING.
    function _cachedWavelengthThumb(dateStr, timeStr, wl, tier) {
      if (!dateStr || !timeStr) return null;
      tier = tier || (state && state.vibeMasterTier) || "jpg";
      var keyTail = dateStr + "T" + timeStr + "/" + wl;
      var url = _wlThumbCacheIndex[tier + "/" + keyTail];
      if (url) return url;
      // Fallback ladder: requested tier missing, try in graceful order.
      var ladder = (tier === "rhef") ? ["raw", "jpg"]
                 : (tier === "raw")  ? ["jpg", "rhef"]
                 :                     ["raw", "rhef"];  // tier === "jpg"
      for (var i = 0; i < ladder.length; i++) {
        url = _wlThumbCacheIndex[ladder[i] + "/" + keyTail];
        if (url) return url;
      }
      return null;
    }
    // (The pre-Phase-B 2-arg form lives in git history at the parent of
    // this commit; the new 4-arg form is back-compat — `tier` is
    // optional and defaults to the current master toggle.)
    // Expose for the loadWavelengthThumbnails consumer.
    try { window.SolarArchive = window.SolarArchive || {};
          window.SolarArchive.cachedWavelengthThumb = _cachedWavelengthThumb;
    } catch (_e) {}

    // Swap a card's thumb image. Uses the URL → Image() LRU cache so a
    // toggle from RHEF → Raw → RHEF doesn't re-fetch each time.
    function _setVibeThumb(card, url) {
      var thumbWell = card.querySelector(".vibe-thumb");
      if (!thumbWell || !url) return;
      var cached = _thumbCacheGet(url);
      if (cached) {
        thumbWell.classList.remove("is-loading");
        thumbWell.innerHTML = "";
        // Clone the cached node so each well has its own DOM element.
        var c = cached.cloneNode(false);
        c.alt = "";
        thumbWell.appendChild(c);
        return;
      }
      thumbWell.classList.add("is-loading");
      var img = new Image();
      img.alt = "";
      img.onload = function () {
        thumbWell.classList.remove("is-loading");
        thumbWell.innerHTML = "";
        thumbWell.appendChild(img);
        _thumbCacheSet(url, img);
      };
      img.onerror = function () { thumbWell.classList.remove("is-loading"); };
      img.src = url;
    }

    // Radial-wipe transition: layer the new-tier image on top of the
    // current thumb with clip-path: circle(0%), animate to circle(150%).
    // Once the animation ends, swap the underlying image and remove the
    // overlay. Used by the master "Reveal filtered view" button so all
    // six cards transition Raw → RHEF dramatically and simultaneously.
    function _runTierWipe(card, toTier) {
      return new Promise(function (resolve) {
        var slug = card.getAttribute("data-vibe-slug");
        if (!slug || slug === "birthday") return resolve();
        var thumbWell = card.querySelector(".vibe-thumb");
        if (!thumbWell) return resolve();
        var url = _vibeThumbUrl(toTier, toTier === "raw" ? "raw" : "rhef", {
          date: card.getAttribute("data-vibe-date") || "",
          wl:   card.getAttribute("data-vibe-wl") || "171",
          time: card.getAttribute("data-vibe-time") || "12:00",
        });
        // _vibeThumbUrl signature was (slug, tier, ...) — call properly:
        url = _vibeThumbUrl(slug, toTier, {
          date: card.getAttribute("data-vibe-date") || "",
          wl:   card.getAttribute("data-vibe-wl") || "171",
          time: card.getAttribute("data-vibe-time") || "12:00",
        });
        if (!url) return resolve();
        var overlay = new Image();
        overlay.alt = "";
        overlay.className = "vibe-thumb-overlay";
        overlay.onload = function () {
          thumbWell.appendChild(overlay);
          // Force a reflow so the starting clip-path value is committed
          // before we add the animation class.
          void overlay.offsetWidth;
          overlay.classList.add("is-wiping");
          var didDone = false;
          var done = function () {
            // Idempotency latch — `done` is called by BOTH the
            // animationend listener AND the 1.2s setTimeout fallback.
            // Without this guard the second call's
            // querySelector("img:not(.vibe-thumb-overlay)") matched the
            // just-promoted overlay (which had its class stripped on
            // the first call) and removed the only remaining image,
            // blanking the well.
            if (didDone) return;
            didDone = true;
            overlay.removeEventListener("animationend", done);
            // Promote overlay to the permanent thumb image.
            var prev = thumbWell.querySelector("img:not(.vibe-thumb-overlay)");
            if (prev) prev.remove();
            overlay.classList.remove("is-wiping", "vibe-thumb-overlay");
            overlay.style.clipPath = "none";
            _thumbCacheSet(url, overlay);
            card.setAttribute("data-vibe-active-tier", toTier);
            // Update any per-card toggle UI if present (legacy path).
            card.querySelectorAll(".vibe-tier-btn").forEach(function (b) {
              var on = b.getAttribute("data-tier") === toTier;
              b.classList.toggle("is-active", on);
              b.setAttribute("aria-pressed", on ? "true" : "false");
            });
            resolve();
          };
          // Handle reduced-motion (animation may not fire animationend).
          if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
            setTimeout(done, 0);
          } else {
            overlay.addEventListener("animationend", done);
            // Safety: if animationend doesn't fire (e.g. tab hidden),
            // finish manually after 1.2 s.
            setTimeout(done, 1200);
          }
        };
        overlay.onerror = function () { resolve(); };
        overlay.src = url;
      });
    }

    function _wireVibeGrid() {
      var grid = document.querySelector(".vibe-grid");
      if (!grid) return;
      // (Recent-corona's dynamic today-2 date is gone; all 5 static
      // vibes have hardcoded dates now. The 6th is the birthday card.)
      // Set the birthday-input's max to today's UTC date (so users can't
      // pick a future date that has no data).
      var bdayInput = document.getElementById("vibeBirthdayInput");
      if (bdayInput) {
        var maxD = new Date(); maxD.setUTCDate(maxD.getUTCDate() - 1);
        bdayInput.max = maxD.toISOString().slice(0, 10);
      }

      // Initial thumb load (manifest first, fall back to Helioviewer).
      // Cards START in Raw — the narrative reveal flips them to RHEF.
      _loadVibeManifest().then(function () {
        var anyHasTiers = false;
        grid.querySelectorAll(".vibe-card[data-vibe-slug]").forEach(function (card) {
          var slug = card.getAttribute("data-vibe-slug");
          if (slug === "birthday") return;
          var entry = _vibeManifest && _vibeManifest[slug];
          var hasBoth = entry && entry.raw_thumb_url && entry.rhef_thumb_url;
          if (hasBoth) { card.classList.add("has-tiers"); anyHasTiers = true; }
          var date = card.getAttribute("data-vibe-date") || "";
          var wl = card.getAttribute("data-vibe-wl") || "171";
          var time = card.getAttribute("data-vibe-time") || "12:00";
          // Start in Raw. Fall back to Helioviewer JPG if manifest absent.
          var url = _vibeThumbUrl(slug, "raw", { date: date, wl: wl, time: time });
          _setVibeThumb(card, url);
          card.setAttribute("data-vibe-active-tier", "raw");
        });
        // Reveal the master "Click here for the filtered view" CTA only
        // if at least one card has both tiers available (otherwise the
        // narrative would lie). When the warm hasn't run, cards just
        // show Raw (Helioviewer fallback) and no CTA appears.
        var cta = document.getElementById("vibeRevealCta");
        if (cta && anyHasTiers) cta.classList.remove("hidden");
      });

      // Master "swap-all-cards" runner — used by both the initial
      // reveal click and the subsequent Raw/RHEF master toggle.
      function _wipeAllCards(toTier) {
        var cards = grid.querySelectorAll(".vibe-card.has-tiers");
        if (!cards.length) return;
        var staggerMs = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 90;
        cards.forEach(function (card, i) {
          if (card.getAttribute("data-vibe-active-tier") === toTier) return;
          setTimeout(function () { _runTierWipe(card, toTier); }, i * staggerMs);
        });
      }

      // Wire the master reveal — first click runs the cascade Raw → RHEF,
      // then swaps the pulsing button for the segmented Raw/RHEF pill.
      // Subsequent clicks on the pill swap all cards in sync.
      var revealBtn = document.getElementById("vibeRevealBtn");
      var revealCta = document.getElementById("vibeRevealCta");
      var masterToggle = document.getElementById("vibeMasterToggle");
      if (revealBtn && revealCta) {
        revealBtn.addEventListener("click", function () {
          revealBtn.disabled = true;
          _wipeAllCards("rhef");
          state.vibeMasterTier = "rhef";  // first reveal commits to RHEF
          // After the last wipe starts, swap the button for the pill.
          var cardCount = grid.querySelectorAll(".vibe-card.has-tiers").length;
          var fadeDelay = (cardCount * 90) + 200;
          setTimeout(function () {
            revealBtn.classList.add("hidden");
            if (masterToggle) masterToggle.classList.remove("hidden");
            // Reload wavelength tiles in RHEF if any are visible.
            if (typeof loadWavelengthThumbnails === "function") {
              try { lastThumbDate = ""; } catch (_e) {}
              loadWavelengthThumbnails();
            }
          }, fadeDelay);
        });
      }
      if (masterToggle) {
        masterToggle.addEventListener("click", function (e) {
          var btn = e.target.closest(".vibe-master-btn");
          if (!btn) return;
          var tier = btn.getAttribute("data-tier");
          // Update aria-pressed + active styling.
          masterToggle.querySelectorAll(".vibe-master-btn").forEach(function (b) {
            var on = b === btn;
            b.classList.toggle("is-active", on);
            b.setAttribute("aria-pressed", on ? "true" : "false");
          });
          // Stamp the current tier on global state so other consumers
          // (wavelength tile loader, future editor-preview pipe) read
          // a single source of truth instead of guessing from DOM.
          state.vibeMasterTier = tier;
          _wipeAllCards(tier);
          // Reload the wavelength tile thumbnails to pick up the new
          // tier — they consult state.vibeMasterTier via
          // _cachedWavelengthThumb. Without this the tiles still show
          // whatever tier was loaded last (often JPG, since they're
          // typically loaded once on date change).
          if (typeof loadWavelengthThumbnails === "function") {
            // Force a reload by clearing the per-date load latch.
            try { lastThumbDate = ""; } catch (_e) {}
            loadWavelengthThumbnails();
          }
        });
      }
      // Initial master tier — cards start in Raw (matches the
      // reveal-button default which wipes Raw → RHEF on first click).
      state.vibeMasterTier = state.vibeMasterTier || "raw";

      // Per-card click delegate. The per-card Raw/RHEF toggle was
      // removed in favour of a single master toggle at the section
      // top; this listener only handles the info-popover button + the
      // main vibe-open card click now.
      grid.addEventListener("click", function (e) {
        // Info-button — toggle the attribution popover.
        var infoBtn = e.target.closest(".vibe-info-btn");
        if (infoBtn) {
          e.stopPropagation();
          var ccard = infoBtn.closest(".vibe-card");
          _toggleVibeInfo(ccard, infoBtn);
          return;
        }
        // Anything else inside the popover (close button or link).
        var infoClose = e.target.closest(".vibe-info-close");
        if (infoClose) {
          e.stopPropagation();
          var pop = infoClose.closest(".vibe-info-popover");
          if (pop) pop.classList.add("hidden");
          return;
        }
        // Main "open" click (vibe-open button OR anywhere outside controls).
        var openBtn = e.target.closest(".vibe-open");
        var card2 = openBtn && openBtn.closest(".vibe-card");
        if (!card2) return;
        _activateVibe(card2);
      });

      // Birthday-card date input — change-event-triggered, no submit button.
      if (bdayInput) {
        bdayInput.addEventListener("change", function () {
          if (!bdayInput.value) return;
          // Build a synthetic vibe payload and run _activateVibe to share
          // the same flow (HEK fetch, scroll, focus, etc.).
          var card = bdayInput.closest(".vibe-card");
          card.setAttribute("data-vibe-date", bdayInput.value);
          card.setAttribute("data-vibe-time", "");  // let HEK auto-fill
          card.setAttribute("data-vibe-wl", "");    // let HEK suggest
          _activateVibe(card, { fromBirthday: true });
        });
      }
    }

    function _activateVibe(card, opts) {
      opts = opts || {};
      var date = card.getAttribute("data-vibe-date") || "";
      var wlRaw = card.getAttribute("data-vibe-wl");
      var wl = wlRaw ? parseInt(wlRaw, 10) : null;
      var time = card.getAttribute("data-vibe-time") || "";
      if (!date) return;
      state.isDefaultActive = false;
      // Dispatch date change first (resets latches and triggers HEK fetch).
      if (dateInput) {
        dateInput.value = date;
        dateInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      // If this card carries a preset time, stamp it AFTER the date-change
      // latch-reset so the vibe-card's choice sticks. Birthday card has
      // no preset time — leave HEK to auto-fill the top pick.
      if (time) {
        _userTouchedTime = true;
        if (timeInput) {
          timeInput.value = time;
          timeInput.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      // If this card carries a preset wavelength, click that tile to
      // trigger the existing pipeline. If not (birthday card), the user
      // picks a wavelength manually after the HEK suggestion fires.
      // Scroll first, THEN fire the wavelength-tile click.
      //
      // Tap-a-vibe-card was visually a no-op on prod because the order
      // was inverted: a smooth `scrollIntoView` launched, then 50 ms
      // later wlTile.click() called loadHelioviewerPreview which
      // un-hid #productSection — and that mid-flight DOM mutation
      // CANCELS the running smooth scroll, leaving scrollY at 0. From
      // the user's seat: state changed correctly under the hood but
      // the page didn't move. No console error, no clue.
      //
      // Fix: snap-scroll (behavior:"auto") completes synchronously
      // before the wavelength-tile click mutates the layout, so the
      // scroll lands at the right offset every time. Reduced-motion
      // users were already on "auto"; sighted users lose the gentle
      // glide but actually see the section they tapped into — net
      // win.
      var configSection = wlGrid && wlGrid.closest(".section");
      if (configSection) {
        configSection.scrollIntoView({ behavior: "auto", block: "start" });
      }
      // Suppress the wavelength-click's default scroll-to-products so
      // the user lands on section 1 (the HEK picker), not pushed past
      // it to the editor / product grid below.
      if (wl) {
        _userTouchedWavelength = true;
        var wlTile = wlGrid && wlGrid.querySelector('.wl-card[data-wl="' + wl + '"]');
        if (wlTile) setTimeout(function () {
          state.suppressNextProductScroll = true;
          wlTile.click();
        }, 50);
      }
      if (configSection) {
        setTimeout(function () {
          var target = hekTileGrid && hekTileGrid.querySelector('.hek-tile[role="radio"]') ||
                       document.getElementById("solarTime") ||
                       configSection;
          if (target && typeof target.focus === "function") {
            try { target.focus({ preventScroll: true }); } catch (_e) {}
          }
        }, _prefersReducedMotion() ? 50 : 400);
      }
    }

    // Attribution popover content per slug. Light HTML kept inline; nothing
    // user-supplied so this is safe to insertAdjacentHTML.
    var _VIBE_INFO = {
      ar2192: {
        title: "AR 2192 — October 24, 2014",
        body: 'Active Region 2192 was the largest sunspot group since November 1990. ' +
              'Image: NASA/SDO/AIA 193 Å, ' + CITATIONS.SDO_ACK + ' Lemen et al. 2012 (Sol. Phys. 275, 17). ' +
              'RHEF tier: Gilly et al. 2025 (Sol. Phys. 300, 174).'
      },
      x93_flare: {
        title: "X9.3 flare — September 6, 2017",
        body: 'Solar Cycle 24\'s largest X-ray flare. Peak GOES class X9.3 at 11:53 UTC. ' +
              'Shown at 211 Å (Fe XIV ~2 MK) rather than 131 Å, which saturates at flare peaks. ' +
              CITATIONS.SDO_ACK + ' Lemen et al. 2012. RHEF tier: Gilly et al. 2025.'
      },
      mothers_day_storm: {
        title: "Mother's Day storm — May 10, 2024",
        body: 'G5 geomagnetic storm from active region 13664, the strongest since 2003. ' +
              'Image: NASA/SDO/AIA 193 Å, ' + CITATIONS.SDO_ACK + ' Lemen et al. 2012. ' +
              'RHEF tier: Gilly et al. 2025.'
      },
      limb_x82_flare: {
        title: "Limb X8.2 flare — September 10, 2017",
        body: 'Off-limb X8.2 flare, four days after the X9.3 on the same active region (12673). ' +
              'The post-flare arcade off the limb is one of the most iconic images of the SDO era. ' +
              'Shown at 211 Å to avoid 131 Å saturation. ' +
              CITATIONS.SDO_ACK + ' Lemen et al. 2012. RHEF tier: Gilly et al. 2025.'
      },
      monster_prominence: {
        title: "Monster prominence — August 31, 2012",
        body: 'Iconic prominence eruption captured in 304 Å He II — sometimes called the ' +
              '"Goes Out" CME. ' + CITATIONS.SDO_ACK + ' Lemen et al. 2012. RHEF tier: Gilly et al. 2025.'
      },
      pre_x93_powderkeg: {
        title: "AR 12673 brewing — September 4, 2017",
        body: 'Active Region 12673 two days before its X9.3 flare. The hottest coronal loops ' +
              '(6 MK Fe XVIII) glow in 94 Å, foreshadowing what was coming. ' +
              CITATIONS.SDO_ACK + ' Lemen et al. 2012. RHEF tier: Gilly et al. 2025.'
      },
      post_flare_arcade: {
        title: "Post-flare arcade — July 19, 2012",
        body: 'M7.7 limb event with the textbook post-flare arcade — magnetic loops reconnecting ' +
              'and cooling into the 131 Å Fe XXI band (~10 MK). One of the most-shared SDO ' +
              'images from cycle 24\'s rising phase. ' +
              CITATIONS.SDO_ACK + ' Lemen et al. 2012. RHEF tier: Gilly et al. 2025.'
      },
      great_sympathetic_eruption: {
        title: "Great sympathetic eruption — August 1, 2010",
        body: 'Schrijver & Title (2011) called this "the great connected eruption" — a cascade ' +
              'of filament lifts and CMEs across the entire visible disk, linked by long-range ' +
              'magnetic connections. 171 Å reveals the warm-corona loop network that carried the cascade. ' +
              CITATIONS.SDO_ACK + ' Lemen et al. 2012. RHEF tier: Gilly et al. 2025.'
      },
      ar13664_emergence: {
        title: "AR 13664 emerges — May 8, 2024",
        body: 'Active region 13664 two days before it caused the Mother\'s Day G5 geomagnetic ' +
              'storm. Shown at 335 Å (Fe XVI, ~2.5 MK) which catches the active-region core ' +
              'as it organized. ' + CITATIONS.SDO_ACK + ' Lemen et al. 2012. RHEF tier: Gilly et al. 2025.'
      },
      x16_flare_ribbons: {
        title: "X1.6 flare ribbons — September 10, 2014",
        body: 'The X1.6 flare from AR 12158 with textbook two-ribbon structure in the ' +
              'chromospheric 1600 Å band. Flare ribbons trace footprints of the reconnection ' +
              'sheet where magnetic energy is released. ' +
              CITATIONS.SDO_ACK + ' Lemen et al. 2012. RHEF tier: Gilly et al. 2025.'
      },
      ar2192_photosphere: {
        title: "AR 2192 in deep UV — October 24, 2014",
        body: 'The same monster sunspot as the AR 2192 card, seen in 1700 Å (UV continuum from ' +
              'the temperature-minimum region, ~5000 K). Where 193 Å shows the corona above, ' +
              '1700 Å shows the photospheric sunspot itself. ' +
              CITATIONS.SDO_ACK + ' Lemen et al. 2012. RHEF tier: Gilly et al. 2025.'
      }
    };
    function _toggleVibeInfo(card, btn) {
      if (!card) return;
      var existing = card.querySelector(".vibe-info-popover");
      if (existing) {
        existing.classList.toggle("hidden");
        return;
      }
      var slug = card.getAttribute("data-vibe-slug");
      var info = _VIBE_INFO[slug] || {
        title: "Image attribution",
        body: CITATIONS.SDO_ACK + ' Lemen et al. 2012.'
      };
      var pop = document.createElement("div");
      pop.className = "vibe-info-popover";
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", info.title);
      pop.innerHTML =
        '<button type="button" class="vibe-info-close" aria-label="Close attribution">&times;</button>' +
        '<h4>' + escapeHtml(info.title) + '</h4>' +
        '<p>' + info.body + '</p>';  // body is template-controlled, not user input
      card.appendChild(pop);
    }
    _wireVibeGrid();

    // Expose for debugging / future callers (e.g. the birthday CTA).
    try { window.SolarArchive = window.SolarArchive || {}; window.SolarArchive.fetchHEKBestTime = fetchHEKEvents; window.SolarArchive.fetchHEKEvents = fetchHEKEvents; } catch (_e) {}

    function _resetTouchedLatchesForNewDate() {
      // A fresh date means previous time / wavelength choices were for a
      // DIFFERENT day's events; clearing the latches lets HEK + the
      // wavelength-suggest caption do their job again. Without this, a
      // vibe-card click would permanently suppress suggestions for the
      // rest of the session.
      _userTouchedTime = false;
      _userTouchedWavelength = false;
      _lastSuggestionKey = "";
      if (wlGrid) {
        wlGrid.querySelectorAll(".wl-card.is-suggested").forEach(function (el) {
          el.classList.remove("is-suggested");
        });
      }
    }

    if (dateInput) {
      dateInput.addEventListener("change", function () {
        if (dateInput.value !== "2014-10-24") state.isDefaultActive = false;
        _resetTouchedLatchesForNewDate();
        fetchHEKBestTime(dateInput.value);
        loadWavelengthThumbnails();
      });
      var _dateInputTimer = null;
      dateInput.addEventListener("input", function() {
        clearTimeout(_dateInputTimer);
        _dateInputTimer = setTimeout(function () {
          if (dateInput.value !== "2014-10-24") state.isDefaultActive = false;
          _resetTouchedLatchesForNewDate();
          fetchHEKBestTime(dateInput.value);
          loadWavelengthThumbnails();
        }, 250);
      });
    }
    // Time changes: same flow as date, since JPG previews and FITS queries
    // are now anchored to the user-picked time of day. We re-load the
    // wavelength thumbnails (Helioviewer JPGs) and let any active wave
    // re-trigger a preview fetch through the existing date pipeline.
    if (timeInput) {
      timeInput.addEventListener("change", loadWavelengthThumbnails);
    }
    if (dateInput) {
      // Default to one week ago so users see wavelength tiles on first paint
      // AND land on a date where the HQ RHEF science images are reliably
      // available. The JPG previews publish within hours of observation, but
      // the full-resolution FITS pipeline (needed for "HQ RHEF" and print-
      // quality output) takes a few days to catch up — so defaulting to today
      // produces a good preview but can strand checkout waiting for HQ to
      // exist. A 7-day lag sidesteps that without confusing anyone.
      if (!dateInput.value) {
        // Default to a famously photogenic day — AR 2192, the largest
        // sunspot group in 24 years (2014-10-24) — so the landing page
        // and product mockups show a stunning sun out of the gate
        // instead of a quiet 1-week-ago disk. A FIXED date means every
        // visitor shares the same server-side HQ cache, so it's cheap
        // after the first render. Users change it to their own moment.
        dateInput.value = "2014-10-24";
        // Fire change so the tile-thumbnail pipeline runs immediately.
        dateInput.dispatchEvent(new Event("change", { bubbles: true }));
        // Preload the default wavelength (193) so the product tiles
        // render real mockups of the default sun on landing — no tile
        // click required. Mark the 193 tile selected to match. We do
        // NOT set scrollToProductsOnLoad, so the page doesn't yank the
        // user down; the mockups just populate in place below.
        state.wavelength = 193;
        var _defTile = wlGrid && wlGrid.querySelector('.wl-card[data-wl="193"]');
        if (_defTile) _defTile.classList.add("selected");
        // Probe for the pre-rendered HQ-RHEF of the default tuple on the
        // server's persistent disk (Phase A — see /api/admin/warm_default).
        // If present, prime hqCache + state so the very next HQ check
        // short-circuits to the cached PNG instead of running the 1–3 min
        // pipeline. Cache MISS is fine — the server's do_generate_sync
        // self-restores from /var/data on the eventual HQ request anyway.
        // Fetch the pre-rendered REAL Printify mockup manifest (Phase B).
        // When present, renderProducts will render <img> tiles instead of
        // the JS canvas approximations for the default landing image.
        // Missing / 404 is fine — falls through to the canvas mockups.
        (function _fetchDefaultMockupManifest() {
          fetch("/asset/default/default_mockups.json", { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (json) {
              if (!json || typeof json !== "object") return;
              // setter — `defaultMockupManifest` is a `let` binding in
              // state.js and module imports are read-only from outside
              // the declaring module.
              setDefaultMockupManifest(json);
              if (typeof renderProducts === "function" && state.isDefaultActive) {
                renderProducts();
              }
              // Race-safety: a user who selected a product BEFORE the
              // manifest fetch returned would still see the buy/download
              // button disabled. Re-run the gate now that the Phase B
              // manifest is in memory — _hasRealMockup will pick it up.
              if (state.isDefaultActive && state.selectedProduct) {
                if (typeof updateBuyButtonState === "function") updateBuyButtonState();
                if (typeof _applyBetaModeUI === "function") _applyBetaModeUI();
              }
            })
            .catch(function () { /* not warmed yet — fine */ });
        })();
        (function _primeDefaultHQ() {
          var defaultUrl = "/asset/hq_SDO_193_20141024.png";
          var probe = new Image();
          probe.crossOrigin = "anonymous";
          probe.onload = function () {
            try {
              if (typeof hqCache !== "undefined") {
                var cacheKey = "2014-10-24T12:00_193_hq_rhef";
                hqCache[cacheKey] = { url: defaultUrl, imageObj: probe };
              }
              state.hqReady = true;
              state.hqImageUrl = defaultUrl;
              state.hqFilterImage = probe;
              state.hqFormat = "rhef";
              if (typeof _hqApplyUpgrade === "function") {
                try { _hqApplyUpgrade("rhef"); } catch (_e) {}
              }
              if (typeof renderProducts === "function") renderProducts();
              if (typeof updateSendToPrintifyButton === "function") updateSendToPrintifyButton();
              if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
            } catch (_e) { /* prime failed; cold path still works */ }
          };
          probe.onerror = function () { /* not cached yet — fine */ };
          probe.src = defaultUrl;
        })();
        if (typeof loadHelioviewerPreview === "function") {
          loadHelioviewerPreview(193, dateInput.value);
        }
      }
    }

    // Eager-render the product grid pre-image so users can browse the catalog
    // while a wavelength image is loading (or before they even pick one). The
    // cards render with their fa-icon placeholders; renderProducts() already
    // handles the no-image case by disabling the Select buttons and showing
    // "Select wavelength first". Once an image loads, renderProducts() is
    // called again and upgrades each card to its canvas/Printify mockup.
    if (productSection) {
      productSection.classList.remove("hidden");
      if (typeof renderProducts === "function") renderProducts();
    }

    // ── Toast ────────────────────────────────────────────────────
    var toastTimer = null;
    function showToast(msg, type) {
      type = type || "success";
      toastEl.textContent = msg;
      toastEl.className = "toast " + type;
      requestAnimationFrame(function() { toastEl.classList.add("show"); });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function() { toastEl.classList.remove("show"); }, 4000);

      // Update ARIA live region for screen readers. Errors go to the
      // assertive companion (#alertRegion) so they interrupt AT;
      // everything else stays polite via #statusRegion. Sam P1 round-2
      // (WCAG 4.1.3) — polite alone risks missed messages on critical
      // failures (failed download, generation failure).
      if (type === "error") {
        announceAlert(msg);
      } else {
        var statusRegion = document.getElementById("statusRegion");
        if (statusRegion) statusRegion.textContent = msg;
      }
    }

    // Assertive a11y announcer (Sam P1 round-2, WCAG 4.1.3). Writes to
    // #alertRegion which is role="alert" + aria-live="assertive".
    // Clear-then-set so consecutive identical messages re-announce.
    function announceAlert(msg) {
      var el = document.getElementById("alertRegion");
      if (!el) return;
      el.textContent = "";
      setTimeout(function() { el.textContent = String(msg || ""); }, 50);
    }

    // ── Custom modals (no alert/confirm/prompt) ──────────────────
    function showModal(title, message, onConfirm, confirmText, loadingText) {
      confirmText = confirmText || "OK";
      // Beta testers reported the confirm button gave no feedback that compute
      // had started — modal vanished instantly and the long-running work
      // behind it (image compositing, Printify upload, Shopify publish) felt
      // stalled. Button now swaps to a spinner + loadingText label the moment
      // it's clicked; modal stays open until the onConfirm's returned Promise
      // settles (or, for legacy non-Promise callbacks, for a short hold so
      // the spinner is perceptible before handoff to downstream UI).
      loadingText = loadingText || "Working\u2026";
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML =
        '<div class="modal-box">' +
          "<h3>" + title + "</h3>" +
          "<p>" + message + "</p>" +
          '<div class="modal-actions">' +
            '<button class="btn-cancel">Cancel</button>' +
            '<button class="btn-confirm">' + confirmText + "</button>" +
          "</div>" +
        "</div>";
      document.body.appendChild(overlay);
      // Embedded mode: overlay flows inline, so scroll to it.
      if (document.documentElement.classList.contains("embedded")) {
        try { overlay.scrollIntoView({ behavior: "smooth", block: "center" }); }
        catch (_e) { overlay.scrollIntoView(); }
      }
      var btnCancel = overlay.querySelector(".btn-cancel");
      var btnConfirm = overlay.querySelector(".btn-confirm");
      btnCancel.addEventListener("click", function() {
        overlay.remove();
      });
      btnConfirm.addEventListener("click", function() {
        // Lock both buttons so double-clicks can't fire onConfirm twice and
        // the user can't cancel out halfway through a side-effecting call.
        btnConfirm.disabled = true;
        btnCancel.disabled = true;
        btnConfirm.classList.add("is-loading");
        btnConfirm.innerHTML = '<span class="btn-spinner"></span> ' + loadingText;

        var closed = false;
        function closeOnce() { if (!closed) { closed = true; overlay.remove(); } }

        var result;
        try {
          result = onConfirm ? onConfirm() : undefined;
        } catch (err) {
          closeOnce();
          throw err;
        }
        if (result && typeof result.then === "function") {
          result.then(closeOnce, closeOnce);
        } else {
          // Legacy sync callback: let the browser paint the spinner frame,
          // then hold briefly so the state change is visible before close.
          requestAnimationFrame(function() {
            setTimeout(closeOnce, 350);
          });
        }
      });
    }

    // Small HTML-escape helper. Used wherever we still need to
    // interpolate user/server-derived strings into an innerHTML
    // template (mockup status line, etc). Round-2 security audit
    // (Mira Sokolov, P0 HIGH) flagged unescaped interpolation as a
    // DOM XSS sink — keep this function in the same closure scope as
    // showInfo so refactor callers find it next to the other UI
    // helpers.
    function escapeHtml(s) {
      return String(s == null ? "" : s).replace(/[&<>"']/g, function(c) {
        return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c];
      });
    }

    // showInfo(title, message, opts)
    //   - title is always treated as text (safe-by-default).
    //   - message defaults to text. Pass opts={html:true} to opt in
    //     to HTML rendering — only safe for developer-authored strings
    //     (e.g. the Data credits modal). Any caller passing
    //     server/network-derived content MUST leave opts unset.
    // Round-2 security audit (Mira Sokolov, P0 HIGH): previously this
    // function string-concatenated title+message into innerHTML, so
    // any server-derived message (e.g. an HQ RHEF error from the
    // backend, a network error message) was an XSS sink. Inverting
    // the default to text-with-opt-in-HTML kills that class of bug.
    function showInfo(title, message, opts) {
      opts = opts || {};
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      var box = document.createElement("div");
      box.className = "modal-box";
      var h3 = document.createElement("h3");
      h3.textContent = String(title == null ? "" : title);
      var p = document.createElement("p");
      if (opts.html === true) {
        p.innerHTML = String(message == null ? "" : message);
      } else {
        p.textContent = String(message == null ? "" : message);
        // Honour \n separators in plain-text messages (the HQ RHEF
        // dialog uses them to break paragraphs).
        p.style.whiteSpace = "pre-line";
      }
      var actions = document.createElement("div");
      actions.className = "modal-actions";
      var btn = document.createElement("button");
      btn.className = "btn-confirm";
      btn.textContent = "OK";
      actions.appendChild(btn);
      box.appendChild(h3);
      box.appendChild(p);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      function _closeOverlay() {
        _unregisterCenteredOverlay(overlay);
        overlay.remove();
      }
      btn.addEventListener("click", _closeOverlay);
      // Embedded mode: a content-sized iframe can't use a fixed overlay
      // (it wouldn't track the parent's scroll). Position absolutely
      // centred in the parent's visible window (_lastVisibleTop /
      // _lastVisibleBottom from the viewport postMessage), register it so
      // the message handler re-centres on every scroll → the modal
      // FLOATS at the visible centre until closed. Falls back to
      // scrollIntoView when no viewport offset is known yet.
      if (document.documentElement.classList.contains("embedded")) {
        if (typeof _lastVisibleTop === "number" && isFinite(_lastVisibleTop)) {
          overlay.style.position = "absolute";
          overlay.style.left = "0";
          overlay.style.right = "0";
          overlay.style.margin = "0 auto";
          overlay.style.zIndex = "9995";
          _registerCenteredOverlay(overlay);
        } else {
          try { overlay.scrollIntoView({ behavior: "smooth", block: "center" }); }
          catch (_e) { overlay.scrollIntoView(); }
        }
      }
    }

    // ── Progress helpers ─────────────────────────────────────────
    function setProgress(pct) {
      progressTrack.classList.add("active");
      progressFill.style.width = pct + "%";
    }

    function hideProgress() {
      progressTrack.classList.remove("active");
      progressFill.style.width = "0%";
    }

    function setStatus(msg, loading) {
      statusMsg.innerHTML = (loading ? '<div class="spinner"></div>' : "") + msg;
    }

    // ── Filter status line ──────────────────────────────────────
    // The Quality timeline (JPG / Raw / RHEF / HQ RHEF stepper) already
    // tells the user which tier is loading / ready / active, with a
    // spinner next to the "Quality" label while anything is in flight.
    // The big "Full-res RHEF rendering…" bar duplicated that signal,
    // so it's now suppressed; errors fall through to showToast() which
    // is the existing transient-error path. Pass-through stub keeps
    // the call sites quiet.
    var _filterStatusTimer = null;
    function updateFilterStatusLine(msg, type) {
      var el = document.getElementById("filterStatusLine");
      if (el) { el.style.display = "none"; el.textContent = ""; el.className = "filter-status-line"; }
      if (type === "error" && msg && typeof showToast === "function") showToast(msg, "error");
      // Announce filter-progress messages to screen readers via the
      // polite aria-live region. The visible status indicator is the
      // Quality timeline above the canvas — sighted users see it
      // there — but AT users wouldn't hear anything otherwise.
      // Filtered to non-empty messages and skipping the redundant
      // "error" path (showToast above already announces those).
      if (msg && type !== "error") {
        var statusRegion = document.getElementById("statusRegion");
        if (statusRegion && statusRegion.textContent !== msg) {
          statusRegion.textContent = msg;
        }
      }
    }
    // Legacy impl preserved so re-enabling the inline bar later is a one-line swap.
    function _legacyUpdateFilterStatusLine(msg, type) {
      var el = document.getElementById("filterStatusLine");
      if (!el) return;
      clearTimeout(_filterStatusTimer);
      if (!msg || type === "hidden") {
        el.style.display = "none";
        el.textContent = "";
        el.className = "filter-status-line";
        return;
      }
      var prefix = type === "loading" ? "\u23f3 " : type === "success" ? "\u2713 " : type === "error" ? "\u26a0 " : "";
      el.textContent = prefix + msg;
      el.className = "filter-status-line " + (type || "");
      el.style.display = "block";
      if (type === "success") {
        _filterStatusTimer = setTimeout(function() {
          el.style.display = "none";
        }, 4000);
      }
    }

    // ── HQ ETA bookkeeping ──────────────────────────────────────
    // The HQ RHEF render runs on the backend (FITS download → log10 →
    // colour LUT → RHEF filter → save PNG) and takes ~90s on a warm
    // FITS cache, longer cold. To make the wait less ambiguous we
    // stamp a start time the moment hqFetching flips on, then tick
    // a "elapsed / estimate" readout into the same loading indicator.
    var _HQ_TYPICAL_SECONDS = 120;  // ~2 min on a warm cache
    var _HQ_LONG_SECONDS = 300;     // 5 min — beyond this we soften the estimate
    var _hqEtaTickHandle = null;
    var _lastHqFetching = false;
    function _formatMmSs(totalSec) {
      totalSec = Math.max(0, Math.round(totalSec));
      var m = Math.floor(totalSec / 60);
      var s = totalSec - m * 60;
      return m + "m " + (s < 10 ? "0" : "") + s + "s";
    }
    function updateRhefLoadingUI() {
      var el = document.getElementById("filterLoadingIndicator");
      // HQ ETA: stamp start the first tick we see hqFetching flip on,
      // clear it when we see it flip off.
      if (state.hqFetching && !_lastHqFetching) {
        state._hqStartedAt = Date.now();
      } else if (!state.hqFetching && _lastHqFetching) {
        state._hqStartedAt = null;
      }
      _lastHqFetching = !!state.hqFetching;
      if (el) {
        if (state.rhefFetching || state.hqFetching) {
          el.classList.remove("hidden");
          // Compose the indicator label based on what's running:
          //  • Queue depth > 1 (someone else is rendering ahead of us)
          //    → "Queued · N ahead"
          //  • HQ in flight (depth 0 or 1, our slot)
          //    → "HQ render · elapsed / ~ETA"
          //  • Plain RHEF preview → "Processing…" (fast enough that an
          //    ETA isn't worth the visual churn).
          var qd = state._hqQueueDepth || 0;
          if (state.hqFetching && qd > 1) {
            // qd includes us. "ahead" = qd - 1.
            var ahead = qd - 1;
            el.innerHTML = '<span class="filter-loading-spinner"></span> Queued &middot; ' +
                            ahead + ' ahead';
          } else if (state.hqFetching && state._hqStartedAt) {
            var elapsed = (Date.now() - state._hqStartedAt) / 1000;
            var labelHtml;
            if (elapsed < _HQ_TYPICAL_SECONDS) {
              labelHtml = '<span class="filter-loading-spinner"></span> HQ render · ' +
                          _formatMmSs(elapsed) + ' / ~' + _formatMmSs(_HQ_TYPICAL_SECONDS);
            } else if (elapsed < _HQ_LONG_SECONDS) {
              labelHtml = '<span class="filter-loading-spinner"></span> HQ render · ' +
                          _formatMmSs(elapsed) + ' (still working&hellip;)';
            } else {
              labelHtml = '<span class="filter-loading-spinner"></span> HQ render · ' +
                          _formatMmSs(elapsed) + ' (large jobs can take 3&ndash;5 min)';
            }
            el.innerHTML = labelHtml;
          } else {
            el.innerHTML = '<span class="filter-loading-spinner"></span> Processing&hellip;';
          }
        } else {
          el.classList.add("hidden");
          el.innerHTML = '<span class="filter-loading-spinner"></span> Processing&hellip;';
        }
      }
      // Tick: while HQ is in flight, refresh every second so the
      // elapsed counter advances. Stops itself when hqFetching ends.
      if (state.hqFetching && !_hqEtaTickHandle) {
        _hqEtaTickHandle = setInterval(function() {
          if (!state.hqFetching) {
            clearInterval(_hqEtaTickHandle);
            _hqEtaTickHandle = null;
            return;
          }
          updateRhefLoadingUI();
        }, 1000);
      } else if (!state.hqFetching && _hqEtaTickHandle) {
        clearInterval(_hqEtaTickHandle);
        _hqEtaTickHandle = null;
      }
      // Refresh timeline status so loading/ready badges track the fetch state.
      if (typeof updateFilterTimelineUI === "function") updateFilterTimelineUI();
    }

    // ── Backend Health Check ─────────────────────────────────────
    var healthRetries = 0;
    var MAX_HEALTH_RETRIES = 4;

    function setBannerState(bannerState, title, detail, showActions) {
      backendBanner.className = "backend-banner " + bannerState;
      var iconMap = {
        checking: '<div class="spinner"></div>',
        waking:   '<div class="spinner" style="border-top-color:var(--accent-sun);"></div>',
        online:   '<i class="fas fa-check-circle"></i>',
        offline:  '<i class="fas fa-exclamation-triangle"></i>'
      };
      var actionsHtml = "";
      if (showActions) {
        actionsHtml =
          '<div class="banner-actions">' +
            '<button class="banner-btn" id="bannerRetry"><i class="fas fa-redo"></i> Retry</button>' +
            '<a class="banner-btn" href="https://dashboard.render.com" target="_blank" rel="noopener"><i class="fas fa-external-link-alt"></i> Render Dashboard</a>' +
          '</div>';
      }
      backendBanner.innerHTML =
        '<span class="banner-icon">' + (iconMap[bannerState] || "") + '</span>' +
        '<div class="banner-text">' +
          '<strong>' + title + '</strong>' +
          '<small>' + detail + '</small>' +
        '</div>' + actionsHtml;

      if (showActions) {
        var retryBtn = backendBanner.querySelector("#bannerRetry");
        if (retryBtn) {
          retryBtn.addEventListener("click", function() {
            healthRetries = 0;
            checkBackendHealth();
          });
        }
      }
    }

    // Show CSP notice only when served from a different origin than API_BASE
    if (API_BASE !== window.location.origin) {
      cspNotice.classList.remove("hidden");
    }

    function checkBackendHealth() {
      setBannerState("checking", "Checking backend status...", "Connecting to " + API_BASE, false);

      // Phase 1: lightweight health endpoint (no heavy app init)
      var abortCtrl = new AbortController();
      var timeout = setTimeout(function() { abortCtrl.abort(); }, HEALTH_TIMEOUT_MS);

      fetch(API_BASE + "/api/health", { method: "GET", mode: "no-cors", signal: abortCtrl.signal })
        .then(function() {
          clearTimeout(timeout);
          // Server is alive — now Phase 2: check if CORS allows us
          return checkCORS();
        })
        .catch(function(err) {
          clearTimeout(timeout);
          healthRetries++;
          if (healthRetries <= MAX_HEALTH_RETRIES) {
            var isTimeout = err.name === "AbortError";
            setBannerState("waking",
              isTimeout
                ? "Backend is waking up... (attempt " + healthRetries + "/" + MAX_HEALTH_RETRIES + ")"
                : "Retrying connection... (attempt " + healthRetries + "/" + MAX_HEALTH_RETRIES + ")",
              "Render free-tier services sleep after inactivity. Cold start takes 30–60 seconds.",
              false
            );
            setTimeout(checkBackendHealth, WAKE_RETRY_DELAY);
          } else {
            onBackendOffline();
          }
        });
    }

    function checkCORS() {
      // Try a real CORS request (OPTIONS preflight + GET) to detect CORS misconfiguration
      var abortCtrl2 = new AbortController();
      var timeout2 = setTimeout(function() { abortCtrl2.abort(); }, 8000);

      return fetch(API_BASE + "/api/health", { method: "GET", signal: abortCtrl2.signal })
        .then(function(resp) {
          clearTimeout(timeout2);
          // If we get here, CORS is properly configured
          cspNotice.classList.add("hidden");
          onBackendOnline();
        })
        .catch(function(err) {
          clearTimeout(timeout2);
          // Server is alive but CORS failed — tell user what to do
          if (err.name === "TypeError" || err.message === "Failed to fetch") {
            onBackendCORSBlocked();
          } else {
            // Some other error — server might still work, try optimistically
            cspNotice.classList.add("hidden");
            onBackendOnline();
          }
        });
    }

    function fetchBuildTime() {
      if (!API_BASE) return;
      fetch(API_BASE + "/api/build-info", { method: "GET" })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (!d.built) return;
          var el = document.getElementById("buildTime");
          if (!el) return;
          var dt = new Date(d.built);
          var s = dt.toLocaleString("en-US", {
            timeZone: "America/Denver",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit",
            hour12: false,
            timeZoneName: "short"
          });
          el.textContent = "Built: " + s;
        })
        .catch(function() {});
    }

    // ── "Behind the image" credits modal ─────────────────────────
    // Reframed from a dry citation list to a "meet the institutes &
    // infrastructure working behind the scenes" tour, with every named
    // body linked to its canonical site (new tab). Surfaced two ways:
    // the footer "Data credits" link, and an auto-popup the first time
    // a user enters the editor after selecting a variant (buys time
    // while the HQ render finishes). `lead` prepends the wait-context
    // line for the popup; the footer view omits it.
    function _dataCreditsHtml(lead) {
      function L(url, text) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' + text + '</a>';
      }
      var NASA  = L("https://www.nasa.gov/", "NASA");
      var SDO   = L("https://sdo.gsfc.nasa.gov/", "Solar Dynamics Observatory (SDO)");
      var AIA   = L("https://aia.lmsal.com/", "Atmospheric Imaging Assembly (AIA)");
      var JSOC  = L("http://jsoc.stanford.edu/", "Joint Science Operations Center");
      var VSO   = L("https://virtualsolar.org/", "Virtual Solar Observatory");
      var HV    = L("https://www.helioviewer.org/", "Helioviewer Project");
      var LEMEN = L("https://ui.adsabs.harvard.edu/abs/2012SoPh..275...17L/abstract", "Lemen et al. 2012");
      var GILLY = L("https://ui.adsabs.harvard.edu/abs/2025SoPh..300..174G/abstract", "Gilly et al. 2025");
      return '<div style="text-align:left;font-size:0.85rem;line-height:1.55;">' +
          (lead ? '<p style="margin-bottom:14px;">' + lead + '</p>' : '') +
          '<p style="margin-bottom:6px;"><strong>The Sun, observed</strong></p>' +
          '<p style="margin-bottom:14px;color:var(--text-secondary);">Your image comes from ' + NASA + "'s " + SDO + ', which carries the ' + AIA + ' — the instrument photographing the Sun around the clock.</p>' +
          '<p style="margin-bottom:6px;"><strong>From space to your screen</strong></p>' +
          '<p style="margin-bottom:14px;color:var(--text-secondary);">Full-resolution frames (Raw / RHEF / HQ&nbsp;RHEF) are archived at the ' + JSOC + ' at Stanford and delivered through the ' + VSO + '. Instant previews are rendered by the ' + HV + '.</p>' +
          '<p style="margin-bottom:6px;"><strong>The science</strong></p>' +
          '<p style="margin-bottom:14px;color:var(--text-secondary);">Instrument: ' + LEMEN + ' (Sol. Phys. 275, 17). RHEF processing: ' + GILLY + ' (Sol. Phys. 300, 174).</p>' +
          '<p style="margin-bottom:0;font-size:0.8rem;color:var(--text-dim);">' + CITATIONS.SDO_ACK + ' Not affiliated; no endorsement implied.</p>' +
        '</div>';
    }
    // {html:true}: body is fully developer-authored markup.
    function showDataCredits(title, lead) {
      showInfo(title || "Behind the image", _dataCreditsHtml(lead), { html: true });
    }
    // Auto-surface ONCE PER SESSION the first time the user enters the
    // editor after picking a variant (see the confirm-modal Continue
    // handler) — by then they've chosen their product, and the HQ
    // render is finishing in the background, so it reads as "here's
    // what's working while your image gets ready" rather than an
    // interruption.
    var _dataCreditsShownThisSession = false;
    function maybeShowDataCredits() {
      if (_dataCreditsShownThisSession) return;
      _dataCreditsShownThisSession = true;
      showDataCredits(
        "Behind the scenes, while your image renders",
        "Your high-resolution solar image is being prepared. While you wait, meet the institutes and infrastructure making it possible:"
      );
    }
    (function() {
      var link = document.getElementById("dataCreditsLink");
      if (!link) return;
      link.addEventListener("click", function(e) {
        e.preventDefault();
        showDataCredits();
      });
    })();

    function onBackendOnline() {
      state.backendOnline = true;
      setBannerState("online", "Backend online", "Connected to " + API_BASE, false);
      fetchBuildTime();
      // Auto-hide after 4s
      setTimeout(function() {
        backendBanner.style.transition = "opacity 0.5s ease, max-height 0.5s ease";
        backendBanner.style.opacity = "0";
        backendBanner.style.maxHeight = "0";
        backendBanner.style.overflow = "hidden";
        backendBanner.style.padding = "0 18px";
        backendBanner.style.marginBottom = "0";
      }, 4000);
    }

    function onBackendCORSBlocked() {
      state.backendOnline = false;
      cspNotice.classList.remove("hidden");
      setBannerState("offline",
        "CORS blocked — backend is running but won't accept requests from this origin",
        "Your Render backend needs to allow this app's origin in its CORS config. " +
        "Update allowed_origins in main.py to include [\"*\"] or add the Poe iframe origin. " +
        "Then redeploy on Render.",
        true
      );
    }

    function onBackendOffline() {
      state.backendOnline = false;
      setBannerState("offline",
        "Backend is offline — connection refused",
        API_BASE + " is not accepting connections. This usually means: " +
        "(1) The deploy failed or crashed on startup (check Render Logs tab for errors), " +
        "(2) The service is suspended (free-tier limit), or " +
        "(3) It's still starting up (SunPy imports can take 60+ seconds on free tier). " +
        "Check Render Dashboard → Logs for the real error.",
        true
      );
    }

    function showFileProtocolBanner() {
      state.backendOnline = false;
      setBannerState("offline",
        "Viewing from a local file (file://)",
        "Browsers cannot connect to a backend from file://. To use the app: (1) Run a local server in the api folder — e.g. " +
        "python -m http.server 8000 — then open http://localhost:8000, or (2) Use your deployed URL once it's live. " +
        "To point this page at a deployed backend, add ?api=YOUR_BACKEND_URL to the address bar.",
        true
      );
      var retryBtn = backendBanner.querySelector("#bannerRetry");
      if (retryBtn) {
        retryBtn.textContent = "";
        retryBtn.innerHTML = '<i class="fas fa-info-circle"></i> How to run locally';
        retryBtn.onclick = function() {
          // {html:true}: dev-authored markup (br, code, anchor).
          showInfo("Run a local server",
            "In a terminal, go to the folder containing index.html (the api folder) and run:<br><br>" +
            "<code>python -m http.server 8000</code><br><br>" +
            "Then open <a href=\"http://localhost:8000\" target=\"_blank\" rel=\"noopener\">http://localhost:8000</a> in your browser.",
            { html: true }
          );
        };
      }
    }

    // Run health check on load (skip when viewing from file with no ?api=)
    if (isFileProtocol && !API_BASE) {
      showFileProtocolBanner();
    } else if (API_BASE) {
      checkBackendHealth();
    }

    // ── Mid-session "backend crashed" banner ────────────────────────
    // The page-load health check above catches a dead-on-arrival
    // backend, but won't surface anything when the backend crashes
    // DURING use (OOM mid-render is the common case on Render's
    // 2 GB tier). Without this, users see a clicked button do
    // nothing — no console message, no toast, no recourse.
    //
    // Wrap window.fetch so any /api/* response that's 5xx or a
    // network error re-surfaces the existing offline banner with a
    // concrete error string. Throttled so a single bad render
    // doesn't spam the banner ten times across the parallel
    // requests that follow.
    var _backendCrashLastShownAt = 0;
    var _BACKEND_CRASH_THROTTLE_MS = 15000;
    function _surfaceBackendCrash(detail) {
      var now = Date.now();
      if (now - _backendCrashLastShownAt < _BACKEND_CRASH_THROTTLE_MS) return;
      _backendCrashLastShownAt = now;
      // Un-hide the banner in case onBackendOnline collapsed it.
      backendBanner.style.opacity = "";
      backendBanner.style.maxHeight = "";
      backendBanner.style.overflow = "";
      backendBanner.style.padding = "";
      backendBanner.style.marginBottom = "";
      setBannerState("offline",
        "Backend appears to have crashed",
        (detail || "A recent request failed. ") +
        "The Render server may have run out of memory (a known issue on " +
        "the 2 GB tier during heavy renders) and restarted. Wait 30–60 " +
        "seconds for it to come back online, then retry.",
        true);
      state.backendOnline = false;
    }
    (function _wrapFetchForCrashDetection() {
      if (!window.fetch || typeof window.fetch !== "function") return;
      var _origFetch = window.fetch;
      window.fetch = function (input, init) {
        var urlStr = typeof input === "string" ? input : (input && input.url) || "";
        var isOurApi = API_BASE &&
                       (urlStr.indexOf(API_BASE) === 0 ||
                        urlStr.indexOf("/api/") === 0 ||
                        urlStr.indexOf("/asset/") === 0);
        return _origFetch.call(this, input, init).then(function (resp) {
          if (isOurApi && resp.status >= 500 && resp.status < 600) {
            _surfaceBackendCrash("Server returned " + resp.status + " on " +
              (urlStr.split("?")[0] || "an API call") + ".");
          }
          return resp;
        }).catch(function (err) {
          // Network errors (TypeError "Failed to fetch", AbortError on
          // long-running pipelines we cancelled, etc.). Only surface
          // for "Failed to fetch" — AbortError is user-initiated.
          if (isOurApi && err && err.name !== "AbortError" &&
              String(err).indexOf("Failed to fetch") !== -1) {
            _surfaceBackendCrash("Network error reaching " +
              (urlStr.split("?")[0] || "the backend") + ".");
          }
          throw err;
        });
      };
    })();

    // ── Fetch helpers (with timeout) ─────────────────────────────
    var currentAbort = null;

    function fetchWithTimeout(url, options, timeoutMs) {
      timeoutMs = timeoutMs || FETCH_TIMEOUT_MS;
      var abortCtrl = new AbortController();
      currentAbort = abortCtrl;
      var merged = Object.assign({}, options || {}, { signal: abortCtrl.signal });
      var timer = setTimeout(function() { abortCtrl.abort(); }, timeoutMs);

      return fetch(url, merged)
        .then(function(resp) {
          clearTimeout(timer);
          return resp;
        })
        .catch(function(err) {
          clearTimeout(timer);
          if (err.name === "AbortError") {
            throw new Error("Request timed out after " + Math.round(timeoutMs / 1000) + "s — the backend may be down or overloaded.");
          }
          // Network error — probably backend is offline
          if (err.message === "Failed to fetch" || err.message === "NetworkError when attempting to fetch resource.") {
            throw new Error(
              "Cannot reach backend (" + API_BASE + "). " +
              "The service may be sleeping, suspended, or failed to deploy. " +
              "Check the Render dashboard for status."
            );
          }
          throw err;
        });
    }

    function postJSON(url, data, timeoutMs) {
      return fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      }, timeoutMs).then(function(resp) {
        if (!resp.ok) {
          return resp.text().then(function(t) {
            var detail = t;
            try {
              var parsed = JSON.parse(t);
              detail = parsed.detail || parsed.message || t;
            } catch (_e) { /* use raw text */ }
            throw new Error("HTTP " + resp.status + ": " + detail);
          });
        }
        return resp.json();
      });
    }

    function pollStatus(url, onUpdate) {
      return new Promise(function(resolve, reject) {
        (function tick() {
          fetchWithTimeout(url, { method: "GET" }, 15000)
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (onUpdate) onUpdate(data);
              if (data.status === "completed" || data.status === "failed") {
                resolve(data);
              } else {
                setTimeout(tick, 1500);
              }
            })
            .catch(reject);
        })();
      });
    }

    // Legacy btnPreview/btnGenerate/btnHQ click handlers and the
    // startHqGeneration helper that only served them were removed — the
    // corresponding buttons were dropped from index.html when the workflow
    // collapsed into the filter radio + product-tile flow. startHqFilterGeneration
    // remains and covers the live HQ-RHEF path.

    /**
     * Start full-resolution image generation for the given format (jpg, raw, or rhef).
     * format defaults to state.editorFilter. On completion, sets hqFilterImage and hqFormat.
     *
     * Beta testers reported intermittent HQ failures (Helioviewer upstream
     * blips, cold-start timeouts). On the first attempt, transient errors
     * (network / 5xx / timeout) trigger a silent retry after 1.5 s backoff.
     * Hard errors (bad input, backend-logic failures) fall through to the
     * user-facing toast on the first attempt so real issues stay visible.
     */
    function startHqFilterGeneration(date, wavelength, format, _attempt) {
      format = format || state.editorFilter || "rhef";
      _attempt = _attempt || 1;

      // Dedup: only guard on the initial call; retries are allowed to continue
      // the existing fetch lifecycle.
      if (_attempt === 1 && state.hqFetching) return Promise.resolve();

      var cacheKey = date + "T" + _solarTimeValue() + "_" + wavelength + "_hq_" + format;
      var cached = hqCache[cacheKey];
      if (cached && cached.imageObj) {
        state.hqFilterImage = cached.imageObj;
        state.hqFormat = format;
        _hqApplyUpgrade(format);
        showToast("Full-resolution RHEF ready!", "success");
        return Promise.resolve(cached.imageObj);
      }

      state.hqFetching = true;
      if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
      if (_attempt === 1) setProgress(10);
      updateFilterStatusLine(
        _attempt > 1
          ? "Full-res RHEF retrying\u2026 (previous attempt failed)"
          : "Full-res RHEF generating in background (may take ~2 min)\u2026",
        "loading"
      );

      return postJSON(API_BASE + "/api/generate", {
        date: date,
        time: _solarTimeValue(),
        wavelength: wavelength,
        mission: "SDO",
        detector: "AIA",
        format: format
      }, 180000).then(function(res) {
        if (!res.task_id || !res.status_url) throw new Error("HQ task failed to start");
        var statusUrl = API_BASE + res.status_url;
        setProgress(30);
        return pollStatus(statusUrl, function(data) {
          _recordQueueDepth(data);
          if (data.status === "queued") {
            setProgress(35);
            // Inline status bar is suppressed; updateRhefLoadingUI()
            // surfaces "Queued \u00b7 N ahead" via _recordQueueDepth above.
          } else if (data.status === "started" || data.status === "processing") {
            setProgress(50);
            updateFilterStatusLine("Full-res RHEF rendering\u2026", "loading");
          }
        });
      }).then(function(result) {
        if (result.status === "completed" && result.image_url) {
          var hqUrl = result.image_url.startsWith("/") ? API_BASE + result.image_url : result.image_url;
          setProgress(85);
          updateFilterStatusLine("Loading full-res RHEF image\u2026", "loading");
          return loadImage(hqUrl).then(function(img) {
            state.hqFilterImage = img;
            state.hqFormat = format;
            state.hqFetching = false;
            // Mark HQ as ready for the print-quality gate + checkout
            // image path. Previously only the checkout poll set these,
            // so a user who let HQ finish in the background and then hit
            // "Generate real mockup" got a false "HQ still rendering"
            // warning (state.hqReady was stale-false even though the
            // finished image was sitting in hqCache). These reset to
            // false on date/wavelength change (see the preview reload).
            state.hqReady = true;
            state.hqImageUrl = hqUrl;
            if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
            hqCache[cacheKey] = { url: hqUrl, imageObj: img };
            setProgress(100);
            hideProgress();
            updateFilterStatusLine("Full-res RHEF ready!", "success");
            _hqApplyUpgrade(format);
            if (typeof maybeAutoAdvanceFilter === "function") maybeAutoAdvanceFilter();
            showToast("Full-resolution RHEF ready! \u2728", "success");
            return img;
          });
        }
        throw new Error(result.message || "HQ generation failed");
      }).catch(function(err) {
        var msg = (err && err.message) || String(err);
        var isTransient =
          /Failed to fetch|NetworkError|timeout|timed out|5\d\d|bad gateway|service unavailable/i.test(msg);
        if (_attempt < 2 && isTransient) {
          // Silent one-shot retry: keep state.hqFetching true so the UI
          // continues showing the generating state; schedule a retry after a
          // short backoff so we don't hammer the same flaky endpoint.
          return new Promise(function(resolve, reject) {
            setTimeout(function() {
              startHqFilterGeneration(date, wavelength, format, _attempt + 1)
                .then(resolve, reject);
            }, 1500);
          });
        }
        // Terminal failure — surface to the user.
        state.hqFetching = false;
        if (typeof updateRhefLoadingUI === "function") updateRhefLoadingUI();
        hideProgress();
        updateFilterStatusLine("HQ generation failed: " + msg, "error");
        showToast("HQ failed: " + msg, "error");
        return Promise.reject(err);
      });
    }

    /**
     * When HQ for a given format arrives (from cache or freshly generated), upgrade the canvas
     * to "hq_rhef" if the user is currently viewing the base RHEF or the HQ RHEF filter.
     * For any other active filter, switch to hq_rhef so the user can see the HQ.
     * The user can always switch back to other filters (JPG, raw, RHEF) - those previews
     * remain available in memory.
     */
    function _hqApplyUpgrade(format) {
      // Always upgrade to hq_rhef when HQ arrives - the HQ is the premium view
      state.editorFilter = "hq_rhef";
      renderCanvas();
      _syncFilterToggleUI("hq_rhef");
      updateMockupDisplay();
    }

    // ── Load image with CORS proxy fallback ──────────────────────
    function loadImage(url) {
      return new Promise(function(resolve, reject) {
        var img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = function() { resolve(img); };
        img.onerror = function() {
          // Retry without crossOrigin
          var img2 = new Image();
          img2.onload = function() { resolve(img2); };
          img2.onerror = function() { reject(new Error("Failed to load image")); };
          img2.src = url;
        };
        img.src = url;
      });
    }

    // ── Timestamp caption helpers ─────────────────────────────
    // Builds the user-facing caption: "21 April 2026 · 12:00 UTC · 171 Å".
    // Date is parsed from the picker (an ISO yyyy-mm-dd string), formatted
    // with the locale's full month name; time is fixed at 12:00 UTC because
    // every fetch path in the app is anchored there. Wavelength comes from
    // the active state.wavelength. Returns "" if any required piece is
    // missing rather than emitting half a caption.
    var _MONTH_NAMES = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    function _composeTimestampCaption() {
      var dateInputEl = document.getElementById("solarDate");
      var dateStr = dateInputEl ? dateInputEl.value : "";
      var wl = state.wavelength;
      if (!dateStr || !wl) return "";
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
      if (!m) return "";
      var year = parseInt(m[1], 10);
      var month = parseInt(m[2], 10);
      var day = parseInt(m[3], 10);
      var monthName = _MONTH_NAMES[month - 1] || ("Month " + month);
      // Day-first reads more like a print caption than ISO ordering ("21
      // April 2026" vs "April 21, 2026"). · = mid-dot separator.
      return day + " " + monthName + " " + year + " · 12:00 UTC · " + wl + " Å";
    }

    // ── Canvas rendering ─────────────────────────────────────────
    // Canvas size is always derived from the reference image (originalImage) so that toggling
    // JPG / Raw / RHEF keeps the same crop and overlay; other images are drawn scaled to cover.
    function renderCanvas() {
      if (!state.originalImage) return;
      // Re-entry guard. renderCanvas ends with refreshLivePreview(), which can
      // call drawProductMockup() → getCleanCanvasSnapshot() → renderCanvas()
      // recursively. That cascade was the reason slider drags bogged down to
      // ~1 fps: each frame was doing 3+ full renders plus a live-preview loop
      // on each of them. Bailing on recursion means the inner snapshot still
      // copies from the already-drawn solarCanvas — it just doesn't redraw.
      if (state._renderInProgress) return;
      state._renderInProgress = true;
      try {
        _renderCanvasInner();
      } finally {
        state._renderInProgress = false;
      }
    }
    function _renderCanvasInner() {
      var img;
      var fmt = state.editorFilter;
      // Each tier resolves to the IMAGE THAT TIER ACTUALLY REPRESENTS, never
      // upgrading silently. Earlier code auto-upgraded "rhef" to hqFilterImage
      // when HQ was loaded, which made RHEF and HQ RHEF render byte-identical
      // and hid the quality progression — beta tester reported "they look
      // the same even at max zoom." Now: each tier shows its own source, and
      // hq_rhef falls back to rhef only as a placeholder while HQ is still
      // generating (the timeline status shows it as Loading in that case).
      if (fmt === "jpg") img = state.jpgImage || state.originalImage;
      else if (fmt === "raw") img = state.rawBackendImage || state.jpgImage || state.originalImage;
      else if (fmt === "rhef") img = state.rhefImage || state.jpgImage || state.originalImage;
      else if (fmt === "hq_rhef") {
        if (state.hqFilterImage && state.hqFormat === "rhef") img = state.hqFilterImage;
        else img = state.rhefImage || state.jpgImage || state.originalImage;
      }
      else img = state.originalImage;
      var ctx = solarCanvas.getContext("2d");

      var ref = state.originalImage;
      var refW = ref.naturalWidth;
      var refH = ref.naturalHeight;
      var rotated = (state.rotation % 180 !== 0);
      var refCW = rotated ? refH : refW;
      var refCH = rotated ? refW : refH;

      // Fixed frame: canvas is the frame (product ratio when selected, else full ref). Image pans/zooms behind it.
      var cw = refCW;
      var ch = refCH;
      var product = state.selectedProduct ? PRODUCTS.find(function(p) { return p.id === state.selectedProduct; }) : null;
      var effectiveAR = getEffectiveAspectRatio(product);
      if (product && effectiveAR && effectiveAR.w && effectiveAR.h) {
        var R = effectiveAR.w / effectiveAR.h;
        if (R >= refCW / refCH) {
          cw = refCW;
          ch = Math.max(1, Math.floor(refCW / R));
        } else {
          ch = refCH;
          cw = Math.max(1, Math.floor(refCH * R));
        }
      }

      // ── Canvas-resolution bump when HQ is the active source ──────────
      // Without this, an HQ image (e.g. 4096×4096) gets downsampled back to
      // preview resolution because the canvas is sized to originalImage's
      // dimensions (~512 px). The HQ detail is therefore invisible at any
      // zoom level. Solution: when the active img is meaningfully bigger
      // than the originalImage reference, scale the canvas (and pan/ref
      // coords) up so the user sees the actual HQ pixels. Capped at 1536 px
      // longest side during interactive edits so slider perf stays usable —
      // export bypasses the cap via state._fullResRender.
      var iw = img.naturalWidth;
      var ih = img.naturalHeight;
      var canvasScale = 1;
      var imgIsHQ = (img && img !== state.originalImage && img !== state.jpgImage
                       && img.naturalWidth > refCW * 1.25);
      if (imgIsHQ) {
        var MAX_DIM = state._fullResRender
          ? Math.max(img.naturalWidth, img.naturalHeight)
          : 1536;
        canvasScale = Math.min(img.naturalWidth / refCW, MAX_DIM / Math.max(refCW, refCH));
        canvasScale = Math.max(1, canvasScale);
      }
      // Stash so pan-drag handler (which works in canvas-pixel coords) can
      // convert deltas back to ref-space when canvas != ref size.
      state._canvasScale = canvasScale;
      // Apply scale to all logical-space dims used downstream. Persisted
      // state.panX/panY remain in REF space; we just project them into the
      // current canvas-pixel space here.
      cw    = Math.round(cw    * canvasScale);
      ch    = Math.round(ch    * canvasScale);
      refCW = refCW * canvasScale;
      refCH = refCH * canvasScale;

      solarCanvas.width = cw;
      solarCanvas.height = ch;
      ctx.clearRect(0, 0, cw, ch);

      var zoom = (state.cropZoom || 100) / 100;
      var panX = (state.panX != null ? state.panX : (refCW / canvasScale) / 2) * canvasScale;
      var panY = (state.panY != null ? state.panY : (refCH / canvasScale) / 2) * canvasScale;

      // Image moves behind fixed frame: ref (panX, panY) at canvas center, scale zoom.
      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.scale(zoom, zoom);
      ctx.translate(-panX, -panY);
      ctx.translate(refCW / 2, refCH / 2);
      ctx.rotate((state.rotation * Math.PI) / 180);
      ctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
      ctx.translate(-refCW / 2, -refCH / 2);
      var scaleImg = Math.max(refCW / iw, refCH / ih);
      // Helioviewer-sourced JPG (fmt="jpg") covers 3 000 arcsec of sky at 384 px.
      // FITS-derived raw/rhef cover the AIA full disk: 4 096 px × 0.6 arcsec/px = 2 458 arcsec.
      // Scale up the JPG so the solar disk appears the same physical size as in raw/rhef.
      if (fmt === "jpg") {
        scaleImg *= 3000 / (4096 * 0.6); // ≈ 1.220
      }
      var drawW = iw * scaleImg;
      var drawH = ih * scaleImg;
      ctx.drawImage(img, 0, 0, iw, ih, (refCW - drawW) / 2, (refCH - drawH) / 2, drawW, drawH);
      ctx.restore();

      // Determine whether this is a round product — needed both by the pixel loop
      // (for vignette centering) and by the circular-clip code below. Originally
      // wall_clock was the only round product, but user-requested products with
      // `printShape === "circle"` (e.g. the pet-leash button print) need the
      // same treatment, so we now check the resolved product's shape flag too.
      var isCircularProduct = (state.selectedProduct === "wall_clock") ||
        (product && product.printShape === "circle");

      // Apply brightness/contrast/saturation via pixel manipulation.
      //
      // The pixel loop is O(width × height). We previously ran it on a 1/4-
      // linear / 1/16-pixel offscreen work canvas during interactive edits,
      // but the upscale blur was visibly coarse (beta feedback: "I'd leave
      // as a customer"). Disabled by default now — the recursion fix on
      // renderCanvas was doing most of the heavy lifting anyway. Flip
      // ENABLE_INTERACTIVE_DOWNSAMPLE back to true if a large canvas reveals
      // latency that the cheap paths can't cover.
      var ENABLE_INTERACTIVE_DOWNSAMPLE = false;
      var needsPixelWork = state.brightness !== 0 || state.contrast !== 0 ||
                           state.saturation !== 100 || state.inverted || state.vignette > 0 ||
                           (state.cropEdgeFeatherX || 0) > 0 || (state.cropEdgeFeatherY || 0) > 0 ||
                           (state.hue || 0) !== 0;
      if (needsPixelWork) {
        var useDownsampled = ENABLE_INTERACTIVE_DOWNSAMPLE && !state._fullResRender;
        var workCw = cw, workCh = ch;
        var workCtx = ctx;
        var workCanvas = null;
        if (useDownsampled) {
          workCw = Math.max(1, Math.round(cw / 4));
          workCh = Math.max(1, Math.round(ch / 4));
          workCanvas = document.createElement("canvas");
          workCanvas.width = workCw;
          workCanvas.height = workCh;
          workCtx = workCanvas.getContext("2d");
          // Downsample the current (pre-effect) main canvas into the work
          // canvas. The browser's built-in bilinear scale is GPU-accelerated
          // and essentially free compared to the per-pixel JS below.
          workCtx.drawImage(solarCanvas, 0, 0, workCw, workCh);
        }
        var imageData = workCtx.getImageData(0, 0, workCw, workCh);
        var d = imageData.data;
        var br = state.brightness;
        var co = state.contrast / 100;
        var factor = (259 * (co * 255 + 255)) / (255 * (259 - co * 255));
        var sat = state.saturation / 100;
        // Hue rotation — rotate the chroma vector around the luma axis.
        // Pre-compute the YIQ rotation matrix so the per-pixel inner
        // loop only does six multiply-adds. Skip the work entirely when
        // hue is 0 (the common case).
        var hueDeg = state.hue || 0;
        var applyHue = (hueDeg % 360) !== 0;
        var hueCos = applyHue ? Math.cos(hueDeg * Math.PI / 180) : 1;
        var hueSin = applyHue ? Math.sin(hueDeg * Math.PI / 180) : 0;
        // Standard YIQ→RGB hue-rotation matrix, derived offline.
        var hrr = 0.213 + 0.787 * hueCos - 0.213 * hueSin;
        var hrg = 0.715 - 0.715 * hueCos - 0.715 * hueSin;
        var hrb = 0.072 - 0.072 * hueCos + 0.928 * hueSin;
        var hgr = 0.213 - 0.213 * hueCos + 0.143 * hueSin;
        var hgg = 0.715 + 0.285 * hueCos + 0.140 * hueSin;
        var hgb = 0.072 - 0.072 * hueCos - 0.283 * hueSin;
        var hbr = 0.213 - 0.213 * hueCos - 0.787 * hueSin;
        var hbg = 0.715 - 0.715 * hueCos + 0.715 * hueSin;
        var hbb = 0.072 + 0.928 * hueCos + 0.072 * hueSin;

        // Vignette params — always pinned to canvas centre so the radius stays
        // consistent regardless of pan position. Uses workCw/workCh so the
        // effect scales 1:1 with the downsampled work canvas.
        var applyVignette = state.vignette > 0;
        var cx = workCw / 2;
        var cy = workCh / 2;
        var maxR;
        if (isCircularProduct) {
          // inscribed circle radius — vignette slider maps within the round print area
          maxR = Math.min(workCw, workCh) / 2;
        } else {
          // distance from canvas centre to the farthest corner
          maxR = Math.sqrt(cx * cx + cy * cy);
        }
        // vignetteRadius: at 0 => no effect, at 100 => very tight circle
        // We map slider 0–100 to radius factor 1.0–0.1
        var radiusFactor = 1.0 - (state.vignette / 100) * 0.9;
        var vigR = maxR * radiusFactor;
        // vignetteWidth: 0 = hard crop (no feather), 100 = full smooth feather
        var vigWidthFactor = state.vignetteWidth / 100;

        // Crop-edge feather: how far inward from each edge the fade reaches.
        // 100% on the slider extends the fade ~25% of the canvas dimension
        // inward from each edge, leaving the central ~50% untouched. The
        // smoothstep inside the loop softens that into a clean ramp.
        var applyEdgeFeatherX = (state.cropEdgeFeatherX || 0) > 0;
        var applyEdgeFeatherY = (state.cropEdgeFeatherY || 0) > 0;
        var edgeFeatherWidthX = ((state.cropEdgeFeatherX || 0) / 100) * (workCw * 0.25);
        var edgeFeatherWidthY = ((state.cropEdgeFeatherY || 0) / 100) * (workCh * 0.25);

        // Mode (match canvas): always compute from displayed pixels (excluding black/white) for Match button preview and for vignette when selected
        if (needsPixelWork) {
          var step = 8;
          var buckets = {};
          var maxCount = 0;
          var maxKey = "16,16,16";
          var blackThresh = 25;
          var whiteThresh = 230;
          for (var si = 0; si < d.length; si += 4 * step) {
            var ar = d[si], ag = d[si + 1], ab = d[si + 2], aa = d[si + 3];
            if (aa < 128) continue;
            if (state.inverted) { ar = 255 - ar; ag = 255 - ag; ab = 255 - ab; }
            ar += br; ag += br; ab += br;
            ar = factor * (ar - 128) + 128;
            ag = factor * (ag - 128) + 128;
            ab = factor * (ab - 128) + 128;
            var gray = 0.2989 * ar + 0.587 * ag + 0.114 * ab;
            ar = gray + sat * (ar - gray);
            ag = gray + sat * (ag - gray);
            ab = gray + sat * (ab - gray);
            var rr = Math.max(0, Math.min(255, ar));
            var gg = Math.max(0, Math.min(255, ag));
            var bb = Math.max(0, Math.min(255, ab));
            if (rr <= blackThresh && gg <= blackThresh && bb <= blackThresh) continue;
            if (rr >= whiteThresh && gg >= whiteThresh && bb >= whiteThresh) continue;
            var rq = (rr >> 3);
            var gq = (gg >> 3);
            var bq = (bb >> 3);
            var key = rq + "," + gq + "," + bq;
            buckets[key] = (buckets[key] || 0) + 1;
            if (buckets[key] > maxCount) { maxCount = buckets[key]; maxKey = key; }
          }
          var parts = maxKey.split(",");
          state._vignetteModeR = (parseInt(parts[0], 10) << 3) + 4;
          state._vignetteModeG = (parseInt(parts[1], 10) << 3) + 4;
          state._vignetteModeB = (parseInt(parts[2], 10) << 3) + 4;
          if (typeof updateMatchButtonColor === "function") updateMatchButtonColor();
        }

        for (var i = 0; i < d.length; i += 4) {
          var r = d[i], g = d[i + 1], b = d[i + 2];

          // Invert
          if (state.inverted) { r = 255 - r; g = 255 - g; b = 255 - b; }

          // Brightness
          r += br; g += br; b += br;

          // Contrast
          r = factor * (r - 128) + 128;
          g = factor * (g - 128) + 128;
          b = factor * (b - 128) + 128;

          // Saturation
          var gray = 0.2989 * r + 0.587 * g + 0.114 * b;
          r = gray + sat * (r - gray);
          g = gray + sat * (g - gray);
          b = gray + sat * (b - gray);

          // Hue rotation — applies AFTER saturation so a desaturated
          // pixel rotates around its (now-grey) luma axis and stays
          // grey, which matches the intuitive "spin the colour wheel"
          // mental model. Skips entirely when hue is zero.
          if (applyHue) {
            var hr = hrr * r + hrg * g + hrb * b;
            var hg = hgr * r + hgg * g + hgb * b;
            var hb = hbr * r + hbg * g + hbb * b;
            r = hr; g = hg; b = hb;
          }

          // Vignette — fade to transparent / black / white / color / mode outside radius.
          // Coords are in work-canvas space (matches cx/cy/maxR above).
          if (applyVignette) {
            var px = (i / 4) % workCw;
            var py = Math.floor((i / 4) / workCw);
            var dx = px - cx;
            var dy = py - cy;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > vigR) {
              var maxFade = maxR - vigR;
              var fadeLen = maxFade * vigWidthFactor;
              var t = fadeLen > 0.5 ? Math.min((dist - vigR) / fadeLen, 1.0) : 1.0;
              t = t * t * (3 - 2 * t);
              var fade = state.vignetteFade || "transparent";
              if (fade === "transparent") {
                d[i + 3] = d[i + 3] * (1 - t);
              } else if (fade === "black") {
                r = r * (1 - t);
                g = g * (1 - t);
                b = b * (1 - t);
              } else if (fade === "white") {
                r = r * (1 - t) + 255 * t;
                g = g * (1 - t) + 255 * t;
                b = b * (1 - t) + 255 * t;
              } else if (fade === "custom") {
                var hex = (state.vignetteFadeColor || "#000000").replace(/^#/, "");
                var fr = parseInt(hex.substr(0, 2), 16);
                var fg = parseInt(hex.substr(2, 2), 16);
                var fb = parseInt(hex.substr(4, 2), 16);
                r = r * (1 - t) + fr * t;
                g = g * (1 - t) + fg * t;
                b = b * (1 - t) + fb * t;
              } else if (fade === "mode") {
                var modeR = state._vignetteModeR !== undefined ? state._vignetteModeR : 0;
                var modeG = state._vignetteModeG !== undefined ? state._vignetteModeG : 0;
                var modeB = state._vignetteModeB !== undefined ? state._vignetteModeB : 0;
                r = r * (1 - t) + modeR * t;
                g = g * (1 - t) + modeG * t;
                b = b * (1 - t) + modeB * t;
              }
            }
          }

          // Crop-edge feather (X/Y) — fades the canvas toward the configured
          // vignetteFade colour as pixels approach the left/right or top/
          // bottom edges. The CSS-only mask approach (still wired up for
          // editor responsiveness) only affected display, so mockups and
          // exports rendered without the fade. Baking it into the pixel
          // data here means the snapshot used for product cards / preview
          // mockups carries the same effect end-to-end.
          if (applyEdgeFeatherX || applyEdgeFeatherY) {
            var epx = (i / 4) % workCw;
            var epy = Math.floor((i / 4) / workCw);
            var eTx = 0, eTy = 0;
            if (applyEdgeFeatherX) {
              var distEdgeX = Math.min(epx, (workCw - 1) - epx);
              if (distEdgeX < edgeFeatherWidthX) {
                var rawX = 1 - (distEdgeX / edgeFeatherWidthX);
                eTx = rawX * rawX * (3 - 2 * rawX);
              }
            }
            if (applyEdgeFeatherY) {
              var distEdgeY = Math.min(epy, (workCh - 1) - epy);
              if (distEdgeY < edgeFeatherWidthY) {
                var rawY = 1 - (distEdgeY / edgeFeatherWidthY);
                eTy = rawY * rawY * (3 - 2 * rawY);
              }
            }
            // Closer-to-any-edge wins so the fade reads as directional
            // when only one axis is enabled (proof of concept for the
            // user request: dialing X up should darken the left/right
            // edges to black without touching top/bottom).
            var eT = eTx > eTy ? eTx : eTy;
            if (eT > 0) {
              var eFade = state.vignetteFade || "transparent";
              if (eFade === "transparent") {
                d[i + 3] = d[i + 3] * (1 - eT);
              } else if (eFade === "black") {
                r = r * (1 - eT);
                g = g * (1 - eT);
                b = b * (1 - eT);
              } else if (eFade === "white") {
                r = r * (1 - eT) + 255 * eT;
                g = g * (1 - eT) + 255 * eT;
                b = b * (1 - eT) + 255 * eT;
              } else if (eFade === "custom") {
                var ehex = (state.vignetteFadeColor || "#000000").replace(/^#/, "");
                var efr = parseInt(ehex.substr(0, 2), 16);
                var efg = parseInt(ehex.substr(2, 2), 16);
                var efb = parseInt(ehex.substr(4, 2), 16);
                r = r * (1 - eT) + efr * eT;
                g = g * (1 - eT) + efg * eT;
                b = b * (1 - eT) + efb * eT;
              } else if (eFade === "mode") {
                var emR = state._vignetteModeR !== undefined ? state._vignetteModeR : 0;
                var emG = state._vignetteModeG !== undefined ? state._vignetteModeG : 0;
                var emB = state._vignetteModeB !== undefined ? state._vignetteModeB : 0;
                r = r * (1 - eT) + emR * eT;
                g = g * (1 - eT) + emG * eT;
                b = b * (1 - eT) + emB * eT;
              }
            }
          }

          d[i] = Math.max(0, Math.min(255, r));
          d[i + 1] = Math.max(0, Math.min(255, g));
          d[i + 2] = Math.max(0, Math.min(255, b));
        }

        workCtx.putImageData(imageData, 0, 0);
        if (useDownsampled) {
          // Blit the processed work canvas back onto the main canvas at full
          // resolution. drawImage's GPU scaling is ~1000× faster than the JS
          // pixel loop and the slight interpolation blur is invisible to the
          // user at slider-drag speeds. Export bypasses this branch entirely.
          ctx.drawImage(workCanvas, 0, 0, cw, ch);
        }
      }

      // ── Timestamp caption (Tools → Timestamp) ─────────────────
      // A small art-style caption stamped on the print area:
      // "21 April 2026 · 12:00 UTC · 171 Å". Sans-serif, lightly
      // shadowed for legibility on bright corona. Drawn after pixel
      // effects (vignette/feather) so it stays crisp.
      if (state.timestampStamp) {
        var tsText = _composeTimestampCaption();
        if (tsText) {
          ctx.save();
          // Font sized to the canvas (so the caption is the same fraction
          // of the image whether the canvas is 512px preview or 1536px
          // HQ).
          var tsRefH = Math.min(cw, ch);
          var tsSize = Math.max(11, Math.round(tsRefH * 0.028));
          var tsInset = Math.max(8, Math.round(tsRefH * 0.025));
          ctx.font = "500 " + tsSize + "px 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";
          // Position resolves to one of six anchors (top|bottom × left|center|right).
          var tsPos = state.timestampPos || "bottom-right";
          var tsParts = tsPos.split("-");
          var tsV = tsParts[0] === "top" ? "top" : "bottom";
          var tsH = (tsParts[1] === "left" || tsParts[1] === "center") ? tsParts[1] : "right";
          var tsX, tsY;
          if (tsH === "left")        { ctx.textAlign = "left";   tsX = tsInset; }
          else if (tsH === "center") { ctx.textAlign = "center"; tsX = cw / 2; }
          else                       { ctx.textAlign = "right";  tsX = cw - tsInset; }
          // Vertical offset is a 0..100 slider mapped to up-to-30% of the
          // shorter canvas dimension, applied INWARD from the chosen
          // vertical anchor. Lets users nudge the caption away from a
          // corona / mockup bezel that clips it.
          var tsOffsetPx = ((state.timestampVOffset || 0) / 100) * (tsRefH * 0.30);
          if (tsV === "top")         { ctx.textBaseline = "top";        tsY = tsInset + tsOffsetPx; }
          else                       { ctx.textBaseline = "alphabetic"; tsY = ch - tsInset - tsOffsetPx; }
          // Soft shadow so the caption reads on either a bright disk or
          // a dark vignette without needing a heavy stroke.
          ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
          ctx.shadowBlur = Math.max(2, Math.round(tsSize * 0.2));
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 1;
          ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
          ctx.fillText(tsText, tsX, tsY);
          ctx.restore();
        }
      }

      // ── Text overlay (live preview, not burned in) ────────────
      if (state.textOverlay && state.textOverlay.text) {
        var tov = state.textOverlay;
        // Resolve normalised position/size into pixel coords for THIS
        // canvas. The text used to store absolute pixel x/y/size which
        // drifted when the canvas resized (HQ swap, mockup snapshot,
        // export) — text placed centred on a 512px canvas ended up in
        // the upper-left of a 1536px snapshot. Normalised storage means
        // "centre" stays centre regardless of resolution.
        _resolveTextPx(tov, cw, ch);
        ctx.save();
        ctx.font = "bold " + tov._pixelSize + "px '" + tov.font + "', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Shadow effect
        if (tov.shadow && tov.shadow.enabled) {
          ctx.shadowColor = tov.shadow.color;
          ctx.shadowBlur = tov.shadow.blur;
          ctx.shadowOffsetX = tov.shadow.offsetX;
          ctx.shadowOffsetY = tov.shadow.offsetY;
        }

        if (tov.arc && tov.arc.enabled) {
          // ── Arc/Curved text ──
          drawArcText(ctx, tov);
        } else {
          // ── Straight text ──
          if (tov.strokeWidth > 0) {
            ctx.strokeStyle = tov.strokeColor;
            ctx.lineWidth = tov.strokeWidth * 2;
            ctx.lineJoin = "round";
            ctx.strokeText(tov.text, tov._pixelX, tov._pixelY);
          }
          if (!tov.outlined) {
            ctx.fillStyle = tov.color;
            ctx.fillText(tov.text, tov._pixelX, tov._pixelY);
          }
        }
        ctx.restore();
      }

      // ── Clock numbers (wall_clock only; 12 at top, 1–11 clockwise) ──
      if (state.clockNumbers && state.selectedProduct === "wall_clock") {
        var cn = state.clockNumbers;
        var cw = solarCanvas.width;
        var ch = solarCanvas.height;
        var cx = cw / 2;
        var cy = ch / 2;
        var half = Math.min(cw, ch) / 2;
        var r = (cn.radiusPct != null ? cn.radiusPct : 80) / 100 * half;
        // Font size + stroke width are scaled by half / CLOCK_REF_HALF so the
        // numerals are always the same fraction of the clock face regardless
        // of whether the canvas is 512 (preview) or 1536 (HQ active) or 65
        // (mockup). Without this, after the HQ canvas-resolution bump the
        // user's "size = 50" became invisible in the editor and the mockup
        // path used a different multiplier — the two panes drifted out of
        // sync. CLOCK_REF_HALF=256 matches the original 512-px canvas so
        // existing slider values look the same as before.
        var CLOCK_REF_HALF = 256;
        var sizeUnit = cn.size != null ? cn.size : 50;
        var sizePx = sizeUnit * (half / CLOCK_REF_HALF);
        var strokePx = (cn.strokeWidth || 0) * 2 * (half / CLOCK_REF_HALF);
        ctx.save();
        ctx.font = "bold " + sizePx + "px '" + (cn.font || "Inter") + "', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (var h = 1; h <= 12; h++) {
          // Standard clock layout: 12 at top, increasing clockwise.
          // angle measured from 12-o'clock, clockwise → use sin for x, -cos for y.
          var angle = h * (Math.PI * 2 / 12);
          var x = cx + r * Math.sin(angle);
          var y = cy - r * Math.cos(angle);
          var numLabel = (cn.style === "roman") ? ROMAN_NUMERALS[h] : String(h);
          if (strokePx > 0) {
            ctx.strokeStyle = cn.strokeColor || "#000";
            ctx.lineWidth = strokePx;
            ctx.lineJoin = "round";
            ctx.strokeText(numLabel, x, y);
          }
          ctx.fillStyle = cn.color || "#fff";
          ctx.fillText(numLabel, x, y);
        }
        ctx.restore();
      }

      if (typeof applyCropEdgeMask === "function") applyCropEdgeMask();

      // Circular clip for round products (wall_clock)
      if (isCircularProduct) {
        var circR = Math.min(cw, ch) / 2;
        var tmpCirc = document.createElement("canvas");
        tmpCirc.width = cw;
        tmpCirc.height = ch;
        var tmpCtx = tmpCirc.getContext("2d");
        tmpCtx.beginPath();
        tmpCtx.arc(cw / 2, ch / 2, circR, 0, Math.PI * 2);
        tmpCtx.clip();
        tmpCtx.drawImage(solarCanvas, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(tmpCirc, 0, 0);
      }

      // ── Background-colour fill for transparent areas ─────────────────────────────────
      // Fills any pixel whose alpha is < 10 with the chosen background colour.
      // This covers:
      //   • pan-off areas on square/rectangular crops (image doesn't reach the edge)
      //   • corner pixels outside the circular clip (wall_clock)
      // Must run AFTER the pixel loop (so mode colour is known) and AFTER the circular clip.
      var _bgFadePost = state.vignetteFade || "black";
      if (_bgFadePost !== "transparent") {
        var _bgR = 0, _bgG = 0, _bgB = 0;
        if (_bgFadePost === "white") { _bgR = 255; _bgG = 255; _bgB = 255; }
        else if (_bgFadePost === "custom") {
          var _bgHex = (state.vignetteFadeColor || "#000000").replace(/^#/, "");
          _bgR = parseInt(_bgHex.substr(0, 2), 16);
          _bgG = parseInt(_bgHex.substr(2, 2), 16);
          _bgB = parseInt(_bgHex.substr(4, 2), 16);
        } else if (_bgFadePost === "mode") {
          _bgR = state._vignetteModeR || 0;
          _bgG = state._vignetteModeG || 0;
          _bgB = state._vignetteModeB || 0;
        }
        // "black" stays 0,0,0 — already initialised above
        var bgPostData = ctx.getImageData(0, 0, cw, ch);
        var bgpd = bgPostData.data;
        var bgChanged = false;
        for (var bpi = 0; bpi < bgpd.length; bpi += 4) {
          if (bgpd[bpi + 3] < 10) {
            bgpd[bpi]     = _bgR;
            bgpd[bpi + 1] = _bgG;
            bgpd[bpi + 2] = _bgB;
            bgpd[bpi + 3] = 255;
            bgChanged = true;
          }
        }
        if (bgChanged) ctx.putImageData(bgPostData, 0, 0);
      }

      // Fixed frame border & guide lines — skipped when burning so they aren't baked in
      if (!state._burningCanvas) {
        // ── Orange frame border ──────────────────────────────────
        if (state.showOverlay !== false) {
          ctx.save();
          ctx.strokeStyle = "rgba(255, 152, 0, 0.95)";
          ctx.lineWidth = Math.max(4, Math.min(12, solarCanvas.width / 128));
          ctx.setLineDash([]);
          if (isCircularProduct) {
            var borderR = Math.min(cw, ch) / 2 - ctx.lineWidth / 2;
            ctx.beginPath();
            ctx.arc(cw / 2, ch / 2, borderR, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.strokeRect(0, 0, solarCanvas.width, solarCanvas.height);
          }
          ctx.restore();
        }

        // ── Guide lines (spine / centre cross) ───────────────────
        if (state.showGuides) {
          ctx.save();
          ctx.strokeStyle = "rgba(0, 210, 255, 0.80)";
          ctx.lineWidth = Math.max(1, Math.round(cw / 400));
          ctx.setLineDash([Math.round(cw / 40), Math.round(cw / 80)]);
          // Vertical centre line (spine for journals; centre for all)
          ctx.beginPath();
          ctx.moveTo(cw / 2, 0);
          ctx.lineTo(cw / 2, ch);
          ctx.stroke();
          // Horizontal centre line
          ctx.beginPath();
          ctx.moveTo(0, ch / 2);
          ctx.lineTo(cw, ch / 2);
          ctx.stroke();
          // Thirds (light, dashed)
          ctx.strokeStyle = "rgba(0, 210, 255, 0.35)";
          [cw / 3, (2 * cw) / 3].forEach(function(x) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch); ctx.stroke();
          });
          [ch / 3, (2 * ch) / 3].forEach(function(y) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
          });
          ctx.restore();
        }
      }

      // Live-update the selected product preview — redraws persistent canvas, no DOM mutations
      refreshLivePreview();
    }

    // ── Edit tools ───────────────────────────────────────────────
    document.querySelector(".edit-toolbar").addEventListener("click", function(e) {
      var btn = e.target.closest(".edit-btn");
      if (!btn) return;
      var tool = btn.dataset.tool;

      if (tool === "rotate") {
        state.rotation = (state.rotation + 90) % 360;
        renderCanvas();
      } else if (tool === "flipH") {
        state.flipH = !state.flipH;
        renderCanvas();
      } else if (tool === "flipV") {
        state.flipV = !state.flipV;
        renderCanvas();
      } else if (tool === "flipAspect") {
        var faProductId = state.selectedProduct;
        if (faProductId) {
          state.aspectFlippedByProduct[faProductId] = !state.aspectFlippedByProduct[faProductId];
          var faProduct = PRODUCTS.find(function(p) { return p.id === faProductId; });
          var faAR = getEffectiveAspectRatio(faProduct);
          if (faAR && faAR.w && faAR.h) {
            state.cropRatio = faAR.w + ":" + faAR.h;
            syncCropRatioUI();
          }
          renderCanvas();
        }
      } else if (tool === "invert") {
        state.inverted = !state.inverted;
        btn.classList.toggle("active", state.inverted);
        renderCanvas();
      } else if (tool === "reset") {
        state.rotation = 0;
        state.flipH = false;
        state.flipV = false;
        state.inverted = false;
        state.brightness = 0;
        state.contrast = 0;
        state.saturation = 100;
        state.hue = 0;
        // Vignette OFF on reset (was 24 = moderate dark vignette).
        // Many users were thrown by a "fresh" image showing edge
        // darkening; the cleaner default is no vignette and let them
        // dial it in if they want one.
        state.vignette = 0;
        state.vignetteWidth = 0;
        state.vignetteFade = "black";
        state.vignetteFadeColor = "#000000";
        state.cropEdgeFeatherX = 0;
        state.cropEdgeFeatherY = 0;
        state.textOverlay = null;
        state.textMode = false;
        if (state.selectedProduct) state.aspectFlippedByProduct[state.selectedProduct] = false;
        state.clockNumbers = null;
        if (typeof syncVignetteFadeUI === "function") syncVignetteFadeUI();
        $("#brightnessSlider").value = 0;
        $("#contrastSlider").value = 0;
        $("#saturationSlider").value = 100;
        if ($("#hueSlider")) { $("#hueSlider").value = 0; $("#hueVal").textContent = "0°"; }
        $("#vignetteSlider").value = 100;  // slider is inverted: 100 = no vignette
        $("#vigWidthSlider").value = 0;
        if ($("#cropEdgeXSlider")) { $("#cropEdgeXSlider").value = 0; $("#cropEdgeXVal").textContent = "0"; }
        if ($("#cropEdgeYSlider")) { $("#cropEdgeYSlider").value = 0; $("#cropEdgeYVal").textContent = "0"; }
        $("#brightnessVal").textContent = "0";
        $("#contrastVal").textContent = "0";
        $("#saturationVal").textContent = "100";
        $("#vignetteVal").textContent = "0";
        $("#vigWidthVal").textContent = "0";
        if (typeof applyCropEdgeMask === "function") applyCropEdgeMask();
        if ($("#cropSlider")) { $("#cropSlider").value = 100; $("#cropVal").textContent = "100%"; }
        state.cropZoom = 100;
        var ref = state.originalImage;
        if (ref) {
          var rw = state.rotation % 180 !== 0 ? ref.naturalHeight : ref.naturalWidth;
          var rh = state.rotation % 180 !== 0 ? ref.naturalWidth : ref.naturalHeight;
          state.panX = rw / 2;
          state.panY = rh / 2;
        } else {
          state.panX = 0;
          state.panY = 0;
        }
        applyCanvasView();
        document.querySelector('[data-tool="invert"]').classList.remove("active");
        document.querySelector('[data-tool="pan"]').classList.remove("active");
        document.querySelector('[data-tool="text"]').classList.remove("active");
        var clockBtn = document.querySelector('[data-tool="clockNumbers"]');
        if (clockBtn) clockBtn.classList.remove("active");
        $("#textToolPanel").classList.add("hidden");
        var clockPanel = document.getElementById("clockNumbersPanel");
        if (clockPanel) clockPanel.classList.add("hidden");
        exitCropMode();
        renderCanvas();
      } else if (tool === "pan") {
        var cropBtn = document.querySelector('[data-tool="crop"]');
        if (cropBtn) cropBtn.classList.remove("active");
        if (adjustmentsPanelEl) { adjustmentsPanelEl.classList.add("hidden"); }
        if (adjustmentsBtnEl) adjustmentsBtnEl.classList.remove("active");
        exitCropMode();
        btn.classList.add("active");
        solarCanvas.style.cursor = "grab";
      } else if (tool === "text") {
        if (adjustmentsPanelEl) { adjustmentsPanelEl.classList.add("hidden"); }
        if (adjustmentsBtnEl) adjustmentsBtnEl.classList.remove("active");
        enterTextMode();
      } else if (tool === "clockNumbers") {
        if (adjustmentsPanelEl) { adjustmentsPanelEl.classList.add("hidden"); }
        if (adjustmentsBtnEl) adjustmentsBtnEl.classList.remove("active");
        var cnPanel = document.getElementById("clockNumbersPanel");
        if (cnPanel) {
          var opening = cnPanel.classList.contains("hidden");
          cnPanel.classList.toggle("hidden");
          btn.classList.toggle("active", opening);
          if (opening) {
            applyClockNumbersFromPanel(); // live preview as soon as panel opens
          } else {
            state.clockNumbers = null;   // hide numbers when panel closes
            renderCanvas();
          }
        }
      }
    });

    // ── Tab toggle (Geometry / Adjust / Clock / Tools) ─────────────
    // Collapsable: clicking the active tab again hides every panel and
    // reveals the friendly hint, so first-time users see a calm editor
    // rather than a wall of controls. Clicking a different tab swaps.
    var adjustmentsBtnEl = null;   // no longer a standalone button
    var adjustmentsPanelEl = null;
    (function() {
      var tabs = document.querySelectorAll(".edit-tab");
      var hint = document.getElementById("editTabHint");
      function _collapseAll() {
        tabs.forEach(function(t) {
          t.classList.remove("active");
          t.setAttribute("aria-selected", "false");
          t.setAttribute("tabindex", "-1");
        });
        document.querySelectorAll(".edit-tab-panel").forEach(function(p) { p.classList.add("hidden"); });
        if (hint) hint.classList.remove("hidden");
        // After collapse, the FIRST visible tab is the roving-tabindex
        // anchor so keyboard users can re-enter the tablist with Tab.
        var firstVisible = Array.prototype.find.call(tabs, function(t) { return !t.classList.contains("hidden"); });
        if (firstVisible) firstVisible.setAttribute("tabindex", "0");
      }
      function _activate(tab) {
        tabs.forEach(function(t) {
          t.classList.remove("active");
          t.setAttribute("aria-selected", "false");
          t.setAttribute("tabindex", "-1");
        });
        document.querySelectorAll(".edit-tab-panel").forEach(function(p) { p.classList.add("hidden"); });
        tab.classList.add("active");
        tab.setAttribute("aria-selected", "true");
        tab.setAttribute("tabindex", "0");
        if (hint) hint.classList.add("hidden");
        var panel = document.getElementById("tabPanel_" + tab.dataset.tab);
        if (panel) panel.classList.remove("hidden");
        // Activating the Clock tab on a wall_clock product seeds
        // state.clockNumbers from the panel's defaults so the 12 numerals
        // appear in both the editor canvas AND the mock mockups
        // immediately — without this the user had to wiggle a slider
        // before any numerals showed up at all.
        if (tab.dataset.tab === "clock"
            && state.selectedProduct === "wall_clock"
            && !state.clockNumbers
            && typeof applyClockNumbersFromPanel === "function") {
          applyClockNumbersFromPanel();
          if (typeof refreshLivePreview === "function") refreshLivePreview();
          if (typeof scheduleMockupRefresh === "function") scheduleMockupRefresh();
        }
      }
      // Initial roving tabindex: first visible tab is the entry point.
      var firstVisible = Array.prototype.find.call(tabs, function(t) { return !t.classList.contains("hidden"); });
      if (firstVisible) firstVisible.setAttribute("tabindex", "0");

      tabs.forEach(function(tab) {
        tab.addEventListener("click", function() {
          var alreadyActive = tab.classList.contains("active");
          if (alreadyActive) {
            // Toggle off — show the hint, no panel expanded.
            _collapseAll();
            return;
          }
          _activate(tab);
        });
        // Keyboard navigation per ARIA Authoring Practices for tabs:
        //   ← / ↑ : previous visible tab (wraps)
        //   → / ↓ : next visible tab (wraps)
        //   Home  : first visible
        //   End   : last visible
        //   Space / Enter : activate (default browser behaviour on a
        //                   <button>, no extra handling needed)
        tab.addEventListener("keydown", function(e) {
          var key = e.key;
          if (key !== "ArrowLeft" && key !== "ArrowRight"
              && key !== "ArrowUp" && key !== "ArrowDown"
              && key !== "Home" && key !== "End") return;
          e.preventDefault();
          var visible = Array.prototype.filter.call(tabs, function(t) { return !t.classList.contains("hidden"); });
          if (!visible.length) return;
          var idx = visible.indexOf(tab);
          if (idx < 0) idx = 0;
          var nextIdx = idx;
          if (key === "ArrowLeft" || key === "ArrowUp") nextIdx = (idx - 1 + visible.length) % visible.length;
          else if (key === "ArrowRight" || key === "ArrowDown") nextIdx = (idx + 1) % visible.length;
          else if (key === "Home") nextIdx = 0;
          else if (key === "End") nextIdx = visible.length - 1;
          var next = visible[nextIdx];
          if (!next) return;
          _activate(next);
          next.focus();
        });
      });
    }());

    // ── Lightweight mockup refresh ───────────────────────────────
    // Problem: every slider `input` event used to call renderProducts(),
    // which tears down and rebuilds the entire product grid DOM (~26 cards,
    // each with a canvas redraw + event-handler re-binding). During a drag
    // that fires up to 60×/s, the main thread was spending all its time
    // rebuilding cards that were mostly offscreen anyway — sliders felt
    // completely unresponsive.
    //
    // Fix: two-layer optimization.
    //   1. scheduleMockupRefresh() coalesces bursts of input events into
    //      one update per animation frame via requestAnimationFrame.
    //   2. On that frame, only cards currently intersecting the viewport
    //      (tracked by IntersectionObserver) have their existing canvas
    //      re-drawn — no DOM teardown, no offscreen work.
    //
    // The heavyweight renderProducts() is still used when the set of cards
    // or their DOM shape actually changes (new Printify mockups arrive,
    // variants load, session catalog updates, etc.).
    var _visibleCards = (typeof WeakSet === "function") ? new WeakSet() : null;
    var _cardObserver = null;
    if (typeof IntersectionObserver === "function") {
      _cardObserver = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (!_visibleCards) return;
          if (entry.isIntersecting) _visibleCards.add(entry.target);
          else _visibleCards.delete(entry.target);
        });
      }, { rootMargin: "200px 0px", threshold: 0 });
    }
    function observeProductCards() {
      if (!_cardObserver) return;
      // Do NOT pre-populate _visibleCards — the observer will emit an initial
      // callback (async, within a frame) marking the cards that actually
      // intersect the viewport. Pre-adding all cards defeats the whole point
      // of offscreen-skipping: the first rAF after slider drag would refresh
      // every mockup, re-introducing the lag for users scrolled near the top.
      var cards = productGrid ? productGrid.querySelectorAll(".product-card") : [];
      cards.forEach(function(c) { _cardObserver.observe(c); });
      var userReqGrid = document.getElementById("userRequestsGrid");
      if (userReqGrid) {
        userReqGrid.querySelectorAll(".product-card").forEach(function(c) {
          _cardObserver.observe(c);
        });
      }
    }
    function _isCardVisible(card) {
      // No observer support (ancient browser) → refresh everything.
      if (!_visibleCards || !_cardObserver) return true;
      return _visibleCards.has(card);
    }
    var _pendingRefresh = false;
    function scheduleMockupRefresh() {
      if (_pendingRefresh) return;
      _pendingRefresh = true;
      (window.requestAnimationFrame || function(cb) { return setTimeout(cb, 16); })(function() {
        _pendingRefresh = false;
        _refreshVisibleMockups();
      });
    }
    // renderCanvas is the single biggest cost per slider input (~8ms on a 2K
    // source image). During a drag the browser fires `input` events at up to
    // 60/s, so back-to-back synchronous renderCanvas calls block the main
    // thread and starve subsequent events. scheduleCanvasRender collapses
    // bursts into one paint per animation frame — the slider's DOM value
    // still updates immediately (so the numeric readout tracks the thumb),
    // but the canvas redraws at display refresh rate.
    var _pendingCanvasRender = false;
    function scheduleCanvasRender() {
      if (_pendingCanvasRender) return;
      _pendingCanvasRender = true;
      (window.requestAnimationFrame || function(cb) { return setTimeout(cb, 16); })(function() {
        _pendingCanvasRender = false;
        renderCanvas();
      });
    }
    function _refreshVisibleMockups() {
      if (!productGrid || !state.originalImage || !solarCanvas || solarCanvas.width === 0) return;
      var allCards = productGrid.querySelectorAll(".product-card");
      var userReqGrid = document.getElementById("userRequestsGrid");
      if (userReqGrid) {
        allCards = Array.prototype.concat.call(
          Array.prototype.slice.call(allCards),
          Array.prototype.slice.call(userReqGrid.querySelectorAll(".product-card"))
        );
      }
      for (var i = 0; i < allCards.length; i++) {
        var card = allCards[i];
        if (!_isCardVisible(card)) continue;
        var pid = card.dataset.productId;
        var product = PRODUCTS.find(function(p) { return p.id === pid; });
        if (!product) continue;
        // A card shows either a Printify-hosted <img> (already final) or a
        // canvas we own. Only the canvas path needs live updates from edits.
        var preview = card.querySelector(".product-preview");
        if (!preview) continue;
        var canvas = preview.querySelector("canvas");
        if (!canvas) continue;
        var mctx = canvas.getContext("2d");
        var variant = (typeof getSelectedVariantForProduct === "function")
          ? getSelectedVariantForProduct(pid) : null;
        mctx.clearRect(0, 0, canvas.width, canvas.height);
        drawProductMockup(mctx, pid, solarCanvas.width, solarCanvas.height, variant);
      }
    }

    // ── Sliders ──────────────────────────────────────────────────
    // scheduleMockupRefresh is rAF-coalesced + offscreen-skipping, so it's
    // cheap enough to call from every slider — users now see brightness/
    // contrast/saturation changes reflected in visible product mockups too.
    function setupSlider(sliderId, valId, stateKey) {
      var slider = $("#" + sliderId);
      var valEl = $("#" + valId);
      slider.addEventListener("input", function() {
        state[stateKey] = parseInt(slider.value, 10);
        valEl.textContent = slider.value;
        scheduleCanvasRender();
        scheduleMockupRefresh();
      });
    }

    setupSlider("brightnessSlider", "brightnessVal", "brightness");
    setupSlider("contrastSlider", "contrastVal", "contrast");
    // Hue: shares the same setup, but the readout needs a "°" suffix
    // (otherwise it reads as a raw integer next to the other 0-200
    // scales). Wired inline rather than extending setupSlider with
    // a format-string param for a one-off.
    var _hueSliderEl = $("#hueSlider");
    var _hueValEl = $("#hueVal");
    if (_hueSliderEl && _hueValEl) {
      _hueSliderEl.addEventListener("input", function() {
        state.hue = parseInt(_hueSliderEl.value, 10) || 0;
        _hueValEl.textContent = state.hue + "°";
        scheduleCanvasRender();
        scheduleMockupRefresh();
      });
    }
    setupSlider("saturationSlider", "saturationVal", "saturation");
    // Vignette slider is inverted: slider 0 = max vignette (100), slider 100 = no vignette (0)
    var vignetteSliderEl = $("#vignetteSlider");
    var vignetteValEl = $("#vignetteVal");
    if (vignetteSliderEl) {
      vignetteSliderEl.addEventListener("input", function() {
        state.vignette = 100 - parseInt(vignetteSliderEl.value, 10);
        vignetteValEl.textContent = state.vignette;
        scheduleCanvasRender();
        scheduleMockupRefresh();
      });
    }
    setupSlider("vigWidthSlider", "vigWidthVal", "vignetteWidth");

    // ── Double-click any slider → reset it to its default ──────
    // Every editor slider sets its HTML `value=` attribute to the
    // intended default (brightness=0, crop=100, vignette=76 i.e.
    // state.vignette=24 after inversion, hue=0, etc.). On dblclick we
    // read the input's defaultValue (which reflects that HTML default
    // even if the user has dragged it), assign it back, and dispatch
    // an `input` event so every existing slider handler — including
    // the inverted-mapping wrappers like vignetteSlider — runs through
    // its normal wiring (state update + scheduleCanvasRender +
    // scheduleMockupRefresh). One delegated handler covers every
    // range input in the document, including ones added later by
    // dynamic panels (clock numbers, text tool, etc.).
    document.addEventListener("dblclick", function(e) {
      var el = e.target;
      if (!(el && el.tagName === "INPUT" && el.type === "range")) return;
      // Respect explicit opt-out (so a slider that wants a custom
      // default can carry data-no-dblclick-reset and skip this).
      if (el.dataset && el.dataset.noDblclickReset != null) return;
      var def = el.defaultValue;
      if (def == null || def === "") return;
      if (el.value === def) return; // nothing to do
      el.value = def;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      // Some sliders also key off "change" rather than "input" (rare,
      // but cheap insurance).
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // ── Slider step buttons (Cole Ramirez round-2 motor/AT, P0) ──────
    // Every continuous range input gets a visible −/+ button pair. The
    // win: macOS/iOS Voice Control users can say "Click decrease
    // vignette" instead of "Press left arrow" 40×, and Switch Control
    // users get a discrete, scannable target per direction. The buttons
    // dispatch the SAME synthetic input+change events the dblclick-reset
    // handler above uses, so every existing slider handler — including
    // the inverted vignette mapping and the hue-degree readout — runs
    // unchanged, with no per-slider wiring. A discrete tap/click/Enter/
    // voice-activation moves one native `step`; press-and-hold
    // auto-repeats for pointer + switch users. Buttons stay in the tab
    // order so Switch Control scans them; keyboard users who prefer the
    // arrow keys can still ignore them (the slider thumb is the next
    // stop). Opt out per-input with data-no-step-buttons.
    function _sliderLabelText(slider) {
      var row = slider.closest(".slider-row, .field-row, .timestamp-pos-offset");
      if (row) {
        var lbl = row.querySelector("label, .field-label-sm");
        if (lbl && lbl.textContent.trim()) return lbl.textContent.trim().replace(/:$/, "");
      }
      return slider.getAttribute("aria-label") || slider.getAttribute("title") || "value";
    }
    function _stepSlider(slider, dir) {
      var step = parseFloat(slider.step) || 1;
      var min = slider.min !== "" ? parseFloat(slider.min) : -Infinity;
      var max = slider.max !== "" ? parseFloat(slider.max) : Infinity;
      var cur = parseFloat(slider.value);
      if (isNaN(cur)) cur = 0;
      var next = Math.min(max, Math.max(min, cur + dir * step));
      // Guard against float drift accumulating off-grid values.
      next = Math.round(next * 1e6) / 1e6;
      if (next === cur) return;
      slider.value = next;
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function _makeStepBtn(slider, dir, labelText) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slider-step-btn";
      btn.setAttribute("aria-label", (dir < 0 ? "Decrease " : "Increase ") + labelText);
      // aria-hidden glyph: the accessible name comes from aria-label, so
      // AT doesn't read "minus" / "plus" on top of "Decrease vignette".
      btn.innerHTML = '<span aria-hidden="true">' + (dir < 0 ? "−" : "+") + "</span>";
      var holdTimer = null, repeatTimer = null, didRepeat = false;
      function endHold() {
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
      }
      btn.addEventListener("pointerdown", function (e) {
        if (e.button != null && e.button !== 0) return; // primary / touch only
        didRepeat = false;
        holdTimer = setTimeout(function () {
          didRepeat = true;
          repeatTimer = setInterval(function () { _stepSlider(slider, dir); }, 60);
        }, 350);
      });
      btn.addEventListener("pointerup", endHold);
      btn.addEventListener("pointerleave", endHold);
      btn.addEventListener("pointercancel", endHold);
      btn.addEventListener("click", function () {
        // A press-and-hold that already auto-repeated fires a trailing
        // click; suppress it so the count isn't off by one. A plain
        // tap / keyboard Enter / Voice Control activation lands here
        // with didRepeat=false and does exactly one step.
        if (didRepeat) { didRepeat = false; return; }
        _stepSlider(slider, dir);
      });
      return btn;
    }
    function decorateSlidersWithStepButtons(root) {
      var sliders = (root || document).querySelectorAll('input[type="range"]');
      Array.prototype.forEach.call(sliders, function (slider) {
        if (slider.dataset.stepDecorated) return;
        if (slider.dataset.noStepButtons != null) return;
        slider.dataset.stepDecorated = "1";
        var labelText = _sliderLabelText(slider);
        var minus = _makeStepBtn(slider, -1, labelText);
        var plus = _makeStepBtn(slider, +1, labelText);
        slider.parentNode.insertBefore(minus, slider);
        if (slider.nextSibling) slider.parentNode.insertBefore(plus, slider.nextSibling);
        else slider.parentNode.appendChild(plus);
      });
    }
    decorateSlidersWithStepButtons(document);

    // ── Crop & Vignette presets ───────────────────────────────────
    // Split into two independent axes so users can mix crop tightness with
    // vignette treatment freely, rather than picking from five combined
    // presets. Each axis sets only its own state fields and re-syncs the
    // corresponding slider DOM — the other axis is left untouched.
    // Compute the cropZoom % that fits the entire source image inside the
    // current product frame with no clipping (letterbox on the mismatched
    // axis). At zoom=100, the reference image fills the canvas on one axis
    // and gets clipped on the other; we want the *smaller* of the two fit
    // ratios so both axes fit. For a square source on a square product this
    // equals 100 (same as "fill"). For a 2:1 mug with square source it's
    // ~50. For extreme aspects it can go below the slider's old 50 floor,
    // which is why the slider min was dropped to 25.
    function computeFullCropZoom() {
      if (!state.originalImage) return 100;
      var ref = state.originalImage;
      var refW = ref.naturalWidth || 1;
      var refH = ref.naturalHeight || 1;
      var rotated = (state.rotation % 180 !== 0);
      var refCW = rotated ? refH : refW;
      var refCH = rotated ? refW : refH;
      var product = state.selectedProduct
        ? PRODUCTS.find(function(p) { return p.id === state.selectedProduct; })
        : null;
      var ar = getEffectiveAspectRatio(product);
      var cw = refCW, ch = refCH;
      if (product && ar && ar.w && ar.h) {
        var R = ar.w / ar.h;
        if (R >= refCW / refCH) {
          cw = refCW;
          ch = Math.max(1, Math.floor(refCW / R));
        } else {
          ch = refCH;
          cw = Math.max(1, Math.floor(refCH * R));
        }
      }
      var fit = Math.min(cw / refCW, ch / refCH);
      return Math.max(25, Math.min(300, Math.round(fit * 100)));
    }
    var CROP_MODES = {
      // cropZoom % of image inside the frame. Lower = more padding, higher =
      // tighter. `full` is a function because it depends on the currently
      // selected product's aspect ratio relative to the source image.
      full: computeFullCropZoom, // fits entire image inside print area
      fit:  71,                  // full solar disk with breathing room
      fill: 100,                 // frame edge-to-edge
    };
    // Vignette is split into two presets so each axis is independently
    // selectable: EDGE controls feather softness (vignetteWidth), RADIUS
    // controls how much of the image is inside the clear region (vignette
    // intensity, where 0 = no vignette and higher = tighter circle).
    var VIGNETTE_EDGE_MODES = {
      sharp: 0,   // crisp circle
      soft:  22,  // feathered fade
    };
    // The "disk" and "fit" presets are aspect-aware functions —
    // a constant slider value gives different physical radii on
    // a square vs. portrait canvas, so the preset has to invert
    // the renderer's geometry per current product.
    //   disk → vignette circle = 1 solar radius (R☉, 960" of sky)
    //   fit  → vignette circle = largest inscribed circle that
    //          touches the print rectangle's edge midpoints
    //          (radius = min(W,H)/2)
    var VIGNETTE_RADIUS_MODES = {
      off:  0,    // no vignette
      full: 12,   // gentle fade — vignette only catches the corners
      fit:  computeFitVignette,   // inscribed circle, edge-midpoints
      disk: computeDiskVignette,  // 1 R☉
    };
    // Both "fit" and "disk" are aspect- AND shape-aware: the
    // renderer uses a different maxR for round print areas
    // (inscribed-circle radius) vs. rectangular ones (half the
    // diagonal), so the same physical vignette size needs a
    // different slider value depending on whether the current
    // product's print boundary is a circle.
    function _isCircularSelectedProduct() {
      var p = (typeof PRODUCTS !== "undefined" && state.selectedProduct)
        ? PRODUCTS.find(function(x) { return x.id === state.selectedProduct; })
        : null;
      return (state.selectedProduct === "wall_clock") ||
             (p && p.printShape === "circle");
    }
    // Solve vigR = maxR · (1 − v/100 · 0.9) for the slider value that
    // gives the largest inscribed circle in the print rectangle:
    //   vigR  = min(W, H) / 2                  (inscribed circle radius)
    //   maxR  = ½ · √(W² + H²)                  (renderer's reference)
    //   v     = (1 − min(W,H) / √(W²+H²)) · 100 / 0.9
    // On a 1:1 product this is ~33; on a circular product the print
    // boundary already IS the inscribed circle so the answer is 0.
    function computeFitVignette() {
      if (_isCircularSelectedProduct()) return 0;
      var product = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
      var ar = (product && typeof getEffectiveAspectRatio === "function")
        ? getEffectiveAspectRatio(product)
        : null;
      var W = ar ? ar.w : 1;
      var H = ar ? ar.h : 1;
      var minDim = Math.min(W, H);
      var diag = Math.sqrt(W * W + H * H);
      var ratio = minDim / diag;
      var v = (1 - ratio) * 100 / 0.9;
      return Math.max(0, Math.min(100, Math.round(v)));
    }
    // Solve the renderer's vignette geometry for the slider value that
    // produces a vignette radius equal to one solar radius:
    //   - Renderer: vigR = maxR · (1 − v/100 · 0.9)
    //     where maxR = ½·√(W² + H²) (half the canvas diagonal)
    //   - Astronomy: 1 R☉ = 960" of sky; FITS sampling is 0.6"/px on a
    //     4096-px frame, so disk radius in image-px = 1600. The image
    //     is drawn at scale max(W,H)/4096, so on the canvas the disk
    //     radius = 0.3906 · max(W, H).
    //   - The JPG branch in renderCanvas() scales JPG by 3000/(4096·0.6)
    //     so JPG and FITS land the disk at the same canvas size — the
    //     formula below covers both.
    // Setting vigR = disk-radius and solving for v:
    //   v = (1 − 0.78125 · max(W,H) / √(W² + H²)) · 100 / 0.9
    function computeDiskVignette() {
      var product = (typeof PRODUCTS !== "undefined" && state.selectedProduct)
        ? PRODUCTS.find(function(p) { return p.id === state.selectedProduct; })
        : null;
      var ar = (product && typeof getEffectiveAspectRatio === "function")
        ? getEffectiveAspectRatio(product)
        : null;
      var W = ar ? ar.w : 1;
      var H = ar ? ar.h : 1;
      var maxDim = Math.max(W, H);
      var minDim = Math.min(W, H);
      var diag = Math.sqrt(W * W + H * H);
      // 0.78125 = 2 · 960 / (4096 · 0.6) = 2 · solar-radius-arcsec /
      // FITS-extent-arcsec. The factor of 2 cancels the renderer's
      // ½ in maxR. For round products the renderer's maxR is
      // min/2 (inscribed circle radius) instead of diag/2, so the
      // ratio divisor changes.
      var ratio = _isCircularSelectedProduct()
        ? (0.78125 * maxDim / minDim)
        : (0.78125 * maxDim / diag);
      var v = (1 - ratio) * 100 / 0.9;
      // Slider snaps to integers; round so the preset value
      // round-trips cleanly through the slider→state→preset path.
      return Math.max(0, Math.min(100, Math.round(v)));
    }
    // Crop-edge presets, per-axis. The crop-edge sliders go 0–100;
    // 38 reads as a clear softness without eating much of the print
    // area. (Started at 75; user feedback was that was too aggressive.)
    var CROP_EDGE_MODES = {
      hard: 0,
      soft: 38,
    };

    function applyCropMode(modeName) {
      var entry = CROP_MODES[modeName];
      if (entry == null) return;
      // `full` is a function (depends on current product + image); others are
      // plain numbers. Resolve lazily so product switches pick the right fit.
      var zoom = (typeof entry === "function") ? entry() : entry;
      state.cropZoom = zoom;
      var cs = $("#cropSlider"), cv = $("#cropVal");
      if (cs) { cs.value = zoom; cv.textContent = zoom + "%"; }
      _syncPresetActiveButtons();
      applyCanvasView();
      renderCanvas();
      scheduleMockupRefresh();
    }

    function applyVignetteEdgeMode(modeName) {
      var w = VIGNETTE_EDGE_MODES[modeName];
      if (w == null) return;
      state.vignetteWidth = w;
      var vws = $("#vigWidthSlider"), vwv = $("#vigWidthVal");
      if (vws) { vws.value = w; vwv.textContent = w; }
      _syncPresetActiveButtons();
      applyCanvasView();
      renderCanvas();
      scheduleMockupRefresh();
    }

    function applyVignetteRadiusMode(modeName) {
      var entry = VIGNETTE_RADIUS_MODES[modeName];
      if (entry == null) return;
      // disk is a function (depends on the selected product's aspect
      // ratio); the other modes are plain numbers. Resolve lazily so
      // switching products picks up the right disk-radius value.
      var v = (typeof entry === "function") ? entry() : entry;
      state.vignette = v;
      // vignetteSlider stores 100 - intensity (per existing convention at line 2609)
      var vs = $("#vignetteSlider"),  vv  = $("#vignetteVal");
      if (vs)   { vs.value   = 100 - v; vv.textContent   = v; }
      _syncPresetActiveButtons();
      applyCanvasView();
      renderCanvas();
      scheduleMockupRefresh();
    }

    // Crop-edge feather presets, per axis. Sets only its own state field
    // and re-syncs the corresponding slider; the other axis is untouched.
    function applyCropEdgeXMode(modeName) {
      var v = CROP_EDGE_MODES[modeName];
      if (v == null) return;
      state.cropEdgeFeatherX = v;
      var s = $("#cropEdgeXSlider"), val = $("#cropEdgeXVal");
      if (s) { s.value = v; val.textContent = v; }
      _syncPresetActiveButtons();
      applyCanvasView();
      renderCanvas();
      scheduleMockupRefresh();
    }
    function applyCropEdgeYMode(modeName) {
      var v = CROP_EDGE_MODES[modeName];
      if (v == null) return;
      state.cropEdgeFeatherY = v;
      var s = $("#cropEdgeYSlider"), val = $("#cropEdgeYVal");
      if (s) { s.value = v; val.textContent = v; }
      _syncPresetActiveButtons();
      applyCanvasView();
      renderCanvas();
      scheduleMockupRefresh();
    }

    // Highlight the preset button that currently matches state, so the user
    // can see which mode is active without reading slider values.
    function _syncPresetActiveButtons() {
      var cropMode = null;
      Object.keys(CROP_MODES).forEach(function(k) {
        var val = CROP_MODES[k];
        var target = (typeof val === "function") ? val() : val;
        if (state.cropZoom === target) cropMode = k;
      });
      document.querySelectorAll(".preset-btn[data-crop]").forEach(function(btn) {
        btn.classList.toggle("active", btn.dataset.crop === cropMode);
      });
      var vigEdgeMode = null;
      Object.keys(VIGNETTE_EDGE_MODES).forEach(function(k) {
        if (state.vignetteWidth === VIGNETTE_EDGE_MODES[k]) vigEdgeMode = k;
      });
      document.querySelectorAll(".preset-btn[data-vignette-edge]").forEach(function(btn) {
        btn.classList.toggle("active", btn.dataset.vignetteEdge === vigEdgeMode);
      });
      var vigRadiusMode = null;
      Object.keys(VIGNETTE_RADIUS_MODES).forEach(function(k) {
        var entry = VIGNETTE_RADIUS_MODES[k];
        var target = (typeof entry === "function") ? entry() : entry;
        if (state.vignette === target) vigRadiusMode = k;
      });
      document.querySelectorAll(".preset-btn[data-vignette-radius]").forEach(function(btn) {
        btn.classList.toggle("active", btn.dataset.vignetteRadius === vigRadiusMode);
      });
      // Crop-edge X / Y presets
      var cexMode = null, ceyMode = null;
      Object.keys(CROP_EDGE_MODES).forEach(function(k) {
        if ((state.cropEdgeFeatherX || 0) === CROP_EDGE_MODES[k]) cexMode = k;
        if ((state.cropEdgeFeatherY || 0) === CROP_EDGE_MODES[k]) ceyMode = k;
      });
      document.querySelectorAll(".preset-btn[data-crop-edge-x]").forEach(function(btn) {
        btn.classList.toggle("active", btn.dataset.cropEdgeX === cexMode);
      });
      document.querySelectorAll(".preset-btn[data-crop-edge-y]").forEach(function(btn) {
        btn.classList.toggle("active", btn.dataset.cropEdgeY === ceyMode);
      });
    }

    document.querySelectorAll(".preset-btn[data-crop]").forEach(function(btn) {
      btn.addEventListener("click", function() { applyCropMode(this.dataset.crop); });
    });
    document.querySelectorAll(".preset-btn[data-vignette-edge]").forEach(function(btn) {
      btn.addEventListener("click", function() { applyVignetteEdgeMode(this.dataset.vignetteEdge); });
    });
    document.querySelectorAll(".preset-btn[data-vignette-radius]").forEach(function(btn) {
      btn.addEventListener("click", function() { applyVignetteRadiusMode(this.dataset.vignetteRadius); });
    });
    document.querySelectorAll(".preset-btn[data-crop-edge-x]").forEach(function(btn) {
      btn.addEventListener("click", function() { applyCropEdgeXMode(this.dataset.cropEdgeX); });
    });
    document.querySelectorAll(".preset-btn[data-crop-edge-y]").forEach(function(btn) {
      btn.addEventListener("click", function() { applyCropEdgeYMode(this.dataset.cropEdgeY); });
    });
    // Initial sync so buttons reflect default state on load.
    _syncPresetActiveButtons();

    // ── Frame-border overlay checkbox ────────────────────────────
    var showOverlayCheck = document.getElementById("showOverlayCheck");
    if (showOverlayCheck) {
      showOverlayCheck.checked = state.showOverlay !== false;
      showOverlayCheck.addEventListener("change", function() {
        state.showOverlay = showOverlayCheck.checked;
        renderCanvas();
      });
    }

    // ── Guide-lines checkbox ──────────────────────────────────────
    var showGuidesCheck = document.getElementById("showGuidesCheck");
    if (showGuidesCheck) {
      showGuidesCheck.checked = !!state.showGuides;
      showGuidesCheck.addEventListener("change", function() {
        state.showGuides = showGuidesCheck.checked;
        renderCanvas();
      });
    }

    // ── Vignette fade: filter-style toggle (transparent / black / white / mode / custom) ──
    function updateMatchButtonColor() {
      var modeOpt = document.querySelector(".filter-opt-mode");
      if (!modeOpt) return;
      if (modeOpt.classList.contains("active") || (modeOpt.querySelector('input[name="vignetteFade"]') && modeOpt.querySelector('input[name="vignetteFade"]').checked)) {
        modeOpt.style.background = "";
        modeOpt.style.color = "";
        return;
      }
      var r = state._vignetteModeR !== undefined ? state._vignetteModeR : 128;
      var g = state._vignetteModeG !== undefined ? state._vignetteModeG : 128;
      var b = state._vignetteModeB !== undefined ? state._vignetteModeB : 128;
      var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      modeOpt.style.background = "rgb(" + r + "," + g + "," + b + ")";
      modeOpt.style.color = lum < 0.5 ? "#fff" : "#000";
    }
    function syncVignetteFadeUI() {
      var toggle = document.getElementById("vignetteFadeToggle");
      if (!toggle) return;
      var current = state.vignetteFade || "black";
      toggle.querySelectorAll(".filter-opt").forEach(function(opt) {
        var radio = opt.querySelector('input[name="vignetteFade"]');
        if (radio) {
          if (radio.value === current) radio.checked = true;
          opt.classList.toggle("active", radio.checked);
        }
      });
      var picker = $("#vignetteFadeColorPicker");
      if (picker) picker.value = state.vignetteFadeColor || "#000000";
      var colorOpt = toggle.querySelector(".filter-opt-color");
      if (colorOpt) {
        var hex = (state.vignetteFadeColor || "#000000").replace(/^#/, "");
        colorOpt.style.background = "#" + hex;
        var r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
        var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        colorOpt.style.color = lum < 0.5 ? "#fff" : "#000";
      }
      if (typeof updateMatchButtonColor === "function") updateMatchButtonColor();
    }
    var vignetteFadeToggle = document.getElementById("vignetteFadeToggle");
    if (vignetteFadeToggle) {
      vignetteFadeToggle.addEventListener("change", function(e) {
        if (e.target.name !== "vignetteFade") return;
        state.vignetteFade = e.target.value || "transparent";
        syncVignetteFadeUI();
        renderCanvas();
        scheduleMockupRefresh();
      });
    }
    var vignetteFadeColorPicker = $("#vignetteFadeColorPicker");
    if (vignetteFadeColorPicker) {
      vignetteFadeColorPicker.addEventListener("click", function() {
        // When switching to Custom, seed the picker with the current "match" (mode) colour
        // so the user starts from the dominant canvas colour instead of plain black.
        if (state.vignetteFade !== "custom") {
          var mr = state._vignetteModeR !== undefined ? state._vignetteModeR : 0;
          var mg = state._vignetteModeG !== undefined ? state._vignetteModeG : 0;
          var mb = state._vignetteModeB !== undefined ? state._vignetteModeB : 0;
          var modeHex = "#" +
            ("0" + Math.max(0, Math.min(255, mr)).toString(16)).slice(-2) +
            ("0" + Math.max(0, Math.min(255, mg)).toString(16)).slice(-2) +
            ("0" + Math.max(0, Math.min(255, mb)).toString(16)).slice(-2);
          state.vignetteFadeColor = modeHex;
          vignetteFadeColorPicker.value = modeHex;
        }
        state.vignetteFade = "custom";
        var toggle = document.getElementById("vignetteFadeToggle");
        if (toggle) {
          var radio = toggle.querySelector('input[name="vignetteFade"][value="custom"]');
          if (radio) radio.checked = true;
          syncVignetteFadeUI();
        }
        renderCanvas();
        scheduleMockupRefresh();
      });
      vignetteFadeColorPicker.addEventListener("input", function() {
        state.vignetteFadeColor = vignetteFadeColorPicker.value;
        syncVignetteFadeUI();
        if (state.vignetteFade === "custom") {
          renderCanvas();
          scheduleMockupRefresh();
        }
      });
      vignetteFadeColorPicker.addEventListener("change", function() {
        syncVignetteFadeUI();
        if (state.vignetteFade === "custom") {
          renderCanvas();
          scheduleMockupRefresh();
        }
      });
    }

    // ── Crop edge: feather the edges of the crop viewport ──
    // The X/Y feather is now baked into the pixel data inside
    // renderCanvas() so it propagates to mockups and exports. This
    // function used to also apply an SVG mask via CSS for the editor
    // canvas — now redundant and would double the effect, so we just
    // clear any leftover mask styles. Kept as a callable function so
    // other code paths that still call it don't need to change.
    function applyCropEdgeMask() {
      if (!solarCanvas) return;
      solarCanvas.style.maskImage = "";
      solarCanvas.style.maskSize = "";
      solarCanvas.style.maskRepeat = "";
      solarCanvas.style.webkitMaskImage = "";
      solarCanvas.style.webkitMaskSize = "";
      solarCanvas.style.webkitMaskRepeat = "";
    }
    var cropEdgeXSlider = $("#cropEdgeXSlider");
    var cropEdgeXVal = $("#cropEdgeXVal");
    if (cropEdgeXSlider) {
      cropEdgeXSlider.addEventListener("input", function() {
        state.cropEdgeFeatherX = parseInt(cropEdgeXSlider.value, 10);
        cropEdgeXVal.textContent = state.cropEdgeFeatherX;
        // Re-render the canvas so the new feather bakes into the pixel
        // data — the mockup snapshot reads the canvas directly, so the
        // edge fade now propagates into product cards / preview pane
        // (the previous CSS-only mask only affected the editor view).
        applyCropEdgeMask();
        if (typeof _syncPresetActiveButtons === "function") _syncPresetActiveButtons();
        scheduleCanvasRender();
        scheduleMockupRefresh();
      });
    }
    var cropEdgeYSlider = $("#cropEdgeYSlider");
    var cropEdgeYVal = $("#cropEdgeYVal");
    if (cropEdgeYSlider) {
      cropEdgeYSlider.addEventListener("input", function() {
        state.cropEdgeFeatherY = parseInt(cropEdgeYSlider.value, 10);
        cropEdgeYVal.textContent = state.cropEdgeFeatherY;
        applyCropEdgeMask();
        if (typeof _syncPresetActiveButtons === "function") _syncPresetActiveButtons();
        scheduleCanvasRender();
        scheduleMockupRefresh();
      });
    }

    // Crop slider and pan control the crop box (drawn on canvas); no CSS transform.
    function applyCanvasView() {
      if (!solarCanvas) return;
      solarCanvas.style.transform = "none";
    }
    var cropSlider = $("#cropSlider");
    var cropVal = $("#cropVal");
    if (cropSlider) {
      cropSlider.addEventListener("input", function() {
        var pct = parseInt(cropSlider.value, 10);
        state.cropZoom = pct;
        cropVal.textContent = pct + "%";
        applyCanvasView();
        scheduleCanvasRender();
        scheduleMockupRefresh();
      });
    }

    // ── Text tool ───────────────────────────────────────────────
    var textToolPanel = $("#textToolPanel");
    var textInput = $("#textInput");
    var textSizeSlider = $("#textSizeSlider");
    var textSizeVal = $("#textSizeVal");
    var textFontSelect = $("#textFontSelect");
    var textColorPicker = $("#textColorPicker");
    var textStrokePicker = $("#textStrokePicker");
    var textStrokeWidthSlider = $("#textStrokeWidth");
    var textStrokeVal = $("#textStrokeVal");

    // Populate font dropdown from catalog
    populateFontSelect();
    populateClockNumbersFontSelect();
    var textDragging = false;
    var textDragOffsetX = 0;
    var textDragOffsetY = 0;

    function enterTextMode() {
      state.textMode = true;
      document.querySelector('[data-tool="text"]').classList.add("active");
      textToolPanel.classList.remove("hidden");
      var clockPanel = document.getElementById("tabPanel_clock");
      if (clockPanel) clockPanel.classList.add("hidden");

      // Initialise overlay at centre of current canvas. Both legacy
      // absolute (x/y/size) AND normalised (xNorm/yNorm/sizeNorm) are
      // stored — the render path prefers norm, the slider readout still
      // shows the absolute slider value the user picked.
      if (!state.textOverlay) {
        var _sliderSize = parseInt(textSizeSlider.value, 10);
        state.textOverlay = {
          text: textInput.value || "Hello Sun",
          x: solarCanvas.width / 2,
          y: solarCanvas.height / 2,
          xNorm: 0.5,
          yNorm: 0.5,
          size: _sliderSize,
          sizeNorm: _sliderSize / _TEXT_REF_SIZE,
          font: textFontSelect.value,
          color: textColorPicker.value,
          strokeColor: textStrokePicker.value,
          strokeWidth: parseInt(textStrokeWidthSlider.value, 10),
          shadow: { enabled: false, offsetX: 3, offsetY: 3, blur: 6, color: "#000000" },
          arc: { enabled: false, radius: 200 },
          outlined: false
        };
        if (!textInput.value) textInput.value = "Hello Sun";
      }

      solarCanvas.classList.add("text-dragging");
      renderCanvas();
    }

    function exitTextMode() {
      state.textMode = false;
      state.textOverlay = null;
      document.querySelector('[data-tool="text"]').classList.remove("active");
      textToolPanel.classList.add("hidden");
      solarCanvas.classList.remove("text-dragging");
      renderCanvas();
    }

    // Live-update text overlay as the user types / changes controls.
    // Uses the rAF-coalesced path so rapid slider/input events don't pile up
    // synchronous canvas repaints while the user is still moving the thumb.
    function syncTextOverlay() {
      if (!state.textOverlay) return;
      var sliderSize = parseInt(textSizeSlider.value, 10);
      state.textOverlay.text = textInput.value;
      state.textOverlay.size = sliderSize;
      // Keep the normalised size in lockstep with the slider so the
      // text scales correctly on canvas-size changes (HQ swap, snapshot).
      state.textOverlay.sizeNorm = sliderSize / _TEXT_REF_SIZE;
      state.textOverlay.font = textFontSelect.value;
      state.textOverlay.color = textColorPicker.value;
      state.textOverlay.strokeColor = textStrokePicker.value;
      state.textOverlay.strokeWidth = parseInt(textStrokeWidthSlider.value, 10);
      scheduleCanvasRender();
    }

    textInput.addEventListener("input", syncTextOverlay);
    textSizeSlider.addEventListener("input", function() {
      textSizeVal.textContent = textSizeSlider.value;
      syncTextOverlay();
    });
    textFontSelect.addEventListener("change", function() {
      var entry = FONT_CATALOG.find(function(f) { return f.name === textFontSelect.value; });
      if (entry && !loadedFonts[entry.name]) {
        loadGoogleFont(entry).then(function() { syncTextOverlay(); });
      } else {
        syncTextOverlay();
      }
    });
    textColorPicker.addEventListener("input", syncTextOverlay);
    textStrokePicker.addEventListener("input", syncTextOverlay);
    textStrokeWidthSlider.addEventListener("input", function() {
      textStrokeVal.textContent = textStrokeWidthSlider.value;
      syncTextOverlay();
    });

    // ── Text effect controls ───────────────────────────────────
    var textShadowToggle = $("#textShadowToggle");
    var textShadowColor = $("#textShadowColor");
    var textShadowBlur = $("#textShadowBlur");
    var textShadowBlurVal = $("#textShadowBlurVal");
    var textArcToggle = $("#textArcToggle");
    var textArcRadius = $("#textArcRadius");
    var textArcRadiusVal = $("#textArcRadiusVal");
    var textOutlineToggle = $("#textOutlineToggle");

    textShadowToggle.addEventListener("change", function() {
      if (state.textOverlay) state.textOverlay.shadow.enabled = textShadowToggle.checked;
      syncTextOverlay();
    });
    textShadowColor.addEventListener("input", function() {
      if (state.textOverlay) state.textOverlay.shadow.color = textShadowColor.value;
      syncTextOverlay();
    });
    textShadowBlur.addEventListener("input", function() {
      textShadowBlurVal.textContent = textShadowBlur.value;
      if (state.textOverlay) state.textOverlay.shadow.blur = parseInt(textShadowBlur.value, 10);
      syncTextOverlay();
    });
    textArcToggle.addEventListener("change", function() {
      if (state.textOverlay) state.textOverlay.arc.enabled = textArcToggle.checked;
      syncTextOverlay();
    });
    textArcRadius.addEventListener("input", function() {
      textArcRadiusVal.textContent = textArcRadius.value;
      if (state.textOverlay) state.textOverlay.arc.radius = parseInt(textArcRadius.value, 10);
      syncTextOverlay();
    });
    textOutlineToggle.addEventListener("change", function() {
      if (state.textOverlay) state.textOverlay.outlined = textOutlineToggle.checked;
      syncTextOverlay();
    });

    // ── Arc text renderer ──────────────────────────────────────
    function drawArcText(ctx, tov) {
      var text = tov.text;
      var radius = tov.arc.radius;
      // Use the resolved pixel coords (set by _resolveTextPx in the
      // caller) so arc text follows canvas-size changes the same way
      // straight text does.
      var centerX = (tov._pixelX != null) ? tov._pixelX : tov.x;
      var centerY = ((tov._pixelY != null) ? tov._pixelY : tov.y) + radius; // arc center is below the text anchor

      // Measure each character for proper angular spacing
      var chars = text.split("");
      var charWidths = chars.map(function(c) { return ctx.measureText(c).width; });
      var totalWidth = charWidths.reduce(function(a, b) { return a + b; }, 0);

      // Total angle the text spans; start centered
      var totalAngle = totalWidth / radius;
      var currentAngle = -Math.PI / 2 - totalAngle / 2; // start at top, centered

      chars.forEach(function(ch, i) {
        var halfChar = charWidths[i] / 2;
        currentAngle += halfChar / radius;

        ctx.save();
        ctx.translate(
          centerX + radius * Math.cos(currentAngle),
          centerY + radius * Math.sin(currentAngle)
        );
        ctx.rotate(currentAngle + Math.PI / 2);

        if (tov.strokeWidth > 0) {
          ctx.strokeStyle = tov.strokeColor;
          ctx.lineWidth = tov.strokeWidth * 2;
          ctx.lineJoin = "round";
          ctx.strokeText(ch, 0, 0);
        }
        if (!tov.outlined) {
          ctx.fillStyle = tov.color;
          ctx.fillText(ch, 0, 0);
        }

        ctx.restore();
        currentAngle += halfChar / radius;
      });
    }

    // Apply text — non-destructive. The overlay stays in state.textOverlay and
    // is re-rendered every frame in renderCanvas(). At checkout, getCanvasBase64
    // re-renders with _burningCanvas=true (which strips editing aids like the
    // frame border) and captures the text overlay into the uploaded image.
    // This keeps text editable right up until checkout — the user can change
    // wording, font, color, or position at any time without losing quality.
    $("#applyText").addEventListener("click", function() {
      if (!state.textOverlay || !state.textOverlay.text) {
        showToast("Enter some text first.", "error");
        return;
      }
      // Leave the overlay in place and just close the panel. Exit text-editing
      // mode so the canvas stops being draggable as "text mode".
      state.textMode = false;
      textToolPanel.classList.add("hidden");
      solarCanvas.classList.remove("text-dragging");
      // Swap the Text tool button back to "+ Text" so the user knows they can
      // reopen the panel to edit or clear the text overlay.
      var textBtn = document.querySelector('[data-tool="text"]');
      if (textBtn) {
        textBtn.classList.remove("active");
        textBtn.innerHTML = '<i class="fas fa-font"></i> Edit Text';
      }
      renderCanvas();
      showToast("Text applied. It stays editable — click Edit Text to change it, or it will be printed as-is.");
    });

    // Cancel text overlay
    $("#cancelText").addEventListener("click", function() {
      exitTextMode();
    });

    // ── Timestamp tool ─────────────────────────────────────────
    // Toggle, not a modal: flips state.timestampStamp and re-renders.
    // Caption text is composed at draw time from date + wavelength so
    // it stays correct if the user changes either after toggling on.
    var toolTimestampBtn = document.getElementById("toolTimestampBtn");
    var timestampPosGroup = document.getElementById("timestampPosGroup");
    if (toolTimestampBtn) {
      function _syncTimestampBtn() {
        toolTimestampBtn.classList.toggle("active", !!state.timestampStamp);
        if (timestampPosGroup) timestampPosGroup.classList.toggle("hidden", !state.timestampStamp);
      }
      _syncTimestampBtn();
      toolTimestampBtn.addEventListener("click", function() {
        state.timestampStamp = !state.timestampStamp;
        _syncTimestampBtn();
        if (state.timestampStamp && (!dateInput.value || !state.wavelength)) {
          showToast("Pick a date and wavelength first so the timestamp can read both.");
        }
        renderCanvas();
        scheduleMockupRefresh();
      });
    }
    // Position picker: 6 radios, one per top/bottom × left/center/right
    // anchor. Mark the matching radio on load (default bottom-right) and
    // re-render on change. The actual placement math lives in renderCanvas.
    if (timestampPosGroup) {
      var _posRadios = timestampPosGroup.querySelectorAll('input[type="radio"][name="timestampPos"]');
      _posRadios.forEach(function(rb) {
        if (rb.value === (state.timestampPos || "bottom-right")) rb.checked = true;
        rb.addEventListener("change", function() {
          if (!rb.checked) return;
          state.timestampPos = rb.value;
          renderCanvas();
          scheduleMockupRefresh();
        });
      });
    }
    // Vertical-offset slider — nudges the caption inward from the chosen
    // vertical anchor (0..100 → 0..30% of the canvas's shorter side).
    var tsOffsetSlider = document.getElementById("timestampOffsetSlider");
    var tsOffsetValEl = document.getElementById("timestampOffsetVal");
    if (tsOffsetSlider && tsOffsetValEl) {
      tsOffsetSlider.value = state.timestampVOffset || 0;
      tsOffsetValEl.textContent = tsOffsetSlider.value;
      tsOffsetSlider.addEventListener("input", function() {
        state.timestampVOffset = parseInt(tsOffsetSlider.value, 10) || 0;
        tsOffsetValEl.textContent = state.timestampVOffset;
        renderCanvas();
        scheduleMockupRefresh();
      });
    }

    // ── Clock numbers panel (wall_clock only) ───────────────────
    var clockNumbersPanel = document.getElementById("clockNumbersPanel");
    var clockNumbersFontSelect = document.getElementById("clockNumbersFontSelect");
    var clockNumbersColorPicker = document.getElementById("clockNumbersColorPicker");
    var clockNumbersStrokePicker = document.getElementById("clockNumbersStrokePicker");
    var clockNumbersStrokeWidth = document.getElementById("clockNumbersStrokeWidth");
    var clockNumbersStrokeVal = document.getElementById("clockNumbersStrokeVal");
    var clockNumbersSizeSlider = document.getElementById("clockNumbersSizeSlider");
    var clockNumbersSizeVal = document.getElementById("clockNumbersSizeVal");
    var clockNumbersRadiusSlider = document.getElementById("clockNumbersRadiusSlider");
    var clockNumbersRadiusVal = document.getElementById("clockNumbersRadiusVal");
    var clockNumbersStyleSelect = document.getElementById("clockNumbersStyleSelect");
    var ROMAN_NUMERALS = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
    function applyClockNumbersFromPanel() {
      state.clockNumbers = {
        font: clockNumbersFontSelect ? clockNumbersFontSelect.value : "Inter",
        color: clockNumbersColorPicker ? clockNumbersColorPicker.value : "#ffffff",
        strokeColor: clockNumbersStrokePicker ? clockNumbersStrokePicker.value : "#000000",
        strokeWidth: clockNumbersStrokeWidth ? parseInt(clockNumbersStrokeWidth.value, 10) : 2,
        size: clockNumbersSizeSlider ? parseInt(clockNumbersSizeSlider.value, 10) : 50,
        radiusPct: clockNumbersRadiusSlider ? parseInt(clockNumbersRadiusSlider.value, 10) : 80,
        style: clockNumbersStyleSelect ? clockNumbersStyleSelect.value : "arabic"
      };
      renderCanvas();
    }
    function liveUpdateClockNumbers() {
      applyClockNumbersFromPanel();
      // applyClockNumbersFromPanel calls renderCanvas (main editor) but the
      // mock mockups (live preview pane + product cards' canvas thumbs) are
      // separate paint paths. Refresh both so the user sees the numerals in
      // their fast preview, not only in the editor canvas.
      if (typeof refreshLivePreview === "function") refreshLivePreview();
      if (typeof scheduleMockupRefresh === "function") scheduleMockupRefresh();
    }
    if (clockNumbersStrokeWidth && clockNumbersStrokeVal) {
      clockNumbersStrokeWidth.addEventListener("input", function() {
        clockNumbersStrokeVal.textContent = clockNumbersStrokeWidth.value;
        liveUpdateClockNumbers();
      });
    }
    if (clockNumbersSizeSlider && clockNumbersSizeVal) {
      clockNumbersSizeSlider.addEventListener("input", function() {
        clockNumbersSizeVal.textContent = clockNumbersSizeSlider.value;
        liveUpdateClockNumbers();
      });
    }
    if (clockNumbersRadiusSlider && clockNumbersRadiusVal) {
      clockNumbersRadiusSlider.addEventListener("input", function() {
        clockNumbersRadiusVal.textContent = clockNumbersRadiusSlider.value + "%";
        liveUpdateClockNumbers();
      });
    }
    if (clockNumbersFontSelect) clockNumbersFontSelect.addEventListener("change", liveUpdateClockNumbers);
    if (clockNumbersColorPicker) clockNumbersColorPicker.addEventListener("input", liveUpdateClockNumbers);
    if (clockNumbersStrokePicker) clockNumbersStrokePicker.addEventListener("input", liveUpdateClockNumbers);
    if (clockNumbersStyleSelect) clockNumbersStyleSelect.addEventListener("change", liveUpdateClockNumbers);
    // Burn button removed: the numerals are kept as a live, non-destructive
    // overlay so users can revisit the panel and change them later. The
    // Hide-numerals button below sets state.clockNumbers = null when the
    // user wants the face bare.

    // ── Clock-numeral colour presets ───────────────────────────
    // Quick-pick row above the colour picker: Black / White / Mode /
    // Lighter Mode. "Mode" reads the dominant-image RGB the vignette
    // pixel pass already computes (state._vignetteModeR/G/B), so it's
    // always available as soon as the user has looked at the image
    // with any pixel-touching effect enabled. "Lighter Mode" mixes
    // that toward white so the numerals read clearly on a darker
    // version of the same colour palette.
    function _rgbToHex(r, g, b) {
      function h(n) {
        var v = Math.max(0, Math.min(255, Math.round(n))).toString(16);
        return v.length === 1 ? "0" + v : v;
      }
      return "#" + h(r) + h(g) + h(b);
    }
    // On-demand mode-colour computation. The existing pixel pass only
    // populates state._vignetteModeR/G/B when needsPixelWork is true
    // (any of brightness / contrast / saturation / vignette / crop-edge
    // feather active). If the user picks the Mode preset on an otherwise
    // untouched image, the cached value is missing — fall back to a
    // direct sample of the current canvas. Bucketed 3-bit-per-channel
    // histogram, identical convention to the pixel-pass version, but
    // applied to whatever's on solarCanvas right now.
    function _computeModeFromCanvas() {
      if (!solarCanvas || solarCanvas.width === 0) return null;
      try {
        var ctx2 = solarCanvas.getContext("2d");
        var img = ctx2.getImageData(0, 0, solarCanvas.width, solarCanvas.height);
        var d = img.data;
        var step = 32; // every 32nd pixel — plenty for a histogram of ~50k samples on a 1536² canvas
        var buckets = {};
        var maxCount = 0;
        var maxKey = "16,16,16";
        for (var si = 0; si < d.length; si += 4 * step) {
          var aa = d[si + 3];
          if (aa < 128) continue;
          var rr = d[si], gg = d[si + 1], bb = d[si + 2];
          if (rr <= 25 && gg <= 25 && bb <= 25) continue;
          if (rr >= 230 && gg >= 230 && bb >= 230) continue;
          var key = (rr >> 3) + "," + (gg >> 3) + "," + (bb >> 3);
          buckets[key] = (buckets[key] || 0) + 1;
          if (buckets[key] > maxCount) { maxCount = buckets[key]; maxKey = key; }
        }
        var parts = maxKey.split(",");
        return {
          r: (parseInt(parts[0], 10) << 3) + 4,
          g: (parseInt(parts[1], 10) << 3) + 4,
          b: (parseInt(parts[2], 10) << 3) + 4,
        };
      } catch (_e) {
        return null;
      }
    }
    function _modeColorHex() {
      var r = state._vignetteModeR;
      var g = state._vignetteModeG;
      var b = state._vignetteModeB;
      if (r == null || g == null || b == null) {
        var sampled = _computeModeFromCanvas();
        if (!sampled) return null;
        r = sampled.r; g = sampled.g; b = sampled.b;
        // Cache for "Lighter Mode" and other re-uses this frame.
        state._vignetteModeR = r;
        state._vignetteModeG = g;
        state._vignetteModeB = b;
      }
      return _rgbToHex(r, g, b);
    }
    function _lighterModeHex() {
      // Resolve the mode first (computes on-demand if not cached).
      if (!_modeColorHex()) return null;
      var r = state._vignetteModeR;
      var g = state._vignetteModeG;
      var b = state._vignetteModeB;
      // Mix 55% toward white — enough to lift a dark corona red toward
      // a peachy / pastel version that pops on the original mode bg.
      var mix = 0.55;
      return _rgbToHex(r + (255 - r) * mix, g + (255 - g) * mix, b + (255 - b) * mix);
    }
    function _resolveClockColorPreset(key) {
      if (key === "black") return "#000000";
      if (key === "white") return "#ffffff";
      if (key === "mode") return _modeColorHex();
      if (key === "lighter-mode") return _lighterModeHex();
      return null;
    }
    document.querySelectorAll(".clock-color-preset[data-clock-color]").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var hex = _resolveClockColorPreset(btn.dataset.clockColor);
        if (!hex) {
          // Mode/Lighter Mode unavailable until the pixel pass has
          // computed the dominant colour. Nudge the user.
          if (typeof showToast === "function") {
            showToast("Pick a vignette or brightness setting first so we can read the image's dominant color.");
          }
          return;
        }
        var picker = document.getElementById("clockNumbersColorPicker");
        if (picker) {
          picker.value = hex;
          picker.dispatchEvent(new Event("input", { bubbles: true }));
        }
        // Highlight the active preset (visual feedback that the click
        // landed). Any later picker-input clears the highlight since
        // we can't tell custom hexes apart from a stale preset.
        document.querySelectorAll(".clock-color-preset[data-clock-color]")
          .forEach(function(b) { b.classList.toggle("active", b === btn); });
      });
    });
    var _clockPickerEl = document.getElementById("clockNumbersColorPicker");
    if (_clockPickerEl) {
      _clockPickerEl.addEventListener("input", function() {
        document.querySelectorAll(".clock-color-preset[data-clock-color]")
          .forEach(function(b) { b.classList.remove("active"); });
      });
    }
    // Hide / Show toggle: flips state.clockNumbers between null (bare
    // face) and a seeded object (numerals visible). Stays inside the
    // clock tab so users can flip it on and off without navigating
    // away. Label + icon swap to match the current state.
    var cancelClockNumbersBtn = document.getElementById("cancelClockNumbers");
    function _syncClockToggleLabel() {
      if (!cancelClockNumbersBtn) return;
      var hasNums = !!state.clockNumbers;
      cancelClockNumbersBtn.innerHTML = hasNums
        ? '<i class="fas fa-eye-slash"></i> Hide numerals'
        : '<i class="fas fa-eye"></i> Show numerals';
    }
    _syncClockToggleLabel();
    if (cancelClockNumbersBtn) cancelClockNumbersBtn.addEventListener("click", function() {
      if (state.clockNumbers) {
        state.clockNumbers = null;
      } else if (typeof applyClockNumbersFromPanel === "function") {
        applyClockNumbersFromPanel();
      }
      _syncClockToggleLabel();
      renderCanvas();
      if (typeof scheduleMockupRefresh === "function") scheduleMockupRefresh();
    });

    // ── Text drag handling on canvas ───────────────────────────
    // Resolve text-overlay position + size from normalised storage into
    // pixel coords for the given canvas. Falls back to the legacy
    // absolute fields if the overlay was created before normalisation
    // landed (or via a path that hasn't been updated yet) — in that
    // case we ALSO write back the normalised fields so subsequent
    // renders / drags use the correct reference. Sets tov._pixelX,
    // tov._pixelY, tov._pixelSize.
    var _TEXT_REF_SIZE = 512;  // historical default canvas dim
    function _resolveTextPx(tov, cw, ch) {
      if (!tov) return;
      var refMin = Math.min(cw, ch) || _TEXT_REF_SIZE;
      // Position: norm if present, else infer from absolute / centre.
      if (tov.xNorm == null || tov.yNorm == null) {
        var refX = (tov.x != null) ? tov.x : cw / 2;
        var refY = (tov.y != null) ? tov.y : ch / 2;
        // Treat legacy absolute coords as relative to the current
        // canvas size — best we can do without knowing the size at
        // which they were set. Subsequent edits will re-normalise.
        tov.xNorm = refX / cw;
        tov.yNorm = refY / ch;
      }
      if (tov.sizeNorm == null) {
        // Slider values are interpreted relative to a 512-px reference
        // canvas so the same "48" stays visually proportional across
        // 512 preview vs 1536 HQ vs 4000 export.
        tov.sizeNorm = (tov.size != null ? tov.size : 48) / _TEXT_REF_SIZE;
      }
      tov._pixelX = tov.xNorm * cw;
      tov._pixelY = tov.yNorm * ch;
      tov._pixelSize = Math.max(4, tov.sizeNorm * refMin);
    }

    function isInsideText(canvasX, canvasY) {
      if (!state.textOverlay || !state.textOverlay.text) return false;
      var tov = state.textOverlay;
      // Ensure pixel coords are fresh for the current canvas.
      _resolveTextPx(tov, solarCanvas.width, solarCanvas.height);

      // Arc mode: use circular bounding region
      if (tov.arc && tov.arc.enabled) {
        var arcCenterY = tov._pixelY + tov.arc.radius;
        var dx = canvasX - tov._pixelX;
        var dy = canvasY - arcCenterY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        return Math.abs(dist - tov.arc.radius) < tov._pixelSize * 1.2;
      }

      // Straight text: rectangle hit test
      var ctx = solarCanvas.getContext("2d");
      ctx.save();
      ctx.font = "bold " + tov._pixelSize + "px '" + tov.font + "', sans-serif";
      var metrics = ctx.measureText(tov.text);
      ctx.restore();
      var hw = metrics.width / 2;
      var hh = tov._pixelSize / 2;
      return canvasX >= tov._pixelX - hw && canvasX <= tov._pixelX + hw &&
             canvasY >= tov._pixelY - hh && canvasY <= tov._pixelY + hh;
    }

    var panDragging = false;
    var panStartClientX = 0;
    var panStartClientY = 0;
    var panStartCanvasX = 0;
    var panStartCanvasY = 0;
    var panStartPanX = 0;
    var panStartPanY = 0;
    function isPanToolActive() {
      var btn = document.querySelector('.edit-btn[data-tool="pan"]');
      return btn && btn.classList.contains("active");
    }

    function onCanvasPointerDown(e) {
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var clientY = e.touches ? e.touches[0].clientY : e.clientY;
      if (isPanToolActive() && !state.textMode && !state.cropping) {
        e.preventDefault();
        panDragging = true;
        panStartClientX = clientX;
        panStartClientY = clientY;
        var coords = getCanvasCoords(e);
        panStartCanvasX = coords.x;
        panStartCanvasY = coords.y;
        var ref = state.originalImage;
        var refW = ref ? (state.rotation % 180 !== 0 ? ref.naturalHeight : ref.naturalWidth) : 0;
        var refH = ref ? (state.rotation % 180 !== 0 ? ref.naturalWidth : ref.naturalHeight) : 0;
        panStartPanX = state.panX != null ? state.panX : (refW / 2);
        panStartPanY = state.panY != null ? state.panY : (refH / 2);
        solarCanvas.style.cursor = "grabbing";
        _attachDocDragListeners();
        return;
      }
      // Handle text dragging (takes priority over crop)
      if (state.textMode && state.textOverlay) {
        var coords = getCanvasCoords(e);
        if (isInsideText(coords.x, coords.y)) {
          e.preventDefault();
          textDragging = true;
          // Drag relative to the resolved pixel coords (which
          // isInsideText just refreshed) so a drag after a canvas
          // resize starts from where the text actually is on screen,
          // not from a stale absolute x/y.
          var _tov = state.textOverlay;
          textDragOffsetX = coords.x - (_tov._pixelX != null ? _tov._pixelX : _tov.x);
          textDragOffsetY = coords.y - (_tov._pixelY != null ? _tov._pixelY : _tov.y);
          _attachDocDragListeners();
          return;
        }
      }
    }

    function onCanvasPointerMove(e) {
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var clientY = e.touches ? e.touches[0].clientY : e.clientY;
      if (panDragging) {
        e.preventDefault();
        var cur = getCanvasCoords(e);
        var zoom = (state.cropZoom || 100) / 100;
        // getCanvasCoords returns CANVAS-pixel space. When canvas is scaled
        // up (HQ active), divide by state._canvasScale to project the delta
        // back into REF space — that's where state.panX lives.
        var cs = state._canvasScale || 1;
        state.panX = panStartPanX - (cur.x - panStartCanvasX) / (zoom * cs);
        state.panY = panStartPanY - (cur.y - panStartCanvasY) / (zoom * cs);
        applyCanvasView();
        scheduleCanvasRender();
        scheduleMockupRefresh();
        return;
      }
      if (textDragging && state.textOverlay) {
        e.preventDefault();
        var coords = getCanvasCoords(e);
        var newX = coords.x - textDragOffsetX;
        var newY = coords.y - textDragOffsetY;
        state.textOverlay.x = newX;
        state.textOverlay.y = newY;
        // Update normalised position so the drag survives a canvas
        // resize (HQ swap, mockup snapshot, export) — without this the
        // overlay drifted toward the upper-left whenever the canvas
        // dimensions changed after the drag.
        var _cw = solarCanvas.width || 1;
        var _ch = solarCanvas.height || 1;
        state.textOverlay.xNorm = newX / _cw;
        state.textOverlay.yNorm = newY / _ch;
        scheduleCanvasRender();
        return;
      }
    }

    function onCanvasPointerUp() {
      if (panDragging) {
        panDragging = false;
        if (isPanToolActive()) solarCanvas.style.cursor = "grab";
        renderCanvas();
        scheduleMockupRefresh();
        return;
      }
      if (textDragging) {
        textDragging = false;
        return;
      }
    }

    // Unified canvas pointer handlers (text drag + crop drag + pan).
    // The pointerdown listeners stay on solarCanvas; the document-level
    // move/up listeners are attached only when a drag actually starts
    // and removed on drag end. The previous always-on `touchmove` with
    // {passive:false} forced the browser to wait on every page scroll
    // even when no drag was in progress — visible mobile sluggishness.
    solarCanvas.addEventListener("mousedown", onCanvasPointerDown);
    solarCanvas.addEventListener("touchstart", onCanvasPointerDown, { passive: false });

    function _attachDocDragListeners() {
      document.addEventListener("mousemove", onCanvasPointerMove);
      document.addEventListener("touchmove", onCanvasPointerMove, { passive: false });
      document.addEventListener("mouseup", _onCanvasDragEnd);
      document.addEventListener("touchend", _onCanvasDragEnd);
      document.addEventListener("touchcancel", _onCanvasDragEnd);
    }
    function _detachDocDragListeners() {
      document.removeEventListener("mousemove", onCanvasPointerMove);
      document.removeEventListener("touchmove", onCanvasPointerMove);
      document.removeEventListener("mouseup", _onCanvasDragEnd);
      document.removeEventListener("touchend", _onCanvasDragEnd);
      document.removeEventListener("touchcancel", _onCanvasDragEnd);
    }
    function _onCanvasDragEnd(e) {
      onCanvasPointerUp(e);
      _detachDocDragListeners();
    }

    // ── Mobile: pan via dragging the preview pane ───────────────
    // F15 hides #imageStage on mobile, so the existing pan
    // listeners on solarCanvas have nothing visible to drag
    // against — pan was effectively dead. Bind a parallel handler
    // to the preview pane: drag → update state.panX/panY in REF
    // space, then renderCanvas() (which redraws the hidden source
    // canvas AND refreshes the live preview at the end).
    // Pan engages either when the Pan tool is active OR — to make
    // the gesture obvious on mobile where the Pan button is two
    // tabs away — whenever no other interactive mode is in play
    // (cropping / text). Resize handle + close-button taps are
    // excluded so they keep working.
    var _mobilePanDragging = false;
    var _mobilePanStartX = 0, _mobilePanStartY = 0;
    var _mobilePanStartPanX = 0, _mobilePanStartPanY = 0;
    var _mobilePanCanvas = null;
    function _mobilePanShouldEngage(targetEl) {
      if (!window.matchMedia || !window.matchMedia("(max-width: 749px)").matches) return false;
      if (state.cropping || state.textMode) return false;
      // Don't hijack drags on the handle, close button, or other interactive children
      if (targetEl && targetEl.closest &&
          (targetEl.closest(".preview-resize-handle") ||
           targetEl.closest(".preview-close-btn") ||
           targetEl.closest("button, a, select, input, [role='slider']"))) {
        return false;
      }
      // Need a visible live-preview canvas (real-mockup mode → no pan)
      var pane = document.getElementById("selectedProductPreview");
      if (!pane) return false;
      var canvas = pane.querySelector("canvas.live-preview-canvas");
      if (!canvas) return false;
      if (canvas.style.display === "none") return false;
      return true;
    }
    function _mobilePanDown(e) {
      if (!_mobilePanShouldEngage(e.target)) return;
      var canvas = document.getElementById("selectedProductPreview")
        .querySelector("canvas.live-preview-canvas");
      if (!canvas) return;
      e.preventDefault();
      _mobilePanDragging = true;
      _mobilePanCanvas = canvas;
      _mobilePanStartX = e.clientX;
      _mobilePanStartY = e.clientY;
      var ref = state.originalImage;
      var refW = ref ? (state.rotation % 180 !== 0 ? ref.naturalHeight : ref.naturalWidth) : 1024;
      var refH = ref ? (state.rotation % 180 !== 0 ? ref.naturalWidth : ref.naturalHeight) : 1024;
      _mobilePanStartPanX = state.panX != null ? state.panX : (refW / 2);
      _mobilePanStartPanY = state.panY != null ? state.panY : (refH / 2);
      canvas.style.cursor = "grabbing";
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_e) {}
    }
    function _mobilePanMove(e) {
      if (!_mobilePanDragging || !_mobilePanCanvas) return;
      e.preventDefault();
      var rect = _mobilePanCanvas.getBoundingClientRect();
      var previewW = rect.width || 1;
      var previewH = rect.height || 1;
      var ref = state.originalImage;
      var refW = ref ? (state.rotation % 180 !== 0 ? ref.naturalHeight : ref.naturalWidth) : 1024;
      var refH = ref ? (state.rotation % 180 !== 0 ? ref.naturalWidth : ref.naturalHeight) : 1024;
      var zoom = (state.cropZoom || 100) / 100;
      // 1 preview-px = (refW / previewW) ref-px, /zoom for finer control when zoomed in.
      var dx = (e.clientX - _mobilePanStartX) * (refW / previewW) / zoom;
      var dy = (e.clientY - _mobilePanStartY) * (refH / previewH) / zoom;
      // Negative because dragging right pulls the image right (window content moves left in REF space).
      state.panX = _mobilePanStartPanX - dx;
      state.panY = _mobilePanStartPanY - dy;
      // renderCanvas() ends with refreshLivePreview() so the visible canvas updates.
      if (typeof renderCanvas === "function") renderCanvas();
    }
    function _mobilePanUp(e) {
      if (!_mobilePanDragging) return;
      _mobilePanDragging = false;
      if (_mobilePanCanvas) _mobilePanCanvas.style.cursor = "";
      _mobilePanCanvas = null;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_e) {}
    }
    // Attach to the preview pane (delegated; survives canvas re-creation
    // in selectProduct since the pane itself isn't replaced).
    (function _attachMobilePanListeners() {
      var pane = document.getElementById("selectedProductPreview");
      if (!pane) return;
      pane.addEventListener("pointerdown", _mobilePanDown);
      pane.addEventListener("pointermove", _mobilePanMove);
      pane.addEventListener("pointerup", _mobilePanUp);
      pane.addEventListener("pointercancel", _mobilePanUp);
      pane.addEventListener("pointerleave", _mobilePanUp);
    })();

    // ── Crop mode ────────────────────────────────────────────────
    var cropDragging = false;

    // syncCropRatioUI is kept as a no-op for compatibility with several call
    // sites that expect to nudge the crop-ratio preset buttons. Those buttons
    // (`.crop-ratio-btn` / `#cropControls` / `#cropProductBtn` / `#cancelCrop`)
    // were removed from index.html when the crop flow collapsed into free-form
    // drag + the product aspect ratio is applied automatically. Leaving the
    // symbol defined avoids adding `if (typeof …)` guards at every call.
    function syncCropRatioUI() {}

    function exitCropMode() {
      state.cropping = false;
      cropOverlay.classList.add("hidden");
      solarCanvas.style.cursor = isPanToolActive() ? "grab" : "default";
      cropDragging = false;
    }

    function getCanvasCoords(e) {
      var rect = solarCanvas.getBoundingClientRect();
      var scaleX = solarCanvas.width / rect.width;
      var scaleY = solarCanvas.height / rect.height;
      var clientX, clientY;
      if (e.touches) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else {
        clientX = e.clientX;
        clientY = e.clientY;
      }
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
      };
    }

    function startCropDrag(e) {
      if (!state.cropping) return;
      e.preventDefault();
      cropDragging = true;
      state.cropStart = getCanvasCoords(e);
      state.cropEnd = state.cropStart;
    }

    function moveCropDrag(e) {
      if (!cropDragging) return;
      e.preventDefault();
      var coords = getCanvasCoords(e);
      state.cropEnd = coords;
      drawCropOverlay();
    }

    function endCropDrag() {
      cropDragging = false;
    }

    function drawCropOverlay() {
      if (!state.cropStart || !state.cropEnd) return;
      var rect = solarCanvas.getBoundingClientRect();
      var scaleX = rect.width / solarCanvas.width;
      var scaleY = rect.height / solarCanvas.height;
      var stageRect = imageStage.getBoundingClientRect();
      var canvasRect = solarCanvas.getBoundingClientRect();
      var offsetX = canvasRect.left - stageRect.left;
      var offsetY = canvasRect.top - stageRect.top;

      var x1 = Math.min(state.cropStart.x, state.cropEnd.x);
      var y1 = Math.min(state.cropStart.y, state.cropEnd.y);
      var w = Math.abs(state.cropEnd.x - state.cropStart.x);
      var h = Math.abs(state.cropEnd.y - state.cropStart.y);

      // Enforce ratio
      if (state.cropRatio !== "free") {
        var parts = state.cropRatio.split(":");
        var ratio = parseFloat(parts[0]) / parseFloat(parts[1]);
        h = w / ratio;
      }

      cropOverlay.classList.remove("hidden");
      cropOverlay.style.left = (offsetX + x1 * scaleX) + "px";
      cropOverlay.style.top = (offsetY + y1 * scaleY) + "px";
      cropOverlay.style.width = (w * scaleX) + "px";
      cropOverlay.style.height = (h * scaleY) + "px";
      // Circular overlay for round products — wall_clock and any user-
      // requested product tagged with printShape === "circle".
      var _selProd = state.selectedProduct ? PRODUCTS.find(function(p) { return p.id === state.selectedProduct; }) : null;
      if (state.selectedProduct === "wall_clock" || (_selProd && _selProd.printShape === "circle")) {
        cropOverlay.classList.add("circular");
      } else {
        cropOverlay.classList.remove("circular");
      }
    }

    if ($("#applyCrop")) $("#applyCrop").addEventListener("click", function() {
      exitCropMode();
    });

    /**
     * Crop a filter image using the same transforms and reference size as the main canvas.
     * Renders the source image scaled to cover the reference size (so JPG/Raw/RHEF align),
     * applies rotation/flip/pixel adjustments, and extracts the same crop region.
     */
    function _cropFilterImage(sourceImg, cropRect, callback) {
      var ref = state.originalImage;
      if (!ref) return callback(sourceImg);
      var refW = ref.naturalWidth;
      var refH = ref.naturalHeight;
      var rotated = (state.rotation % 180 !== 0);
      var cw = rotated ? refH : refW;
      var ch = rotated ? refW : refH;

      var sw = sourceImg.naturalWidth;
      var sh = sourceImg.naturalHeight;
      var scale = Math.max(cw / sw, ch / sh);
      var drawW = sw * scale;
      var drawH = sh * scale;

      var tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = cw;
      tmpCanvas.height = ch;
      var tctx = tmpCanvas.getContext("2d");

      tctx.save();
      tctx.translate(cw / 2, ch / 2);
      tctx.rotate((state.rotation * Math.PI) / 180);
      tctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
      tctx.drawImage(sourceImg, -drawW / 2, -drawH / 2, drawW, drawH);
      tctx.restore();

      // Apply pixel adjustments (brightness, contrast, saturation, vignette, invert)
      var needsPixelWork = state.brightness !== 0 || state.contrast !== 0 ||
                           state.saturation !== 100 || state.inverted || state.vignette > 0 ||
                           (state.cropEdgeFeatherX || 0) > 0 || (state.cropEdgeFeatherY || 0) > 0 ||
                           (state.hue || 0) !== 0;
      if (needsPixelWork) {
        var imageData = tctx.getImageData(0, 0, cw, ch);
        var d = imageData.data;
        var br = state.brightness;
        var co = state.contrast / 100;
        var factor = (259 * (co * 255 + 255)) / (255 * (259 - co * 255));
        var sat = state.saturation / 100;
        var applyVignette = state.vignette > 0;
        var cx = cw / 2, cy = ch / 2;
        var maxR = Math.sqrt(cx * cx + cy * cy);
        var radiusFactor = 1.0 - (state.vignette / 100) * 0.9;
        var vigR = maxR * radiusFactor;
        var vigWidthFactor = state.vignetteWidth / 100;
        // Hue rotation — mirrors the main renderCanvas pixel pass so
        // _cropFilterImage produces the same colour treatment when it
        // re-bakes the JPG/Raw/RHEF/HQ-RHEF source onto the canvas.
        var hueDeg2 = state.hue || 0;
        var applyHue2 = (hueDeg2 % 360) !== 0;
        var hueCos2 = applyHue2 ? Math.cos(hueDeg2 * Math.PI / 180) : 1;
        var hueSin2 = applyHue2 ? Math.sin(hueDeg2 * Math.PI / 180) : 0;
        var hrr2 = 0.213 + 0.787 * hueCos2 - 0.213 * hueSin2;
        var hrg2 = 0.715 - 0.715 * hueCos2 - 0.715 * hueSin2;
        var hrb2 = 0.072 - 0.072 * hueCos2 + 0.928 * hueSin2;
        var hgr2 = 0.213 - 0.213 * hueCos2 + 0.143 * hueSin2;
        var hgg2 = 0.715 + 0.285 * hueCos2 + 0.140 * hueSin2;
        var hgb2 = 0.072 - 0.072 * hueCos2 - 0.283 * hueSin2;
        var hbr2 = 0.213 - 0.213 * hueCos2 - 0.787 * hueSin2;
        var hbg2 = 0.715 - 0.715 * hueCos2 + 0.715 * hueSin2;
        var hbb2 = 0.072 + 0.928 * hueCos2 + 0.072 * hueSin2;

        for (var i = 0; i < d.length; i += 4) {
          var r = d[i], g = d[i + 1], b = d[i + 2];
          if (state.inverted) { r = 255 - r; g = 255 - g; b = 255 - b; }
          r += br; g += br; b += br;
          r = factor * (r - 128) + 128;
          g = factor * (g - 128) + 128;
          b = factor * (b - 128) + 128;
          var gray = 0.2989 * r + 0.587 * g + 0.114 * b;
          r = gray + sat * (r - gray);
          g = gray + sat * (g - gray);
          b = gray + sat * (b - gray);
          if (applyHue2) {
            var hr2 = hrr2 * r + hrg2 * g + hrb2 * b;
            var hg2 = hgr2 * r + hgg2 * g + hgb2 * b;
            var hb2 = hbr2 * r + hbg2 * g + hbb2 * b;
            r = hr2; g = hg2; b = hb2;
          }
          if (applyVignette) {
            var px = (i / 4) % cw;
            var py = Math.floor((i / 4) / cw);
            var dx = px - cx, dy = py - cy;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > vigR) {
              var maxFade = maxR - vigR;
              var fadeLen = maxFade * vigWidthFactor;
              var t = fadeLen > 0.5 ? Math.min((dist - vigR) / fadeLen, 1.0) : 1.0;
              t = t * t * (3 - 2 * t);
              var fade = state.vignetteFade || "transparent";
              if (fade === "transparent") {
                d[i + 3] = d[i + 3] * (1 - t);
              } else if (fade === "black") {
                r = r * (1 - t);
                g = g * (1 - t);
                b = b * (1 - t);
              } else if (fade === "white") {
                r = r * (1 - t) + 255 * t;
                g = g * (1 - t) + 255 * t;
                b = b * (1 - t) + 255 * t;
              } else if (fade === "custom") {
                var hex = (state.vignetteFadeColor || "#000000").replace(/^#/, "");
                var fr = parseInt(hex.substr(0, 2), 16);
                var fg = parseInt(hex.substr(2, 2), 16);
                var fb = parseInt(hex.substr(4, 2), 16);
                r = r * (1 - t) + fr * t;
                g = g * (1 - t) + fg * t;
                b = b * (1 - t) + fb * t;
              } else if (fade === "mode") {
                var modeR = state._vignetteModeR !== undefined ? state._vignetteModeR : 0;
                var modeG = state._vignetteModeG !== undefined ? state._vignetteModeG : 0;
                var modeB = state._vignetteModeB !== undefined ? state._vignetteModeB : 0;
                r = r * (1 - t) + modeR * t;
                g = g * (1 - t) + modeG * t;
                b = b * (1 - t) + modeB * t;
              }
            }
          }
          d[i] = Math.max(0, Math.min(255, r));
          d[i + 1] = Math.max(0, Math.min(255, g));
          d[i + 2] = Math.max(0, Math.min(255, b));
        }
        tctx.putImageData(imageData, 0, 0);
      }

      // Extract crop region
      var croppedData = tctx.getImageData(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      var cropCanvas = document.createElement("canvas");
      cropCanvas.width = cropRect.w;
      cropCanvas.height = cropRect.h;
      cropCanvas.getContext("2d").putImageData(croppedData, 0, 0);

      var croppedImg = new Image();
      croppedImg.onload = function() { callback(croppedImg); };
      croppedImg.src = cropCanvas.toDataURL("image/png");
    }

    // ── HQ cache (used by startHqFilterGeneration and the checkout flow) ─
    var hqCache = {}; // key: "date_wavelength" => { url, imageObj }

    // ── Products ─────────────────────────────────────────────────
    // ── Product mockup drawing ──────────────────────────────────




    // _fitPrintRectToAR moved to ./mockups.js with step 4 — it's used
    // only by drawProductMockup's per-product branches (canvas/metal/
    // acrylic/etc.) to size the printable rectangle to the editor's
    // effective aspect ratio.

    /**
     * Compute a center-crop source rect so the solar canvas fills a destination
     * area with the correct aspect ratio (no stretching, no letterboxing).
     * Returns { sx, sy, sw, sh } to pass as the source slice of drawImage().
     */
    function _cropSrcForDst(srcW, srcH, dstW, dstH) {
      var srcAR = srcW / srcH;
      var dstAR = dstW / dstH;
      var sx, sy, sw, sh;
      if (srcAR > dstAR) {
        // source is wider — crop sides
        sh = srcH;
        sw = srcH * dstAR;
        sx = (srcW - sw) / 2;
        sy = 0;
      } else {
        // source is taller — crop top/bottom
        sw = srcW;
        sh = srcW / dstAR;
        sx = 0;
        sy = (srcH - sh) / 2;
      }
      return { sx: sx, sy: sy, sw: sw, sh: sh };
    }


    // ── Variant aspect-ratio helpers ─────────────────────────────

    // Iterative Euclidean GCD — used to reduce placeholder pixel dimensions to a simple ratio
    function gcd(a, b) {
      a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
      while (b) { var t = b; b = a % b; a = t; }
      return a || 1;
    }

    /**
     * Extract a { w, h } aspect ratio from a Printify variant object.
     * Priority: parse "WxH" from title/size option  →  placeholders[front].width/height.
     * Title text is tried first because Printify's placeholder pixel counts are non-round
     * (e.g. 10950×3750 → 73:25) while the human-readable title gives the clean intended
     * ratio (e.g. "36 x 12" → 3:1).
     * Returns null when no ratio can be determined.
     * All returned ratios are GCD-reduced (e.g. 2000×2000 → 1:1, 11000×14000 → 11:14).
     */
    function parseVariantAspectRatio(variant) {
      if (!variant) return null;

      // 1. Parse "WxH" / "W x H" from title or the first option value (clean human ratios).
      // Some Printify variants use unicode prime / smart-quote characters in the title
      // (e.g. `10″ x 8″` for variant 82060) — strip those before the regex so the
      // dimensions can be matched. Without this we fall through to the pixel-placeholder
      // path, which gives ugly ratios like 21:17 for what's really a 10:8 → 5:4 print.
      var opts = variant.options || {};
      var txt = variant.title || opts.size || (Object.keys(opts).length ? opts[Object.keys(opts)[0]] : "") || "";
      txt = String(txt)
        .replace(/[″"\u201C\u201D]/g, "")  // double quotes (straight + prime + curly)
        .replace(/[\u2032'\u2018\u2019]/g, "")  // single quotes (straight + prime + curly)
        .replace(/\bin\b/gi, "")
        .trim();
      var m = txt.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/i);
      if (m) {
        var ww = parseFloat(m[1]);
        var hh = parseFloat(m[2]);
        if (ww > 0 && hh > 0) {
          // Scale decimals up to integers before GCD (e.g. 8.5×11 → 850×1100 → 17:22)
          var scale = (ww % 1 || hh % 1) ? 100 : 1;
          var wi = Math.round(ww * scale);
          var hi = Math.round(hh * scale);
          var g2 = gcd(wi, hi);
          return { w: wi / g2, h: hi / g2 };
        }
      }

      // 2. Fall back to print-area placeholder pixel dimensions
      var phs = variant.placeholders || [];
      for (var i = 0; i < phs.length; i++) {
        var ph = phs[i];
        if (ph && (ph.position === "front" || phs.length === 1)) {
          var pw = ph.width  || ph.w;
          var ph2 = ph.height || ph.h;
          if (pw > 0 && ph2 > 0) {
            var g = gcd(pw, ph2);
            return { w: pw / g, h: ph2 / g };
          }
        }
      }

      return null;
    }

    /**
     * Return the effective aspect ratio for a product, preferring the variant-specific
     * ratio (populated once variants load) over the product's static default.
     */

    /**
     * Filter a variant list to only the sizes/colors specified in product.variantFilter.
     * Matching is case-insensitive and checks both options.size/options.color fields and
     * the variant title string, so it works regardless of how a given provider formats data.
     * If the filter yields 0 results (e.g. provider uses different naming), falls back to
     * returning all variants so the panel is never empty.
     */
    function filterVariantsForProduct(product, variants) {
      if (!product || !product.variantFilter || !variants || !variants.length) return variants || [];
      var f = product.variantFilter;
      var result = variants.filter(function(v) {
        var opts = v.options || {};
        // Collect all option values into a single lower-case string for flexible matching
        var optStr = Object.keys(opts).map(function(k) { return String(opts[k]); }).join(" ").toLowerCase();
        var titleStr = (v.title || "").toLowerCase();
        var combined = optStr + " " + titleStr;

        // Size check: must match one of the allowed sizes
        var sizeOk = !f.sizes || f.sizes.length === 0;
        if (!sizeOk) {
          sizeOk = f.sizes.some(function(s) {
            var sl = s.toLowerCase();
            // Use word-boundary-style check: the size must appear as a whole token
            // e.g. "xl" should match "xl" but not "2xl" or "xxl"
            return new RegExp("(?:^|[^a-z0-9])" + sl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:$|[^a-z0-9])", "i").test(combined);
          });
        }

        // Color check: must match one of the allowed colors
        var colorOk = !f.colors || f.colors.length === 0;
        if (!colorOk) {
          colorOk = f.colors.some(function(c) {
            return combined.indexOf(c.toLowerCase()) !== -1;
          });
        }

        return sizeOk && colorOk;
      });

      // Safety fallback: never return an empty list
      return result.length > 0 ? result : variants;
    }

    // ── Variant info panel ───────────────────────────────────────
    var variantCache = {};        // keyed by "blueprintId_printProviderId" → variant array
    var variantFetchInFlight = {}; // deduplication: same key → shared in-flight Promise
    var variantPricingCache = {}; // keyed by "blueprintId_printProviderId" → { variantId: { cost, price } }
    var variantPricingFetchInFlight = {};

    /**
     * Fetch real per-variant cost data from the backend, which scans the
     * shop's existing Printify products to build a {variant_id: {cost, price}}
     * map (the catalog API doesn't expose costs). First call for a given
     * blueprint+provider is slow (~30-60s on a cold backend cache), but the
     * backend caches for 30 minutes and the frontend caches for the session.
     * Resolves to {} on failure so callers can degrade gracefully.
     */
    function loadVariantPricing(product) {
      var key = product.blueprintId + "_" + product.printProviderId;
      if (variantPricingCache[key]) return Promise.resolve(variantPricingCache[key]);
      if (variantPricingFetchInFlight[key]) return variantPricingFetchInFlight[key];
      var p = fetchWithTimeout(
        API_BASE + "/api/printify/blueprints/" + product.blueprintId + "/providers/" + product.printProviderId + "/pricing",
        {}, 90000
      )
        .then(function(r) { return r.ok ? r.json() : { variants: {} }; })
        .then(function(data) {
          variantPricingCache[key] = data && data.variants ? data.variants : {};
          delete variantPricingFetchInFlight[key];
          return variantPricingCache[key];
        })
        .catch(function() {
          variantPricingCache[key] = {};
          delete variantPricingFetchInFlight[key];
          return {};
        });
      variantPricingFetchInFlight[key] = p;
      return p;
    }

    function formatCents(cents) {
      if (cents == null) return null;
      return "$" + (cents / 100).toFixed(2);
    }

    /**
     * Reduce an aspect-ratio fraction with a "no awkward big primes" rule:
     * when either side is greater than 20 and odd, subtract 1 from it (making
     * it even), then GCD-reduce. Iterates until stable. The 20-cutoff lets
     * legitimate ratios like 11:16 stay readable instead of collapsing to
     * something less faithful.
     *   41:61 → 40:60 → 2:3
     *   22:33 → 22:32 → 11:16 (stops here under the new rule)
     *   23:7  → 22:7
     *   11:16 → 11:16 (unchanged — both ≤ 20)
     *   3319:3761 → 6:7
     */
    function simplifyAspectRatio(w, h) {
      w = Math.round(Math.max(0, w || 0));
      h = Math.round(Math.max(0, h || 0));
      if (!w || !h) return { w: w, h: h };
      for (var safety = 0; safety < 16; safety++) {
        var changed = false;
        if (w > 20 && (w % 2) === 1) { w -= 1; changed = true; }
        if (h > 20 && (h % 2) === 1) { h -= 1; changed = true; }
        var g = gcd(w, h);
        if (g > 1) { w = w / g; h = h / g; changed = true; }
        if (!changed) break;
      }
      return { w: w, h: h };
    }

    /**
     * Pull a print-area dimension (width and height in inches at 300 DPI) off
     * a variant's `placeholders` array. Printify's "front" placeholder defines
     * the printable region — dividing pixel dimensions by 300 gives a usable
     * physical size for the user. Returns null when no placeholders exist.
     */
    function getVariantPrintDims(variant) {
      if (!variant || !variant.placeholders || !variant.placeholders.length) return null;
      var ph = variant.placeholders.find(function(x) { return x && x.position === "front"; })
            || variant.placeholders[0];
      if (!ph || !ph.width || !ph.height) return null;
      // 300 DPI is Printify's standard print resolution.
      return {
        widthIn:  ph.width  / 300,
        heightIn: ph.height / 300,
      };
    }

    /**
     * Shared variant loader — returns a Promise<variants[]>.
     * If variants are already cached, resolves immediately.
     * If a fetch is already in progress for the same key, returns the same Promise (no double-fetch).
     * Also initialises selectedVariantByProduct / variantAspectRatioByProduct from the
     * product's default variantId on first load.
     */
    function loadVariants(product) {
      var key = product.blueprintId + "_" + product.printProviderId;
      if (variantCache[key]) return Promise.resolve(variantCache[key]);
      if (variantFetchInFlight[key]) return variantFetchInFlight[key];
      var p = fetchWithTimeout(
        API_BASE + "/api/printify/blueprints/" + product.blueprintId + "/providers/" + product.printProviderId + "/variants",
        {}, 30000
      )
        .then(function(r) {
          if (!r.ok) throw new Error("status " + r.status);
          return r.json();
        })
        .then(function(data) {
          var variants = data.variants || data;
          if (!Array.isArray(variants)) variants = [];
          variantCache[key] = variants;
          delete variantFetchInFlight[key];
          // Do not auto-select a variant; user must choose one so "Select this product" stays disabled until then
          return variants;
        })
        .catch(function(e) {
          delete variantFetchInFlight[key];
          throw e;
        });
      variantFetchInFlight[key] = p;
      return p;
    }

    // Toggle the variant pane below a card's Select button. If the pane is
    // currently collapsed, this opens it (and loads variants if we haven't
    // cached them yet). If it's open, this collapses it. Keeps the disclosure
    // button's chevron and aria-expanded in sync.
    function toggleVariantPane(product, card, btn) {
      var panel = card.querySelector(".variant-panel");
      if (!panel) return;
      var isOpen = !panel.classList.contains("hidden");
      if (isOpen) {
        panel.classList.add("hidden");
        _setButtonDisclosureState(btn, false);
        return;
      }
      _setButtonDisclosureState(btn, true);
      showVariantPanel(product, card);
    }

    function _setButtonDisclosureState(btn, open) {
      if (!btn) return;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      var icon = btn.querySelector("i.fas");
      if (icon) {
        icon.classList.remove("fa-chevron-down");
        icon.classList.remove("fa-chevron-up");
        icon.classList.add(open ? "fa-chevron-up" : "fa-chevron-down");
      }
      var labelSpan = btn.querySelector(".product-select-btn-label");
      if (labelSpan) {
        labelSpan.textContent = open ? "Hide variants" : "Pick a variant";
      }
    }

    function showVariantPanel(product, card) {
      // Hide all other variant panels and reset their buttons so only one is
      // open at a time (prevents a wall of expanded tiles).
      document.querySelectorAll(".product-card .variant-panel").forEach(function(vp) {
        if (vp.dataset.productId !== product.id) {
          vp.classList.add("hidden");
          var otherCard = vp.closest(".product-card");
          var otherBtn = otherCard ? otherCard.querySelector(".product-select-btn") : null;
          if (otherBtn) _setButtonDisclosureState(otherBtn, false);
        }
      });

      var panel = card.querySelector(".variant-panel");
      if (!panel) return;

      var cacheKey = product.blueprintId + "_" + product.printProviderId;

      // If already visible and fully rendered, leave it as-is
      if (!panel.classList.contains("hidden") && variantCache[cacheKey]) return;

      if (variantCache[cacheKey]) {
        renderVariantPanel(panel, product, filterVariantsForProduct(product, variantCache[cacheKey]));
        panel.classList.remove("hidden");
        return;
      }

      // Show loading spinner while fetch in progress
      panel.innerHTML = '<div class="variant-loading"><div class="spinner" style="width:16px;height:16px;"></div> Loading sizes &amp; colors…</div>';
      panel.classList.remove("hidden");

      loadVariants(product)
        .then(function(variants) {
          // Re-query DOM in case renderProducts() rebuilt the card while the fetch was in flight.
          // The card could live in either the main grid or the user-requests grid.
          var freshCard = document.querySelector('.product-card[data-product-id="' + product.id + '"]');
          var freshPanel = freshCard ? freshCard.querySelector(".variant-panel") : null;
          if (!freshPanel) return;
          freshPanel.classList.remove("hidden");
          renderVariantPanel(freshPanel, product, filterVariantsForProduct(product, variants));
        })
        .catch(function() {
          var freshCard2 = document.querySelector('.product-card[data-product-id="' + product.id + '"]');
          var freshPanel2 = freshCard2 ? freshCard2.querySelector(".variant-panel") : null;
          if (freshPanel2) freshPanel2.innerHTML = '<div class="variant-loading" style="color:var(--text-dim);">Could not load variants</div>';
        });
    }

    // ── Variant-colour palette helpers ────────────────────────
    // The palette + name→hex resolver + variant-colour extractor live
    // in ./colors.js, imported at the top of this file. Names dropped
    // the leading-underscore convention — the module boundary handles
    // privacy and `hexForColorName` reads better at call sites than
    // `hexForColorName`.

    function variantLabel(v) {
      var opts = v.options || {};
      var parts = [];
      Object.keys(opts).forEach(function(k) {
        var val = opts[k];
        if (val == null || val === "") return;
        var str = String(val).trim();
        // Wall clock variants split base color + hand color into two options.
        // The bare "Black" / "White" on the `hands` key is ambiguous next to
        // a "Black Base" / "White Base" / "Wooden Base" — beta tester asked
        // for "Black hands" / "White hands" so the two columns read clearly.
        if (k === "hands" && /^(black|white|gold|silver|rose\s*gold)$/i.test(str)) {
          str = str + " hands";
        }
        parts.push(str);
      });
      return parts.length ? parts.join(" / ") : "Variant #" + v.id;
    }

    function getVariantPrice(product, variant) {
      if (!product || !product.sizePricing || !variant) return null;
      var byId = product.sizePricing[variant.id];
      if (byId != null) return byId;
      var byLabel = product.sizePricing[variantLabel(variant)];
      if (byLabel != null) return byLabel;
      return null;
    }

    /**
     * Customer-facing retail price for a variant, in display form ("$12.34").
     *
     * Sources, in priority order:
     *   1. Real Printify cost from variantPricingCache, anchored to the
     *      product's advertised checkoutPrice. The cheapest variant in the
     *      blueprint+provider bucket is pinned to checkoutPrice (so the
     *      advertised "From $X.XX" matches what shows up next to the
     *      cheapest tile), and every other variant scales by its cost
     *      differential. This is what makes per-variant prices actually
     *      vary in the UI — beta tester noted every variant in the picker
     *      showed the same number because we used to surface raw wholesale
     *      cost (often identical across colors).
     *   2. Manual product.sizePricing entries (used by stickers).
     *   3. The product-level "From $X.XX" string fallback.
     *
     * Returns null if nothing usable is available — callers render an
     * empty pill rather than a misleading number.
     */
    function priceForVariantDisplay(product, variant) {
      if (!product || !variant) return null;
      var key = product.blueprintId + "_" + product.printProviderId;
      var bucket = variantPricingCache[key];
      if (bucket && bucket[variant.id] && bucket[variant.id].cost != null) {
        var costs = [];
        for (var k in bucket) {
          if (bucket[k] && bucket[k].cost != null) costs.push(bucket[k].cost);
        }
        var minCost = costs.length ? Math.min.apply(null, costs) : bucket[variant.id].cost;
        var anchor = product.checkoutPrice != null ? product.checkoutPrice : 0;
        var markup = Math.max(0, anchor - minCost);
        return formatCents(bucket[variant.id].cost + markup);
      }
      var manual = getVariantPrice(product, variant);
      if (manual) return manual;
      return product.price || null;
    }

    /**
     * Stable sort variants by retail price ascending. The intent is grouping:
     * variants with similar features tend to share a price tier (e.g. all
     * S/M/L/XL t-shirts at $24.99, all 2XL at $27.55), so a price sort keeps
     * those tiers visually adjacent in the picker. Variants whose price we
     * can't resolve sink to the bottom rather than disrupting the order.
     * Original ordering is the secondary key so within a tier we still get
     * the catalog order Printify returned (color groups stay together).
     */
    function sortVariantsByPrice(product, variants) {
      var priceCents = function(v) {
        var key = product.blueprintId + "_" + product.printProviderId;
        var bucket = variantPricingCache[key];
        if (bucket && bucket[v.id] && bucket[v.id].cost != null) {
          var costs = [];
          for (var k in bucket) {
            if (bucket[k] && bucket[k].cost != null) costs.push(bucket[k].cost);
          }
          var minCost = costs.length ? Math.min.apply(null, costs) : bucket[v.id].cost;
          var anchor = product.checkoutPrice != null ? product.checkoutPrice : 0;
          return bucket[v.id].cost + Math.max(0, anchor - minCost);
        }
        return Number.POSITIVE_INFINITY;
      };
      // Capture original index up front so the secondary key is stable.
      var indexed = variants.map(function(v, i) { return { v: v, i: i, p: priceCents(v) }; });
      indexed.sort(function(a, b) {
        if (a.p !== b.p) return a.p - b.p;
        return a.i - b.i;
      });
      return indexed.map(function(x) { return x.v; });
    }

    function getSelectedVariantForProduct(productId) {
      var p = PRODUCTS.find(function(pr) { return pr.id === productId; });
      if (!p || !p.blueprintId || !p.printProviderId) return null;
      var key = p.blueprintId + "_" + p.printProviderId;
      var variants = variantCache[key];
      if (!variants || !variants.length) return null;
      var vid = state.selectedVariantByProduct[productId] != null ? state.selectedVariantByProduct[productId] : p.variantId;
      if (vid == null) vid = variants[0].id;
      return variants.find(function(v) { return v.id === vid; }) || variants[0] || null;
    }

    function updatePreviewVariantSelector(product) {
      // The inline variant dropdown was removed from the preview pane
      // (duplicated the "Change variant" nav button which opens the
      // full modal). The wrap element is kept hidden in the HTML and
      // we early-return here so nothing un-hides it. Preserved as a
      // function so legacy callers (selectProductCard etc.) still
      // resolve the symbol — just a no-op now.
      var wrap = document.getElementById("previewVariantWrap");
      if (wrap && !wrap.classList.contains("hidden")) wrap.classList.add("hidden");
      return;
      // (Old dropdown population path retained below as dead code
      //  for reference but unreachable. Safe to delete later.)
    }
    // eslint-disable-next-line no-unused-vars
    function _legacy_updatePreviewVariantSelector(product) {
      var wrap = document.getElementById("previewVariantWrap");
      var select = document.getElementById("previewVariantSelect");
      var note = document.getElementById("previewVariantClockNote");
      if (!wrap || !select) return;
      if (!product) {
        wrap.classList.add("hidden");
        return;
      }
      var cacheKey = product.blueprintId + "_" + product.printProviderId;

      function fillSelect(variants) {
        select.innerHTML = "";
        variants.forEach(function(v) {
          var opt = document.createElement("option");
          opt.value = v.id;
          var price = priceForVariantDisplay(product, v);
          opt.textContent = variantLabel(v) + (price ? " — " + price : "");
          select.appendChild(opt);
        });
        var currentId = state.selectedVariantByProduct[product.id] != null ? state.selectedVariantByProduct[product.id] : product.variantId;
        if (currentId == null && variants.length) currentId = variants[0].id;
        select.value = currentId != null ? String(currentId) : (variants[0] ? String(variants[0].id) : "");
        wrap.classList.remove("hidden");
        if (note) note.classList.toggle("hidden", product.id !== "wall_clock");
      }

      if (variantCache[cacheKey]) {
        fillSelect(sortVariantsByPrice(product, filterVariantsForProduct(product, variantCache[cacheKey])));
        return;
      }
      select.innerHTML = "<option value=''>Loading…</option>";
      select.value = "";
      wrap.classList.remove("hidden");
      if (note) note.classList.add("hidden");
      // Use shared loadVariants() so this never double-fetches with showVariantPanel
      loadVariants(product)
        .then(function(variants) {
          fillSelect(sortVariantsByPrice(product, filterVariantsForProduct(product, variants)));
          if (state.selectedProduct === product.id) {
            var effectiveAR = getEffectiveAspectRatio(product);
            if (effectiveAR && effectiveAR.w && effectiveAR.h) {
              state.cropRatio = effectiveAR.w + ":" + effectiveAR.h;
              syncCropRatioUI();
            }
            if (typeof renderCanvas === "function") renderCanvas();
          }
        })
        .catch(function() {
          select.innerHTML = "<option value=''>Could not load variants</option>";
        });
    }

    // ── Dual-panel layout toggle helpers ──────────────────────────
    // Show the "Same both sides / Spans across" radio for any product
    // flagged dualPanel: true. The toggle drives state.dualPanelMode-
    // ByProduct, and changing it re-renders the canvas (so the user
    // sees the new aspect immediately) and refreshes the preview.
    function updatePreviewLayoutToggle(product) {
      var wrap = document.getElementById("previewLayoutWrap");
      if (!wrap) return;
      if (!product || !product.dualPanel) {
        wrap.classList.add("hidden");
        return;
      }
      wrap.classList.remove("hidden");
      var mode = state.dualPanelModeByProduct[product.id] || "match";
      var radios = wrap.querySelectorAll('input[name="dualPanelMode"]');
      for (var i = 0; i < radios.length; i++) {
        radios[i].checked = (radios[i].value === mode);
      }
    }

    (function() {
      var wrap = document.getElementById("previewLayoutWrap");
      if (!wrap) return;
      wrap.addEventListener("change", function(e) {
        if (!e.target || e.target.name !== "dualPanelMode") return;
        var pid = state.selectedProduct;
        if (!pid) return;
        var newMode = (e.target.value === "span") ? "span" : "match";
        state.dualPanelModeByProduct[pid] = newMode;
        // Switching aspect → reset crop to 100% so the design re-fits
        // the new shape rather than carrying a stale zoom from the
        // previous mode.
        state.cropZoom = 100;
        var cs = $("#cropSlider"), cv = $("#cropVal");
        if (cs) { cs.value = 100; }
        if (cv) { cv.textContent = "100%"; }
        // Clear any cached single-product mockup so the next "Generate
        // real mockup" reflects the new layout.
        if (state.mockups && state.mockups[pid]) delete state.mockups[pid];
        if (state.mockupsRaw && state.mockupsRaw[pid]) delete state.mockupsRaw[pid];
        if (state.mockupsFiltered && state.mockupsFiltered[pid]) delete state.mockupsFiltered[pid];
        state.uploadedPrintifyId = null;
        state.uploadedPrintifyIdRaw = null;
        state.uploadedPrintifyIdFiltered = null;
        if (typeof renderCanvas === "function") renderCanvas();
        if (typeof refreshLivePreview === "function") refreshLivePreview();
        if (typeof updatePreviewPaneMockupState === "function") updatePreviewPaneMockupState();
        if (typeof scheduleMockupRefresh === "function") scheduleMockupRefresh();
      });
    })();

    (function() {
      var previewVariantSelectEl = document.getElementById("previewVariantSelect");
      if (!previewVariantSelectEl) return;
      previewVariantSelectEl.addEventListener("change", function() {
        var productId = state.selectedProduct;
        if (!productId) return;
        var product = PRODUCTS.find(function(p) { return p.id === productId; });
        if (!product) return;
        var vid = parseInt(previewVariantSelectEl.value, 10);
        if (isNaN(vid)) return;
        state.selectedVariantByProduct[productId] = vid;
        var key = product.blueprintId + "_" + product.printProviderId;
        var variants = variantCache[key];
        var variant = variants && variants.find(function(v) { return v.id === vid; });
        if (variant) {
          var parsed = parseVariantAspectRatio(variant);
          if (parsed) state.variantAspectRatioByProduct[productId] = parsed;
          else delete state.variantAspectRatioByProduct[productId];
        }
        refreshLivePreview();
        // Do NOT call renderProducts() here — it destroys all variant panels
        if (typeof updateSelectedProductPreview === "function") updateSelectedProductPreview(product);
        syncCropRatioUI();
        if (typeof renderCanvas === "function") renderCanvas();
        // Also refresh the in-card variant panel so its confirmed highlight matches
        var selCard = productGrid && productGrid.querySelector('.product-card[data-product-id="' + productId + '"]');
        if (selCard) {
          var inCardPanel = selCard.querySelector(".variant-panel");
          var cacheKey2 = product.blueprintId + "_" + product.printProviderId;
          if (inCardPanel && variantCache[cacheKey2]) {
            renderVariantPanel(inCardPanel, product, filterVariantsForProduct(product, variantCache[cacheKey2]));
          }
          // Enable "Select this product" on the card now that variant is set from preview dropdown
          var selectBtn = selCard.querySelector(".product-select-btn");
          if (selectBtn && state.selectedVariantByProduct[productId] != null) {
            selectBtn.disabled = false;
            selectBtn.innerHTML = '<i class="fas fa-chevron-down"></i> Select this product';
          }
        }
      });
    })();

    function renderVariantPanel(panel, product, variants) {
      if (!variants.length) {
        panel.innerHTML = '<div class="variant-loading" style="color:var(--text-dim);">No variant info available</div>';
        return;
      }

      // Kick off the pricing fetch (no-op if already cached) and re-render
      // when it lands. Without this, the inline panel only had access to
      // sizePricing — which is set on stickers only — so every other product
      // showed empty price pills until the user opened the modal.
      var pricingKey = product.blueprintId + "_" + product.printProviderId;
      if (!variantPricingCache[pricingKey]) {
        loadVariantPricing(product).then(function() {
          if (panel.isConnected) renderVariantPanel(panel, product, variants);
        });
      }

      // Sort by price so feature groups (size tiers, finish levels) stay
      // adjacent regardless of the order Printify's catalog returns them in.
      variants = sortVariantsByPrice(product, variants);

      var selectedId = state.selectedVariantByProduct[product.id];
      var selectedVariant = selectedId ? variants.find(function(v) { return v.id === selectedId; }) : null;

      var html = '<div class="variant-summary">';
      html += '<span class="variant-count">' + variants.length + ' variant' + (variants.length === 1 ? '' : 's') + '</span>';
      if (selectedVariant) {
        var selPrice = priceForVariantDisplay(product, selectedVariant);
        html += '<div class="variant-selected-msg">Selected: ' + variantLabel(selectedVariant) + (selPrice ? " \u2014 " + selPrice : "") + '</div>';
      }
      // The inline pane is read-only — variants are listed for browsing only,
      // and selection happens through the "Pick a variant" modal so users
      // always go through the same single-step picker. Each row is just
      // label + price, with a "✓ Selected" pill on the active row.
      html += '<div class="variant-list variant-list-readonly">';
      variants.forEach(function(v) {
        var isConfirmed = (selectedId === v.id);
        var rowClass = "variant-row" + (isConfirmed ? " confirmed" : "");
        var label = variantLabel(v);
        var price = priceForVariantDisplay(product, v);
        // Tooltip (title attr) shows the full, un-truncated "Color / Size"
        // label plus the price. The visible label is often truncated with
        // ellipsis on narrow columns (beta reported variants like "Athletic
        // Heather / XL Long T" getting cut) — the hover text is the escape
        // hatch for confirming exactly which variant this is.
        var tooltipText = label + (price ? " — " + price : "");
        var tooltipAttr = ' title="' + escapeHtmlSimple(tooltipText) + '"';
        html +=
          '<div class="' + rowClass + '" data-variant-id="' + v.id + '"' + tooltipAttr + '>' +
            '<span class="variant-row-label"' + tooltipAttr + '>' + label + '</span>' +
            (price ? '<span class="variant-price">' + price + '</span>' : '<span class="variant-price variant-price-empty"></span>') +
            (isConfirmed ? '<span class="variant-row-badge"><i class="fas fa-check"></i> Selected</span>' : '') +
          '</div>';
      });
      html += '</div>';
      if (product.id === "wall_clock") {
        html += '<p class="variant-clock-note">Some options differ by hand color (white vs black).</p>';
      }
      html += '<p class="variant-pick-hint">Tap <strong>Pick a variant</strong> above to change.</p>';
      html += '</div>';
      panel.innerHTML = html;

      // Drop any prior click/keydown delegates — the read-only pane has no
      // interactive controls, and we don't want stale listeners firing on
      // accidental clicks once renderProducts() rebuilds the DOM.
      if (panel._variantClickDelegate) {
        panel.removeEventListener("click", panel._variantClickDelegate);
        panel._variantClickDelegate = null;
      }
      if (panel._variantKeyDelegate) {
        panel.removeEventListener("keydown", panel._variantKeyDelegate);
        panel._variantKeyDelegate = null;
      }
    }

    // ── Product popularity stats ────────────────────────────────────
    // The counter machinery moved to ./stats.js. Wire its runtime deps
    // now and fire the bootstrap fetch — initStats() calls
    // loadProductStats internally. Notes on the deps:
    // - API_BASE: assigned at the top of this file via an IIFE, so
    //   it's a real value here.
    // - BETA_MODE: var-hoisted, assigned `false` ~1700 lines below.
    //   Snapshotting `undefined` here is equivalent — stats.js uses
    //   the value in a falsy check, and BETA_MODE never reassigns
    //   to anything truthy at runtime in this build.
    // - showToast / renderProducts: function declarations (hoisted),
    //   so the names resolve to live function references right now.
    initStats({
      API_BASE: API_BASE,
      BETA_MODE: BETA_MODE,
      showToast: showToast,
      renderProducts: renderProducts,
    });

    function renderProducts() {
      productGrid.innerHTML = "";
      // The user-requested grid lives below the main grid, hidden unless the
      // session has at least one requested product. Requested products render
      // with the same machinery but route to a different container so they're
      // visually grouped and labeled as "Requested".
      var userRequestsGrid = document.getElementById("userRequestsGrid");
      var userRequestsSection = document.getElementById("userRequestsSection");
      if (userRequestsGrid) userRequestsGrid.innerHTML = "";
      var hasUserRequested = false;
      // Iterate in popularity order (buys, then non-converting clicks) so
      // the grid surfaces the most-wanted products first. Per-product
      // routing to the user-requested grid below is unchanged.
      productsByPopularity().forEach(function(p) {
        // Hidden siblings (e.g. the black mug, reached via the merged
        // mug card's colour chooser) never render as their own card.
        if (p._hiddenFromGrid) return;
        var card = document.createElement("div");
        var hasMockup = state.mockups[p.id] && state.mockups[p.id].images && state.mockups[p.id].images.length > 0;
        var statusDot = hasMockup
          ? '<span style="color:#3ddc84;font-size:10px;" title="Printify mockup ready">●</span> '
          : (state.originalImage ? '<span style="color:#ff9800;font-size:10px;" title="Generating…">◌</span> ' : '');

        // The button is now a disclosure toggle: clicking it expands the
        // variant pane below. Each variant inside the pane carries its own
        // Select button — that's where the real commit happens. So this
        // button is always enabled once we have an image + blueprint, with
        // no "choose a variant first" gate.
        var canSelect = !!state.originalImage && p.blueprintId && p.printProviderId;
        var selectLabel = !state.originalImage
          ? '<i class="fas fa-lock"></i> Select wavelength first'
          : (!p.blueprintId ? '<i class="fas fa-spinner fa-spin"></i> Resolving\u2026'
              : '<i class="fas fa-arrow-right"></i> <span class="product-select-btn-label">Pick a variant</span>');

        card.className = "product-card";
        card.dataset.productId = p.id;
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("aria-label", p.name + " - " + p.desc + ". " + p.price + (canSelect ? " Select to edit" : ""));
        // Card layout: preview → info text → action button → collapsible variant pane.
        // The variant pane lives BELOW the button so clicking the button reads as
        // "expand this to see variants." Each variant row carries its own
        // Select button so the pane is the real point of decision; the outer
        // button is a disclosure toggle, not a commit.
        card.innerHTML =
          '<div class="product-preview"><span class="product-icon"><i class="fas ' + p.icon + '"></i></span></div>' +
          '<div class="product-info">' +
            '<div class="product-name">' + statusDot + p.name + "</div>" +
            '<div class="product-desc">' + p.desc + "</div>" +
            '<div class="product-price">' + p.price + "</div>" +
            '<button class="product-buy-btn product-select-btn" data-product-id="' + p.id + '" aria-expanded="false"' +
              (canSelect ? '' : ' disabled') + '>' + selectLabel + '</button>' +
            '<div class="variant-panel hidden" data-product-id="' + p.id + '"></div>' +
          "</div>";

        // Persist the product-type icon as a tiny upper-left badge after the
        // mockup loads — beta testers asked for an at-a-glance indicator so
        // they can scan the grid by product type without reading names. The
        // same fa-icon that shows pre-load stays visible as a corner glyph.
        function _addIconBadge(parentEl, iconClass) {
          var badge = document.createElement("span");
          badge.className = "product-icon-badge";
          badge.innerHTML = '<i class="fas ' + iconClass + '"></i>';
          badge.setAttribute("aria-hidden", "true");
          parentEl.appendChild(badge);
        }

        // Show real Printify mockup if available, else draw canvas mockup
        if (hasMockup) {
          var mockImages = state.mockups[p.id].images;
          var cardSlideIdx = state.mockupSlideIndex[p.id] || 0;
          if (cardSlideIdx >= mockImages.length) cardSlideIdx = 0;
          var curMockImg = mockImages[cardSlideIdx];

          var previewEl = card.querySelector(".product-preview");
          previewEl.innerHTML = "";

          var img = document.createElement("img");
          img.className = "mockup-img";
          img.src = curMockImg.src;
          img.alt = p.name + " mockup";
          img.loading = "lazy";
          previewEl.appendChild(img);

          if (mockImages.length > 1) {
            var ctrBadge = document.createElement("div");
            ctrBadge.className = "card-slide-counter";
            ctrBadge.textContent = (cardSlideIdx + 1) + "/" + mockImages.length;
            previewEl.appendChild(ctrBadge);

            // Translucent "loading next mockup" overlay — Printify's CDN can
            // take a couple seconds to serve a fresh mockup, so without this
            // the UI shows the stale image during the fetch, making the nav
            // feel broken. Shown on nav-click, hidden on img load/error.
            var slideLoader = document.createElement("div");
            slideLoader.className = "card-slide-loader hidden";
            slideLoader.innerHTML = '<span class="card-slide-spinner"></span>';
            previewEl.appendChild(slideLoader);

            (function(pid, imgs, imgEl, badge, loader) {
              function showLoader() { loader.classList.remove("hidden"); }
              function hideLoader() { loader.classList.add("hidden"); }
              imgEl.addEventListener("load", hideLoader);
              imgEl.addEventListener("error", hideLoader);

              function go(delta) {
                var idx = (state.mockupSlideIndex[pid] || 0) + delta;
                if (idx < 0) idx = imgs.length - 1;
                if (idx >= imgs.length) idx = 0;
                state.mockupSlideIndex[pid] = idx;
                badge.textContent = (idx + 1) + "/" + imgs.length;
                // If the target image is already decoded in cache, the load
                // event may fire synchronously — show the loader first, then
                // set src, so hideLoader's handler can reliably clear it.
                showLoader();
                imgEl.src = imgs[idx].src;
                // Safety net: if the browser's cache already has the image
                // complete=true, the load event may have already fired before
                // we attached — check and hide immediately.
                if (imgEl.complete && imgEl.naturalWidth > 0) hideLoader();
              }

              var prevBtn = document.createElement("button");
              prevBtn.className = "card-slide-nav card-slide-prev";
              prevBtn.innerHTML = "&#8249;";
              prevBtn.setAttribute("aria-label", "Previous mockup");
              prevBtn.setAttribute("type", "button");
              prevBtn.addEventListener("click", function(e) { e.stopPropagation(); go(-1); });

              var nextBtn = document.createElement("button");
              nextBtn.className = "card-slide-nav card-slide-next";
              nextBtn.innerHTML = "&#8250;";
              nextBtn.setAttribute("aria-label", "Next mockup");
              nextBtn.setAttribute("type", "button");
              nextBtn.addEventListener("click", function(e) { e.stopPropagation(); go(+1); });

              previewEl.appendChild(prevBtn);
              previewEl.appendChild(nextBtn);
            })(p.id, mockImages, img, ctrBadge, slideLoader);
          }
          _addIconBadge(previewEl, p.icon);
        } else if (
          state.isDefaultActive
          && defaultMockupManifest
          && defaultMockupManifest[p.id]
          && defaultMockupManifest[p.id].url
        ) {
          // Default-image, real Printify mockup cached on disk (Phase B):
          // photorealistic actual-product photo for the landing showcase.
          // Falls back to the canvas branch below the moment the user
          // personalizes (state.isDefaultActive flips false).
          var realImg = new Image();
          realImg.alt = p.name + " mockup";
          realImg.loading = "lazy";
          realImg.style.width = "100%";
          realImg.style.height = "100%";
          realImg.style.objectFit = "contain";
          realImg.src = defaultMockupManifest[p.id].url;
          var realPreviewEl = card.querySelector(".product-preview");
          realPreviewEl.innerHTML = "";
          realPreviewEl.appendChild(realImg);
          _addIconBadge(realPreviewEl, p.icon);
        } else if (state.originalImage && solarCanvas.width > 0) {
          var miniCanvas = document.createElement("canvas");
          miniCanvas.width = 160;
          miniCanvas.height = 160;
          var mctx = miniCanvas.getContext("2d");
          var variant = getSelectedVariantForProduct(p.id);
          drawProductMockup(mctx, p.id, solarCanvas.width, solarCanvas.height, variant);
          var canvasPreviewEl = card.querySelector(".product-preview");
          canvasPreviewEl.innerHTML = "";
          canvasPreviewEl.appendChild(miniCanvas);
          _addIconBadge(canvasPreviewEl, p.icon);
        }

        // Faint popularity badge, bottom-right of the preview (caddy-
        // corner from the type icon). Appended last so it survives the
        // innerHTML rebuilds the mockup/canvas paths do above.
        addStatsBadge(card.querySelector(".product-preview"), p);

        // Highlight selected product
        if (state.selectedProduct === p.id) card.classList.add("selected");

        // Route user-requested products to the "Your Requests" grid so they
        // visually group as session-only submissions. Everything else goes to
        // the main grid.
        if (p._isUserRequested) {
          card.classList.add("product-card-requested");
          if (userRequestsGrid) userRequestsGrid.appendChild(card);
          hasUserRequested = true;
        } else {
          productGrid.appendChild(card);
        }
      });

      // Show/hide the Your Requests section based on whether the session has
      // any requested products pending.
      if (userRequestsSection) {
        userRequestsSection.classList.toggle("hidden", !hasUserRequested);
      }

      // Bind the disclosure button: clicking it toggles the variant pane
      // below. The commit-to-editor flow has moved to the per-variant Select
      // button inside the pane (see renderVariantPanel). Also lazily loads
      // the variants from Printify the first time the pane is opened.
      var _allButtons = Array.from(productGrid.querySelectorAll(".product-buy-btn"));
      if (userRequestsGrid) {
        _allButtons = _allButtons.concat(Array.from(userRequestsGrid.querySelectorAll(".product-buy-btn")));
      }
      _allButtons.forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          var productId = btn.dataset.productId;
          var product = PRODUCTS.find(function(p) { return p.id === productId; });
          if (!product) return;
          if (!state.originalImage || !product.blueprintId || !product.printProviderId) return;
          // Merged product (e.g. mug): the Pick-a-variant button must run
          // the colour chooser too, not just the card-body click — else
          // clicking the button skips straight to the single-variant
          // modal and the White/Black choice never appears.
          if (product.colorOptions && product.colorOptions.length > 1 &&
              typeof showColorChooser === "function") {
            showColorChooser(product);
            return;
          }
          // Primary flow: open the variant picker + confirm modal in one step.
          // The inline collapsible pane (toggleVariantPane / renderVariantPanel)
          // is no longer the entry point for selection — it's still rendered
          // when restored on the editor-engaged card so the user can change
          // variants without going through the modal again, but the click
          // here goes straight to the modal so first-time users finish in one
          // dialog instead of inline-expand → row-Select → confirm.
          showConfirmSelectModal(product, function() {
            commitProductSelection(product);
          });
        });
      });

      // Register all freshly-built cards with the IntersectionObserver so
      // scheduleMockupRefresh() can skip offscreen ones. Initial state assumes
      // all are visible until the observer's first callback runs (avoids a
      // blank first-paint when cards haven't been measured yet).
      if (typeof observeProductCards === "function") observeProductCards();

      // Restore the open variant panel for the selected product if variants are already cached
      // (renderProducts() resets all panels to hidden — re-show so slider adjustments don't close them)
      if (state.selectedProduct) {
        var selProductAfterRender = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
        if (selProductAfterRender && selProductAfterRender.blueprintId && selProductAfterRender.printProviderId) {
          var rpCacheKey = selProductAfterRender.blueprintId + "_" + selProductAfterRender.printProviderId;
          if (variantCache[rpCacheKey]) {
            var rpCard = productGrid.querySelector('.product-card[data-product-id="' + state.selectedProduct + '"]');
            var rpPanel = rpCard ? rpCard.querySelector(".variant-panel") : null;
            if (rpPanel) {
              renderVariantPanel(rpPanel, selProductAfterRender, filterVariantsForProduct(selProductAfterRender, variantCache[rpCacheKey]));
              rpPanel.classList.remove("hidden");
            }
          }
        }
      }
    }

    // ── Shared commit path ───────────────────────────────────────
    // Called from the per-variant Select button in the variant pane (the
    // primary commit path). Primes state for the chosen product, then opens
    // the editor. Also kept general enough for legacy callers.
    function commitProductSelection(product) {
      var productId = product.id;
      // Interest signal: the user committed this product into the editor
      // ("Continue to editor"). Counts toward the "clicks" column.
      recordStatEvent(productId, "click");
      // Selecting a different product means the canvas will render at a new
      // aspect ratio; any previously uploaded Printify image is now stale.
      if (state.selectedProduct !== productId) {
        state.uploadedPrintifyId = null;
        state.uploadedPrintifyIdRaw = null;
        state.uploadedPrintifyIdFiltered = null;
      }
      state.selectedProduct = productId;
      // If the user hasn't manually picked a variant, treat the product's
      // `variantId` field as the active default.
      if (state.selectedVariantByProduct[productId] == null && product.variantId != null) {
        state.selectedVariantByProduct[productId] = product.variantId;
      }
      var effectiveAR = getEffectiveAspectRatio(product);
      if (effectiveAR && effectiveAR.w && effectiveAR.h) {
        state.cropRatio = effectiveAR.w + ":" + effectiveAR.h;
      }
      productGrid.querySelectorAll(".product-card").forEach(function(c) { c.classList.remove("selected"); });
      var userReqGrid = document.getElementById("userRequestsGrid");
      if (userReqGrid) userReqGrid.querySelectorAll(".product-card").forEach(function(c) { c.classList.remove("selected"); });
      var selectedCard = productGrid.querySelector('.product-card[data-product-id="' + productId + '"]')
        || (userReqGrid && userReqGrid.querySelector('.product-card[data-product-id="' + productId + '"]'));
      if (selectedCard) selectedCard.classList.add("selected");
      updateSelectedProductPreview(product);
      editSection.classList.remove("hidden");
      syncCropRatioUI();

      // Push a history entry so the browser back button unwinds to the
      // product picker instead of leaving the page (tester report:
      // "Back button takes me out of shopify, not back in the web app").
      // Skip if we're already on an 'editor' state — re-opens or
      // variant changes shouldn't multiply history entries.
      try {
        if (window.history && window.history.pushState
            && (!window.history.state || window.history.state._sa !== "editor")) {
          window.history.pushState({ _sa: "editor", productId: productId }, "");
        }
      } catch (_e) { /* iframe sandbox or hostile env — silently skip */ }

      // Default the editor to "Fill" crop (100%, edge-to-edge) + "Off"
      // vignette so the print area is covered completely the moment the
      // editor opens. Earlier we used "Full" (fits the whole source inside
      // the frame, may letterbox) but tester feedback was that the empty
      // bars looked like a bug. Users can switch to Fit/Full/Tile any time.
      // Reset also clears vigWidth and crop-edge feather so stale state
      // from an earlier product doesn't leak over.
      // If the user already adjusted cropZoom in the modal (variant pick) we
      // keep that value — _selectInModal also defaults it to 100, so this
      // branch usually no-ops on first engagement.
      if (state.originalImage) {
        if (state.cropZoom == null) state.cropZoom = 100;
        state.vignette = 0;
        state.vignetteWidth = 0;
        state.cropEdgeFeatherX = 0;
        state.cropEdgeFeatherY = 0;
        var cs = $("#cropSlider"),  cv  = $("#cropVal");
        var vs = $("#vignetteSlider"), vv = $("#vignetteVal");
        var vws = $("#vigWidthSlider"), vwv = $("#vigWidthVal");
        var cesx = $("#cropEdgeXSlider"), cevx = $("#cropEdgeXVal");
        var cesy = $("#cropEdgeYSlider"), cevy = $("#cropEdgeYVal");
        if (cs)   { cs.value   = state.cropZoom;    cv.textContent   = state.cropZoom + "%"; }
        if (vs)   { vs.value   = 100 - state.vignette; vv.textContent = state.vignette; }
        if (vws)  { vws.value  = state.vignetteWidth;  vwv.textContent = state.vignetteWidth; }
        if (cesx) { cesx.value = state.cropEdgeFeatherX; cevx.textContent = state.cropEdgeFeatherX; }
        if (cesy) { cesy.value = state.cropEdgeFeatherY; cevy.textContent = state.cropEdgeFeatherY; }
        if (typeof _syncPresetActiveButtons === "function") _syncPresetActiveButtons();
      }

      renderCanvas();
      updateProductSectionHeader();
      if (typeof updateBuyButtonState === "function") updateBuyButtonState();
      // Reveal the clock-customisation tab (and auto-activate it) when the
      // user picks a wall_clock product. Hidden for everything else. Without
      // this, the modal-driven selection path never showed the clock-numbers
      // controls — beta tester noticed they couldn't add 12 numerals around
      // the clock face anymore.
      if (typeof updateClockNumbersButtonVisibility === "function") updateClockNumbersButtonVisibility();
      if (product.id === "wall_clock") {
        var clockTabBtn = document.querySelector('.edit-tab[data-tab="clock"]');
        if (clockTabBtn && !clockTabBtn.classList.contains("active")) clockTabBtn.click();
      }
      _scrollToEl(editSection, "start");
      // Surface the "behind the image" data-credits once per session, the
      // moment the user lands in the editor — every entry path (confirm
      // modal, mug colour chooser, etc.) routes through here. The delay
      // lets the scroll settle + _lastVisibleTop update so showInfo pins
      // the modal into the user's current view (embed) rather than at a
      // stale offset.
      if (typeof maybeShowDataCredits === "function") {
        setTimeout(maybeShowDataCredits, 650);
      }
    }

    // ── Reusable modal focus trap ────────────────────────────────
    // Keyboard-only users need Tab to cycle *within* the open modal
    // and Escape to dismiss it; their focus state should be restored
    // when the modal closes. A QA beta tester flagged that the
    // variant-picker and feedback modals both lacked this — Tab
    // walked through the underlying page chrome behind the modal.
    //
    // Usage:
    //   var release = installModalFocusTrap(modalEl, { onEscape: closeFn });
    //   // ...when closing:
    //   release();
    //
    // The trap:
    //  - finds focusable elements inside `modalEl` (form fields,
    //    buttons, anchors, [tabindex>=0]),
    //  - focuses the first one on the next frame,
    //  - cycles Tab / Shift+Tab,
    //  - calls onEscape on Escape,
    //  - on release() it removes its keydown handler and restores
    //    focus to whatever element was active when the trap installed.
    function _focusableInsideModal(root) {
      if (!root) return [];
      var sel = [
        "a[href]",
        "button:not([disabled])",
        "input:not([disabled]):not([type=hidden])",
        "select:not([disabled])",
        "textarea:not([disabled])",
        "[tabindex]:not([tabindex='-1']):not([disabled])"
      ].join(", ");
      return Array.prototype.filter.call(
        root.querySelectorAll(sel),
        function(el) {
          // Skip elements that are visually hidden — getClientRects()
          // returns an empty list for display:none / visibility:hidden.
          return el.offsetParent !== null || el === document.activeElement;
        }
      );
    }
    function installModalFocusTrap(modalEl, opts) {
      opts = opts || {};
      var previouslyFocused = document.activeElement;
      // Fallback focus host: a modal can open in a transient "loading…"
      // state with zero focusable children (no buttons rendered yet).
      // Without a focusable container, Tab would fall through to the
      // page behind the modal — focus escapes (Tom QA round-2). Give
      // the modal itself tabindex="-1" so it can hold focus and the Tab
      // handler always has somewhere to pin. Remember whether we added
      // the attribute so release() can leave the DOM as it found it.
      var _addedTabindex = false;
      if (!modalEl.hasAttribute("tabindex")) {
        modalEl.setAttribute("tabindex", "-1");
        _addedTabindex = true;
      }
      function onKey(e) {
        if (e.key === "Escape" && typeof opts.onEscape === "function") {
          e.preventDefault();
          opts.onEscape();
          return;
        }
        if (e.key !== "Tab") return;
        var focusables = _focusableInsideModal(modalEl);
        if (!focusables.length) {
          // No focusable children yet — keep focus on the modal
          // container instead of letting Tab escape to the page.
          e.preventDefault();
          if (document.activeElement !== modalEl) modalEl.focus();
          return;
        }
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        // The standard tab-cycle trick: if focus is on the last
        // element and the user Tabs forward, jump to first; on
        // first + Shift+Tab, jump to last. If focus is outside the
        // modal entirely (e.g. clicked off via mouse, then hit Tab),
        // pull it back to first.
        var active = document.activeElement;
        if (!modalEl.contains(active)) {
          e.preventDefault();
          first.focus();
          return;
        }
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
      document.addEventListener("keydown", onKey);
      // Focus the first focusable on the next frame so any layout
      // settling (e.g. animations, async content) doesn't steal it.
      requestAnimationFrame(function() {
        var fs = _focusableInsideModal(modalEl);
        // Skip programmatic focus on touch devices — iOS Safari pops
        // the soft keyboard when an input gets focus, and a tester
        // reported this as disorienting on the feedback modal.
        var isTouch = ('ontouchstart' in window) ||
                      (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
        if (isTouch) return;
        if (fs.length) fs[0].focus();
        // No focusable children yet (transient loading state) — park
        // focus on the modal container so the trap has an anchor and
        // a screen reader announces the dialog rather than the page
        // behind it.
        else modalEl.focus();
      });
      return function release() {
        document.removeEventListener("keydown", onKey);
        if (_addedTabindex) modalEl.removeAttribute("tabindex");
        // Restore focus to the previously-focused element so the
        // page reads naturally to a screen reader after dismissal.
        // Use a try/catch because the original element may have
        // been removed from the DOM in the meantime.
        try {
          if (previouslyFocused && typeof previouslyFocused.focus === "function") {
            previouslyFocused.focus();
          }
        } catch (_e) { /* element gone, skip */ }
      };
    }

    // Buy button in editor: start checkout for the selected product. Gated
    // on having a real Printify mockup generated — the canvas mockup is only
    // an approximation, and beta testers reported being surprised when their
    // Shopify product looked different than the editor preview. Forcing a
    // real mockup before "Create on Shopify" gives the user a true preview
    // to confirm against.
    function _hasRealMockup() {
      var pid = state.selectedProduct;
      if (!pid) return false;
      var entry = state.mockups[pid];
      if (entry && entry.images && entry.images.length > 0) return true;
      // Phase B fallback: when the user is still on the default landing
      // image (AR 2014-10-24, 193 Å) we have a pre-rendered photorealistic
      // Printify mockup cached on disk. That counts as "real" for the
      // gate — the user has already SEEN the actual-product preview in
      // the showcase tile, so making them click "Generate real mockup"
      // a second time is pure friction. The moment they personalize
      // (date/wavelength change → isDefaultActive=false), the gate
      // re-engages and the user has to generate a fresh mockup matching
      // their image. _saveDesignLocally synthesizes a mockup entry from
      // the manifest URL so the download bundle still gets the photo.
      if (state.isDefaultActive
          && defaultMockupManifest
          && defaultMockupManifest[pid]
          && defaultMockupManifest[pid].url) {
        return true;
      }
      return false;
    }

    // ── FITS-quality gating for prints / mockups ─────────────────
    // The JPG tier is a Helioviewer "preview" — fast but low-resolution
    // and routed through Helioviewer's takeScreenshot endpoint, which
    // carries its own attribution obligations. The Raw/RHEF tiers
    // come from VSO FITS via SunPy, and HQ RHEF is the same pipeline
    // at full resolution. We gate physical-product output behind
    // those FITS tiers so a tester (or worse, a buyer) doesn't end
    // up with a 384-pixel print on a 2400-pixel canvas blank.
    //
    // Tier readiness signals already in state:
    //   state.rhefImage         — RHEF MQ FITS ready
    //   state.rawBackendImage   — Raw MQ FITS ready
    //   state.hqReady           — HQ RHEF render finished
    //
    // _printQualityState returns one of: "no_image" | "jpg_only" |
    // "mq_ready" | "hq_ready". The buy / generate-mockup flows
    // branch on this.
    function _printQualityState() {
      if (!state.originalImage) return "no_image";
      if (state.hqReady) return "hq_ready";
      if (state.rhefImage || state.rawBackendImage) return "mq_ready";
      return "jpg_only";
    }

    // Promote the editor's active filter to the highest available
    // tier before a mockup or buy goes through. Without this the
    // canvas (and the PNG uploaded to Printify) reflects whichever
    // tier the user happened to be looking at — which could be
    // JPG even when MQ/HQ FITS is already loaded in memory.
    // Returns true if the filter changed (caller may want to give
    // the renderer a tick to repaint before snapshotting).
    function _promoteFilterToBest() {
      var target = state.editorFilter;
      if (state.hqReady && target !== "hq_rhef") {
        target = "hq_rhef";
      } else if (state.rhefImage && target !== "rhef" && target !== "hq_rhef") {
        target = "rhef";
      } else if (state.rawBackendImage && target === "jpg") {
        target = "raw";
      }
      if (target === state.editorFilter) return false;
      // applyFilterInstant exists earlier in the file and handles the
      // canvas re-render + UI sync; fall back to a direct write +
      // renderCanvas if it's somehow not available.
      if (typeof applyFilterInstant === "function") {
        applyFilterInstant(target);
      } else {
        state.editorFilter = target;
        if (typeof renderCanvas === "function") renderCanvas();
      }
      return true;
    }

    // Soft-block helper: returns true if the user is clear to print
    // and false otherwise (after showing an explanatory modal /
    // toast). When mq_ready but not hq_ready, prompts the user to
    // confirm submitting at MQ resolution rather than waiting for
    // HQ — defaults the affirmative action to "wait" so the safer
    // choice is a single Enter press.
    //
    // confirmFn(true) is called when the user explicitly chooses to
    // proceed with the current tier. confirmFn(false) means "wait" /
    // "cancel" — caller does nothing.
    function _gatePrintQuality(confirmFn) {
      var quality = _printQualityState();
      if (quality === "no_image") {
        showInfo("No Image Yet",
          "Pick a date and a wavelength first — the editor will load once the preview comes through.");
        return;
      }
      if (quality === "jpg_only") {
        showInfo("Waiting for Science Image",
          "The full-resolution FITS image is still downloading from the SDO archive. " +
          "Prints need at least medium-quality (Raw / RHEF) data so they don't pixel-blow on a 12-inch canvas. " +
          "Hang tight — this usually finishes in 30–90 seconds, and the Quality timeline above the canvas shows progress.");
        return;
      }
      if (quality === "mq_ready") {
        showModal(
          "HQ RHEF is still rendering",
          "You're about to submit at <strong>medium quality</strong> — the print will look good but " +
          "the high-resolution RHEF render is still cooking in the background and produces the sharpest large-format prints " +
          "(1&ndash;3 minutes). " +
          "Wait for HQ, or proceed with MQ now?",
          function() {
            // User explicitly chose to proceed at MQ. Promote the
            // editor filter to whichever MQ tier is loaded so the
            // canvas reflects the highest available science data
            // before the upload snapshot is taken.
            _promoteFilterToBest();
            confirmFn(true);
          },
          "Submit at MQ anyway",
          "Submitting…"
        );
        // showModal's default close-on-cancel handles the "wait" path
        // — we just don't fire confirmFn for the cancel button.
        return;
      }
      // hq_ready — promote to HQ if not already there, then pass.
      _promoteFilterToBest();
      confirmFn(true);
    }
    function updateBuyButtonState() {
      if (!btnBuyInEditor) return;
      // Both beta and prod modes now gate on having a real Printify
      // mockup ready first. Reasons differ:
      //   - prod: don't let users publish a product they haven't
      //     previewed (catches bad crops before money changes hands)
      //   - beta: the local zip bundle only carries the real mockups
      //     once they exist, and an empty download is worse than a
      //     disabled button that tells the tester what to do next.
      var ready = !!state.selectedProduct && _hasRealMockup();
      if (BETA_MODE) {
        btnBuyInEditor.disabled = !ready;
        btnBuyInEditor.classList.toggle("buy-locked", !ready);
        if (typeof _applyBetaModeUI === "function") _applyBetaModeUI();
        return;
      }
      btnBuyInEditor.disabled = !ready;
      // The visual state is driven by [disabled] in CSS; we also swap the
      // tooltip and label so the user knows what unlocks the action.
      if (ready) {
        btnBuyInEditor.title = "Create this product on Shopify and complete your purchase.";
        btnBuyInEditor.classList.remove("buy-locked");
      } else {
        btnBuyInEditor.title = "Generate a real mockup first (Reset to mock mockup → Generate real mockup) so you can preview before publishing.";
        btnBuyInEditor.classList.add("buy-locked");
      }
    }
    // Beta-mode: the same button does a local PNG download instead of
    // triggering real Printify checkout. Keeps testers' credit cards
    // (and the operator's Printify wholesale bill) safely out of the
    // loop while still letting the full editor flow get exercised.
    function _applyBetaModeUI() {
      // Page-level beta cues (title badge + orange sub-banner) are
      // independent of the editor button — apply them whenever the
      // flag is on, even if the user hasn't entered the editor yet.
      if (BETA_MODE) {
        document.body.classList.add("beta-mode-active");
        var titleEl = document.getElementById("appTitle");
        if (titleEl && !titleEl.querySelector(".app-title-beta-badge")) {
          var badge = document.createElement("span");
          badge.className = "app-title-beta-badge";
          badge.textContent = "BETA";
          titleEl.appendChild(badge);
        }
        // Mobile UX (audit 2026-05-22): the orange beta banner eats
        // ~52 px above the picker. The H1 already carries a BETA pill,
        // so the banner is partly redundant. Add a tap-to-dismiss × on
        // narrow viewports; once dismissed the choice persists for the
        // session (sessionStorage, not local — testers should still see
        // it on a fresh visit).
        var banner = document.getElementById("betaBanner");
        if (banner && !banner.querySelector(".beta-banner-dismiss")) {
          var dismissed = false;
          try { dismissed = sessionStorage.getItem("sa_beta_banner_dismissed") === "1"; } catch (_e) {}
          if (dismissed) {
            banner.style.display = "none";
          } else if (window.matchMedia && window.matchMedia("(max-width: 749px)").matches) {
            var x = document.createElement("button");
            x.type = "button";
            x.className = "beta-banner-dismiss";
            x.setAttribute("aria-label", "Dismiss beta notice");
            x.textContent = "×";
            x.style.cssText = "background:none;border:0;color:inherit;font-size:18px;line-height:1;margin-left:8px;padding:0 4px;cursor:pointer;opacity:0.7;";
            x.addEventListener("click", function () {
              banner.style.display = "none";
              try { sessionStorage.setItem("sa_beta_banner_dismissed", "1"); } catch (_e) {}
            });
            banner.appendChild(x);
          }
        }
      } else {
        document.body.classList.remove("beta-mode-active");
        var existingBadge = document.querySelector("#appTitle .app-title-beta-badge");
        if (existingBadge) existingBadge.remove();
      }
      if (!btnBuyInEditor || !BETA_MODE) return;
      var lbl = document.getElementById("btnBuyLabel");
      if (lbl) lbl.textContent = "Download your design";
      // Gate the button on having a real mockup ready, matching prod.
      // The zip bundle is only useful with mockups inside it — a PNG-
      // only download leaves the tester wondering whether the mockup
      // step worked. Disabled state + the "Generate real mockup first"
      // tooltip steer them to hit that button first.
      // Single source of truth: _hasRealMockup() also accepts the Phase B
      // default-landing manifest entry as "real" so the gate doesn't block
      // when the user hasn't personalized away from the showcase image.
      var hasMocks = _hasRealMockup();
      btnBuyInEditor.title = hasMocks
        ? "Beta: save your design + all generated product mockups as a .zip."
        : "Generate a real mockup first (use the Generate real mockup button in the preview pane), then download the bundle.";
      btnBuyInEditor.disabled = !hasMocks;
      btnBuyInEditor.classList.toggle("buy-locked", !hasMocks);
      // Swap the icon for a download glyph.
      var icon = btnBuyInEditor.querySelector("i");
      if (icon) icon.className = "fas fa-download";
    }


    if (btnBuyInEditor) {
      btnBuyInEditor.addEventListener("click", function() {
        if (btnBuyInEditor.disabled) return;
        if (!state.selectedProduct) return;

        // Beta path: save a local PNG instead of triggering Shopify.
        // Still apply the FITS-quality gate so testers don't walk
        // away with a 384-px placeholder thinking it's the real
        // thing — same blast-radius if/when they hand the PNG to
        // someone for a one-off print outside this app.
        if (BETA_MODE) {
          _gatePrintQuality(function(ok) {
            if (ok) saveDesignLocally();
          });
          return;
        }

        if (!_hasRealMockup()) return;
        var product = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
        if (!product) return;
        _gatePrintQuality(function(ok) {
          if (ok) startCheckout(product);
        });
      });
      updateBuyButtonState();
    }

    // ── Full Catalog Browser ──────────────────────────────────────
    var catalogModal = document.getElementById("catalogModal");
    var catalogCache = null; // cached blueprint list

    // The "Browse More Products" entry button was removed in favour of
    // the in-modal catalog search inside the Request-a-product feedback
    // pane (which has chips, prices, and mockups). The openCatalog()
    // / catalogModal flow below is left for now in case we want to
    // re-attach an entry point — nothing else calls it.

    function openCatalog() {
      catalogModal.classList.remove("hidden");
      catalogModal.innerHTML =
        '<div class="catalog-header">' +
          '<h2><i class="fas fa-th-large"></i> Printify Catalog</h2>' +
          '<input class="catalog-search" id="catSearch" type="text" placeholder="Search products…">' +
          '<button class="catalog-close" id="catClose" type="button" aria-label="Close catalog"><i class="fas fa-times" aria-hidden="true"></i></button>' +
        '</div>' +
        '<div class="catalog-body" id="catBody">' +
          '<div class="catalog-loading"><div class="spinner"></div>Loading catalog…</div>' +
        '</div>';

      document.getElementById("catClose").addEventListener("click", closeCatalog);

      if (catalogCache) {
        renderCatalogGrid(catalogCache);
        setupCatalogSearch();
      } else {
        fetchWithTimeout(API_BASE + "/api/printify/blueprints", {}, 45000)
          .then(function(r) { return r.json(); })
          .then(function(data) {
            catalogCache = Array.isArray(data) ? data : [];
            renderCatalogGrid(catalogCache);
            setupCatalogSearch();
          })
          .catch(function(err) {
            document.getElementById("catBody").innerHTML =
              '<div class="catalog-loading" style="color:var(--accent-flare);">' +
              '<i class="fas fa-exclamation-circle"></i> Failed to load catalog: ' + err.message +
              '</div>';
          });
      }
    }

    function closeCatalog() {
      catalogModal.classList.add("hidden");
      catalogModal.innerHTML = "";
    }

    function renderCatalogGrid(items) {
      var body = document.getElementById("catBody");
      var html = '<div class="catalog-grid" id="catGrid">';
      items.forEach(function(bp) {
        var img = bp.images && bp.images.length > 0 ? bp.images[0] : "";
        html += '<div class="catalog-item" data-bpid="' + bp.id + '" data-name="' +
          (bp.title || "").replace(/"/g, "&quot;") + '">' +
          (img ? '<img src="' + img + '" alt="" loading="lazy">' :
            '<div style="width:100%;aspect-ratio:1;background:var(--bg-deep);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--text-dim);"><i class="fas fa-box" style="font-size:2rem;"></i></div>') +
          '<div class="cat-name">' + (bp.title || "Product #" + bp.id) + '</div>' +
          '</div>';
      });
      html += '</div>';
      body.innerHTML = html;

      // Click handler for each blueprint
      document.getElementById("catGrid").addEventListener("click", function(e) {
        var item = e.target.closest(".catalog-item");
        if (!item) return;
        var bpId = parseInt(item.dataset.bpid, 10);
        var bpName = item.dataset.name;
        showProviderStep(bpId, bpName);
      });
    }

    function setupCatalogSearch() {
      var searchInput = document.getElementById("catSearch");
      if (!searchInput) return;
      searchInput.addEventListener("input", function() {
        var q = searchInput.value.toLowerCase().trim();
        if (!catalogCache) return;
        if (!q) {
          renderCatalogGrid(catalogCache);
          return;
        }
        var filtered = catalogCache.filter(function(bp) {
          return (bp.title || "").toLowerCase().indexOf(q) !== -1 ||
                 String(bp.id).indexOf(q) !== -1;
        });
        renderCatalogGrid(filtered);
      });
    }

    function showProviderStep(bpId, bpName) {
      var body = document.getElementById("catBody");
      body.innerHTML =
        '<div class="catalog-step2">' +
          '<button class="catalog-back" id="catBack"><i class="fas fa-arrow-left"></i> Back to catalog</button>' +
          '<h3>' + bpName + '</h3>' +
          '<div class="catalog-loading"><div class="spinner"></div>Loading providers &amp; variants…</div>' +
        '</div>';

      document.getElementById("catBack").addEventListener("click", function() {
        renderCatalogGrid(catalogCache);
        setupCatalogSearch();
      });

      // Try common print providers in order until one has variants for this blueprint
      tryFetchVariants(bpId, bpName, [16, 29, 99, 1, 6, 28, 27, 55, 58, 44, 3]);
    }

    function tryFetchVariants(bpId, bpName, providerIds) {
      if (providerIds.length === 0) {
        var body = document.getElementById("catBody");
        if (body) {
          body.querySelector(".catalog-step2").innerHTML =
            '<button class="catalog-back" id="catBack2"><i class="fas fa-arrow-left"></i> Back</button>' +
            '<h3>' + bpName + '</h3>' +
            '<p style="color:var(--text-secondary);margin-top:12px;">No providers/variants found for this product. ' +
            'Try a different product or check the Printify dashboard.</p>';
          document.getElementById("catBack2").addEventListener("click", function() {
            renderCatalogGrid(catalogCache);
            setupCatalogSearch();
          });
        }
        return;
      }

      var pid = providerIds[0];
      var remaining = providerIds.slice(1);

      fetchWithTimeout(API_BASE + "/api/printify/blueprints/" + bpId + "/providers/" + pid + "/variants", {}, 30000)
        .then(function(r) {
          if (!r.ok) throw new Error("status " + r.status);
          return r.json();
        })
        .then(function(data) {
          var variants = data.variants || data;
          if (!Array.isArray(variants) || variants.length === 0) {
            throw new Error("empty");
          }
          showVariantPicker(bpId, bpName, pid, variants);
        })
        .catch(function() {
          tryFetchVariants(bpId, bpName, remaining);
        });
    }

    function showVariantPicker(bpId, bpName, providerId, variants) {
      var body = document.getElementById("catBody");
      if (!body) return;
      var step2 = body.querySelector(".catalog-step2");
      if (!step2) return;

      var html =
        '<button class="catalog-back" id="catBack3"><i class="fas fa-arrow-left"></i> Back to catalog</button>' +
        '<h3>' + bpName + '</h3>' +
        '<p style="color:var(--text-dim);font-size:0.82rem;margin-bottom:12px;">Select a variant to add:</p>' +
        '<div class="catalog-variant-list">';

      variants.forEach(function(v) {
        var label = v.title || ((v.options || {}).size || "") + " " + ((v.options || {}).color || "") || "Variant " + v.id;
        html += '<button class="catalog-variant-btn" data-vid="' + v.id + '">' +
          '<span>' + label.trim() + '</span>' +
          '<span class="var-detail">ID: ' + v.id + '</span>' +
          '</button>';
      });

      html += '</div>';
      step2.innerHTML = html;

      document.getElementById("catBack3").addEventListener("click", function() {
        renderCatalogGrid(catalogCache);
        setupCatalogSearch();
      });

      step2.querySelector(".catalog-variant-list").addEventListener("click", function(e) {
        var btn = e.target.closest(".catalog-variant-btn");
        if (!btn) return;
        var vid = parseInt(btn.dataset.vid, 10);
        addCatalogProduct(bpId, bpName, providerId, vid);
      });
    }

    function addCatalogProduct(bpId, bpName, providerId, variantId) {
      // Product ID is per blueprint+provider (all variants are included at checkout)
      var newId = "catalog_" + bpId + "_" + providerId;

      // Check if already in PRODUCTS
      var existing = PRODUCTS.find(function(p) { return p.id === newId; });
      if (!existing) {
        PRODUCTS.push({
          id: newId,
          name: bpName,
          desc: "All sizes & colors included",
          icon: "fa-box",
          price: "Catalog",
          checkoutPrice: 2999,
          blueprintId: bpId,
          printProviderId: providerId,
          position: "front"
        });
      }

      if (state.selectedProduct !== newId) {
        state.uploadedPrintifyId = null;
        state.uploadedPrintifyIdRaw = null;
        state.uploadedPrintifyIdFiltered = null;
      }
      state.selectedProduct = newId;
      closeCatalog();
      renderProducts();
      showToast("Added: " + bpName);
    }

    // ── Canvas-to-base64 helper for Printify uploads ──────────
    function getCanvasBase64() {
      // Export the current solar canvas as a base64 string for Printify.
      // Re-render with `_burningCanvas` flag so the on-screen frame border,
      // guide lines, and any live (un-burned) text overlay are excluded from
      // the image sent to Printify. Those are editing aids, not product art.
      // Set `_fullResRender` so the pixel-work branch in renderCanvas uses
      // the main canvas directly (no 1/4 downsample) — print output must
      // stay at full source resolution.
      var wasBurning = state._burningCanvas;
      var wasFullRes = state._fullResRender;
      state._burningCanvas = true;
      state._fullResRender = true;
      try { renderCanvas(); } catch (_e) {}

      var product = (typeof PRODUCTS !== "undefined" && state.selectedProduct)
        ? PRODUCTS.find(function(p) { return p.id === state.selectedProduct; })
        : null;
      var isCircularProduct = (state.selectedProduct === "wall_clock") ||
        (product && product.printShape === "circle");
      // Dual-panel "match" mode: the editor canvas is the single-face
      // aspect, but Printify expects a wraparound (front + back). Build
      // the upload PNG by concatenating two copies of the canvas side-
      // by-side so the same design lands on both faces. "span" mode
      // skips this — the canvas is already at panel aspect.
      var dualPanelMatch = !!(
        product && product.dualPanel && product.panelAspectRatio
        && ((state.dualPanelModeByProduct && state.dualPanelModeByProduct[product.id]) || "match") === "match"
      );

      var maxDim = 4096;
      var sw = solarCanvas.width;
      var sh = solarCanvas.height;
      // When concatenating, the LONG dimension of the export is 2 ×
      // face width, so the maxDim cap has to clamp the doubled width
      // (otherwise we'd silently over-shrink and lose fidelity on the
      // single face). For non-dual exports the formula reduces to the
      // original sw cap.
      var longDimAfter = dualPanelMatch ? Math.max(sw * 2, sh) : Math.max(sw, sh);
      var scale = Math.min(1, maxDim / longDimAfter);
      var ew = Math.round(sw * scale);
      var eh = Math.round(sh * scale);

      var exportW = dualPanelMatch ? ew * 2 : ew;
      var exportH = eh;
      var exportCanvas = document.createElement("canvas");
      exportCanvas.width = exportW;
      exportCanvas.height = exportH;
      var ectx = exportCanvas.getContext("2d");
      ectx.drawImage(solarCanvas, 0, 0, ew, eh);
      if (dualPanelMatch) {
        // Paint the same canvas on the right half. Printify's panel
        // maps left→back, right→front (verified by inspection on the
        // hardcover-journal mockup) — both halves carry the user's
        // design so front and back come out identical.
        ectx.drawImage(solarCanvas, ew, 0, ew, eh);
      }

      // Format choice:
      //   - PNG when the vignette fade is "transparent" OR the product
      //     has a non-rectangular print area (circular, etc). JPEG
      //     would flatten the alpha to black and Printify's mockup
      //     renderer then prints a black rectangle behind the disk on
      //     fabric products (real beta-tester report on a maroon
      //     crewneck — fabric should show through, not black box).
      //   - JPEG at q=0.85 otherwise. Smaller upload, no quality
      //     difference for fully-opaque renders.
      var needsAlpha = (state.vignetteFade === "transparent") || isCircularProduct;
      var dataUrl = needsAlpha
        ? exportCanvas.toDataURL("image/png")
        : exportCanvas.toDataURL("image/jpeg", 0.85);

      // Restore on-screen view (with border/guides/text overlay) for the editor.
      state._burningCanvas = wasBurning || false;
      state._fullResRender = wasFullRes || false;
      try { renderCanvas(); } catch (_e) {}

      return dataUrl.split(",")[1];
    }

    // ── Auto-generate Printify mockups after preview ───────────

    // Mirror mockup-status text into the polite aria-live region so
    // screen-reader users hear "Generating mockup…" / "Mockup ready"
    // / "Mockups unavailable: …" / etc. alongside sighted users.
    // The visible element uses `innerHTML` with icons + colored spans;
    // we strip to plain text for the live region so AT reads just
    // the message. One observer covers every update site without
    // having to touch each call.
    (function() {
      if (typeof MutationObserver === "undefined") return;
      var statusRegion = document.getElementById("statusRegion");
      var mockupStatusEl = document.getElementById("mockupStatus");
      if (!statusRegion || !mockupStatusEl) return;
      var lastAnnounced = "";
      var obs = new MutationObserver(function() {
        var txt = (mockupStatusEl.textContent || "").replace(/\s+/g, " ").trim();
        if (txt && txt !== lastAnnounced) {
          lastAnnounced = txt;
          // Sam P1 round-2 (WCAG 4.1.3): route mockup errors (marked
          // by the exclamation-triangle icon in the rendered HTML) to
          // the assertive #alertRegion so AT users are interrupted;
          // routine progress stays polite via #statusRegion.
          var isError = !!mockupStatusEl.querySelector(".fa-exclamation-triangle");
          if (isError && typeof announceAlert === "function") {
            announceAlert(txt);
          } else {
            statusRegion.textContent = txt;
          }
        }
      });
      obs.observe(mockupStatusEl, { childList: true, characterData: true, subtree: true });
    })();

    var mockupStatus = $("#mockupStatus");

    /**
     * Generate Printify mockups.
     * @param {string} variant - "raw" or "filtered". Determines which cache + upload ID to use.
     * @param {string} [productId] - If provided, generate mockup only for this product (e.g. from floating preview pane).
     */
    function autoGenerateMockups(variant, productId, onDone) {
      variant = variant || "raw";
      // onDone(err|null) \u2014 optional completion callback. Called once,
      // regardless of success or failure. The button click handler
      // uses this to clear the spinner state. Other callers pass
      // nothing and the callback is a no-op.
      var _settle = (typeof onDone === "function") ? onDone : function() {};
      var isFiltered = (variant !== "raw");
      var targetCache = isFiltered ? state.mockupsFiltered : state.mockupsRaw;
      var uploadIdKey = isFiltered ? "uploadedPrintifyIdFiltered" : "uploadedPrintifyIdRaw";

      var ready = PRODUCTS.filter(function(p) { return p.blueprintId && p.printProviderId && p.variantId; });
      if (productId) ready = ready.filter(function(p) { return p.id === productId; });
      if (ready.length === 0 || !state.originalImage) {
        _settle(new Error(state.originalImage ? "Product not ready" : "No image loaded"));
        return;
      }

      var needsMockup = ready.filter(function(p) { return !targetCache[p.id]; });
      if (needsMockup.length === 0) {
        // Already fully mocked for this variant; just update display
        updateMockupDisplay();
        _settle(null);
        return;
      }

      // Reuse existing upload if available
      if (state[uploadIdKey]) {
        var statusMsg = productId
          ? 'Generating mockup for ' + (needsMockup[0] ? needsMockup[0].name : productId) + '\u2026'
          : 'Generating ' + needsMockup.length + ' ' + variant + ' mockup(s)\u2026';
        // statusMsg embeds product.name + productId which come from
        // the operator's Printify catalog but could in theory contain
        // HTML if the operator edits a title in Printify with raw
        // tags. Escape defensively.
        mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> ' + escapeHtml(statusMsg);
        runMockupQueue(needsMockup, targetCache, state[uploadIdKey], variant, productId, _settle);
        return;
      }

      // For filtered mockups, temporarily render using the best available filtered image.
      // Switch the canvas to RHEF/HQ if the user is NOT already on it (e.g. still on "jpg" or
      // "raw"), capture the pixels, then restore.  If RHEF isn't available yet, fall through
      // and capture whatever is currently on the canvas.
      var prevFilter = state.editorFilter;
      if (isFiltered && state.editorFilter !== "rhef") {
        if (state.rhefImage) {
          state.editorFilter = "rhef";
          renderCanvas();
        } else if (state.hqFilterImage && state.hqFormat) {
          state.editorFilter = state.hqFormat;
          renderCanvas();
        }
      }

      var fname = "solar_" + (dateInput.value || "image") + "_" + state.wavelength + "_" + variant + ".png";
      var base64Data = getCanvasBase64();

      // Restore filter state if we temporarily changed it
      if (state.editorFilter !== prevFilter) {
        state.editorFilter = prevFilter;
        renderCanvas();
      }

      mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Uploading ' + escapeHtml(variant) + (productId ? ' for this product' : ' for mockups') + ' (' + Math.round(base64Data.length / 1024) + ' KB)\u2026';

      fetchWithTimeout(API_BASE + "/api/printify/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_name: fname, contents: base64Data })
      }, 90000)
      .then(function(r) {
        if (!r.ok) return r.text().then(function(t) { throw new Error(t); });
        return r.json();
      })
      .then(function(data) {
        if (!data.id) throw new Error("No image ID returned");
        state[uploadIdKey] = data.id;
        // Also set the legacy key for backward compat
        if (!isFiltered) state.uploadedPrintifyId = data.id;
        var unmocked = PRODUCTS.filter(function(p) {
          return p.blueprintId && p.printProviderId && p.variantId && !targetCache[p.id];
        });
        if (productId) unmocked = unmocked.filter(function(p) { return p.id === productId; });
        runMockupQueue(unmocked, targetCache, data.id, variant, productId, _settle);
      })
      .catch(function(err) {
        // err.message can include server-derived strings (Printify
        // error bodies, fetch failures). Escape before innerHTML.
        mockupStatus.innerHTML = '<span style="color:var(--accent-sun);font-size:12px;"><i class="fas fa-exclamation-triangle"></i> Mockups unavailable: ' + escapeHtml(err.message) + '</span>';
        _settle(err);
      });
    }

    /**
     * Process mockup creation queue.
     * @param {Array} queue - products to mock up
     * @param {Object} targetCache - state.mockupsRaw or state.mockupsFiltered
     * @param {string} printifyImageId - uploaded image ID
     * @param {string} variant - "raw" or "filtered"
     * @param {string} [singleProductId] - If set, only one product; completion message is singular.
     */
    function runMockupQueue(queue, targetCache, printifyImageId, variant, singleProductId, onDone) {
      var total = queue.length;
      var done = 0;
      // Track whether ANY product in this batch landed. A single-
      // product run with one failure → reject; multi-product runs
      // are still considered a success as long as at least one
      // landed (the existing error toast already covers the rest).
      var anySuccess = false;
      var lastError = null;
      var _settle = (typeof onDone === "function") ? onDone : function() {};

      function createNext() {
        if (queue.length === 0) {
          var doneMsg = singleProductId
            ? '<span style="color:#3ddc84;font-size:12px;"><i class="fas fa-check-circle"></i> Mockup ready</span>'
            : '<span style="color:#3ddc84;font-size:12px;"><i class="fas fa-check-circle"></i> All ' + total + ' ' + (variant || '') + ' mockup(s) ready</span>';
          if (anySuccess) {
            mockupStatus.innerHTML = doneMsg;
          }
          updateMockupDisplay();
          if (singleProductId && typeof updatePreviewPaneMockupState === "function") updatePreviewPaneMockupState();
          _settle(anySuccess ? null : (lastError || new Error("Mockup generation failed")));
          return;
        }
        var product = queue.shift();
        done++;
        mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Mockup ' + done + '/' + total + ': ' + escapeHtml(product.name) + '\u2026';

        // Use the user's currently-selected variant if they've picked one —
        // beta testers picked "Wooden Base / White hands" on the clock and
        // got back a black-base mockup because we were sending the catalog
        // default variantId (Black Base / Black) every time. Falls back to
        // product.variantId for products the user hasn't yet customised.
        var pickedVariantId = (state.selectedVariantByProduct[product.id] != null)
          ? state.selectedVariantByProduct[product.id]
          : product.variantId;
        // Defensive guard for products whose `variantId` was left null
        // (e.g. the commented-out `phone_case_pixel` entry — QA flagged
        // that buildCatalogEntryFromRequest could theoretically reach
        // this path with no resolved variant). A null variantId would
        // bubble straight to Printify as a 400 with no useful UI
        // signal — surface a polite mockupStatus error and skip the
        // attempt instead.
        if (pickedVariantId == null) {
          if (mockupStatus) {
            mockupStatus.innerHTML = '<span style="color:var(--accent-sun);font-size:12px;"><i class="fas fa-exclamation-triangle"></i> ' + escapeHtml(product.name || "this product") + " doesn't have a default variant yet — pick one via the variant picker first.</span>";
          }
          // Treat this product as failed but continue the queue so
          // multi-product batches don't stall on one bad entry.
          createNext();
          return;
        }
        var payload = {
          title: "[MOCKUP] Solar Preview — " + product.name,
          description: "Auto-generated mockup preview",
          blueprint_id: product.blueprintId,
          print_provider_id: product.printProviderId,
          variants: [{ id: pickedVariantId, price: 100, is_enabled: true }],
          print_areas: [{
            variant_ids: [pickedVariantId],
            placeholders: [{
              position: product.position || "front",
              images: [{ id: printifyImageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }]
            }]
          }]
        };

        fetchWithTimeout(API_BASE + "/api/printify/product", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }, 90000)
        .then(function(r) {
          if (!r.ok) return r.text().then(function(t) { throw new Error(t); });
          return r.json();
        })
        .then(function(prodData) {
          var images = prodData.images || [];
          if (images.length > 0) {
            targetCache[product.id] = { images: images, printifyProductId: prodData.id };
            // Also update active mockups for display
            state.mockups[product.id] = { images: images, printifyProductId: prodData.id };
            anySuccess = true;
          } else {
            // 200 OK but Printify returned no mockup images — treat as failure
            // so the button doesn't go quiet. Real example: a placeholder
            // mismatch can still come back 201-created but with images=[].
            lastError = new Error(product.name + ": Printify returned no mockup images");
          }
          renderProducts();
          if (typeof updateBuyButtonState === "function") updateBuyButtonState();
          createNext();
        })
        .catch(function(err) {
          lastError = err;
          mockupStatus.innerHTML = '<span style="color:var(--accent-sun);font-size:12px;"><i class="fas fa-exclamation-triangle"></i> ' + escapeHtml(product.name) + ': ' + escapeHtml(err.message) + '</span>';
          setTimeout(createNext, 500);
        });
      }

      createNext();
    }

    // ── Checkout flow: Buy button → create → publish → Shopify ────
    var sendHint = $("#sendHint");
    var SHOPIFY_STORE = "solar-archive.myshopify.com"; // updated at runtime from store-config
    // Beta-mode flag: when true, "Create on Shopify" becomes "Download
    // Your Design" so testers don't trigger real Printify orders. The
    // operator sets BETA_MODE=1 on the backend and the flag rides in
    // on /store-config below.
    var BETA_MODE = false;

    // Fetch store config on load
    fetchWithTimeout(API_BASE + "/api/printify/store-config", {}, 10000)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.shopify_store_domain) {
          SHOPIFY_STORE = data.shopify_store_domain;
        }
        if (data && typeof data.beta_mode !== "undefined") {
          BETA_MODE = !!data.beta_mode;
          // Re-sync the buy button now that we know the mode.
          if (typeof updateBuyButtonState === "function") updateBuyButtonState();
          if (typeof _applyBetaModeUI === "function") _applyBetaModeUI();
          // Re-render so the operator/beta-only popularity badge appears
          // now that BETA_MODE is known.
          if (typeof renderProducts === "function") renderProducts();
        }
      })
      .catch(function() { /* keep default */ });

    function updateSendToPrintifyButton() {
      // Re-render product cards and Select this product buttons when HQ state changes
      renderProducts();
      if (state.hqReady) {
        sendHint.textContent = "★ HQ print image ready — select a product, then Buy from the editor.";
        sendHint.style.color = "var(--accent-cool)";
      } else if (state.hqTaskId) {
        sendHint.textContent = "HQ image is rendering in the background — you can select a product and buy from the editor when ready.";
        sendHint.style.color = "var(--accent-sun)";
      } else if (state.originalImage) {
        // Image loaded, no HQ yet: the product cards + their "Pick a
        // variant" buttons are self-explanatory, so no redundant hint.
        sendHint.textContent = "";
      } else {
        sendHint.textContent = "Select a date and click a wavelength to see product previews.";
        sendHint.style.color = "var(--text-dim)";
      }
    }

    function startCheckout(product) {
      if (!state.originalImage) {
        showInfo("No Image", "Select a wavelength tile to load the solar image first.");
        return;
      }
      if (!product.blueprintId || !product.printProviderId) {
        showInfo("Product Not Ready", "This product's print details are still being resolved. Please wait a moment and try again.");
        return;
      }
      // Conversion signal: a finalized "Create on Shopify" checkout.
      recordStatEvent(product.id, "buy");

      var hqNote = state.hqReady
        ? "The full NASA/SDO HQ image is ready and will be used for printing."
        : (state.hqTaskId
            ? "The HQ image is still rendering — checkout will wait for it automatically before uploading."
            : "The preview image will be used. Switch the Filter to <strong>HQ RHEF</strong> first if you want the full-resolution print.");

      showModal(
        "Create " + product.name + " on Shopify",
        "This will publish your custom <strong>" + product.name + "</strong> to Shopify with your selected variant locked in. All you'll do on Shopify is complete payment — no need to re-pick the product, size, or color.<br><br>" +
          hqNote,
        function() {
          // Kick off the checkout and keep the modal open with a spinner on
          // the Create button until the status list below has rendered and
          // scrolled into view. That way the user sees a continuous "I'm
          // working on it" signal from button-press → modal spinner →
          // status-list progress, with no blank moment in between.
          doCheckout(product);
          return new Promise(function(resolve) {
            // One frame for the spinner to paint, then a hold long enough
            // for checkoutProgress to scroll into view and ckStep1's spinner
            // to start animating. ~650ms feels responsive without flashing.
            requestAnimationFrame(function() { setTimeout(resolve, 650); });
          });
        },
        "Create on Shopify",
        "Creating product\u2026"
      );
    }

    function doCheckout(product) {
      // Show checkout progress
      checkoutProgress.classList.remove("hidden");
      checkoutProgress.innerHTML =
        '<div style="font-weight:600;margin-bottom:12px;font-size:1rem;">' +
          '<i class="fas fa-shopping-cart"></i> Creating your ' + product.name + '…' +
        '</div>' +
        '<div class="checkout-step active" id="ckStep1">' +
          '<i class="fas fa-spinner fa-spin"></i> <span>Uploading your solar image…</span>' +
        '</div>' +
        '<div class="checkout-step" id="ckStep2">' +
          '<i class="fas fa-circle" style="font-size:6px;"></i> <span>Creating product with all variants</span>' +
        '</div>' +
        '<div class="checkout-step" id="ckStep3">' +
          '<i class="fas fa-circle" style="font-size:6px;"></i> <span>Publishing to Shopify</span>' +
        '</div>' +
        '<div class="checkout-step" id="ckStep4">' +
          '<i class="fas fa-circle" style="font-size:6px;"></i> <span>Waiting for Shopify product link</span>' +
        '</div>';

      // Scroll checkout progress into view
      checkoutProgress.scrollIntoView({ behavior: "smooth", block: "center" });

      // Disable all buy buttons during checkout
      productGrid.querySelectorAll(".product-buy-btn").forEach(function(btn) { btn.disabled = true; });

      var dateStr = dateInput.value || "custom";
      var wlStr = state.wavelength + "Å";
      var title = "Solar " + wlStr + " — " + dateStr + " · " + product.name;
      var fname = "solar_" + dateStr + "_" + state.wavelength + "_hq.png";

      // Resolve HQ image then composite user edits on top before uploading
      _getCheckoutImageBase64(dateStr).then(function(base64Data) {
        // Update step 1 to show upload size
        var sizeKB = Math.round(base64Data.length / 1024);
        var step1 = document.getElementById("ckStep1");
        if (step1) step1.querySelector("span").textContent = "Uploading solar image (" + sizeKB + " KB)…";

        // Collect all filtered variants to enable on the Printify product so customers
        // can choose their preferred size/color on Shopify.
        var ckCacheKey = product.blueprintId + "_" + product.printProviderId;
        var ckAllVariants = variantCache[ckCacheKey] || [];
        var ckFiltered = filterVariantsForProduct(product, ckAllVariants);
        var ckVariantIds = ckFiltered.map(function(v) { return v.id; });
        // Always include the user-selected variant as a fallback
        var ckSelectedId = state.selectedVariantByProduct[product.id] || product.variantId;
        if (ckSelectedId && ckVariantIds.indexOf(ckSelectedId) === -1) {
          ckVariantIds.unshift(ckSelectedId);
        }
        if (!ckVariantIds.length) ckVariantIds = [ckSelectedId];

        return fetchWithTimeout(API_BASE + "/api/printify/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_base64: base64Data,
            file_name: fname,
            title: title,
            description: "Custom " + wlStr + " solar image from " + dateStr + ", printed on " + product.name + ". Created with Solar Archive.",
            blueprint_id: product.blueprintId,
            print_provider_id: product.printProviderId,
            variant_ids: ckVariantIds,
            price: product.checkoutPrice,
            position: product.position || "front",
            tags: ["solar-archive", "custom", "sun", wlStr, product.name.toLowerCase()]
          })
        }, 180000)
        .then(function(r) {
          if (!r.ok) return r.text().then(function(t) { throw new Error(t); });
          return r.json();
        })
        .then(function(data) {
          if (!data.printify_product_id) throw new Error("No product ID returned");
          var vcMsg = data.variant_count ? " (" + data.variant_count + " variants)" : "";
          markCheckoutStep("ckStep1", "done", "Image uploaded");
          markCheckoutStep("ckStep2", "done", "Product created" + vcMsg);
          markCheckoutStep("ckStep3", "done", "Published to Shopify");
          markCheckoutStep("ckStep4", "active", "Waiting for Shopify product link…");
          return pollShopifyUrl(data.printify_product_id);
        })
        .then(function(shopifyUrl) {
          markCheckoutStep("ckStep4", "done", "Shopify product ready!");
          checkoutProgress.innerHTML +=
            '<div style="margin-top:16px;">' +
              '<div style="font-size:48px;margin-bottom:8px;">🎉</div>' +
              '<div style="color:#3ddc84;font-weight:600;margin-bottom:8px;">Your product is live on Shopify!</div>' +
              '<p style="color:var(--text-secondary);font-size:13px;margin-bottom:14px;">' +
                'Your variant is pre-selected — just complete checkout on Shopify to receive your custom print.' +
              '</p>' +
              '<a href="' + shopifyUrl + '" target="_blank" rel="noopener" class="btn-shopify-checkout">' +
                '<i class="fab fa-shopify"></i> Complete Purchase on Shopify' +
              '</a>' +
              '<div style="margin-top:10px;">' +
                '<button class="edit-btn" onclick="document.getElementById(\'checkoutProgress\').classList.add(\'hidden\');" style="margin:0 auto;">' +
                  '<i class="fas fa-times"></i> Dismiss' +
                '</button>' +
              '</div>' +
            '</div>';
          showToast("Product ready — click Complete Purchase when you're ready.");
          // Auto-redirect removed: beta testers reported the previous 1.5s
          // redirect felt "instant" and hid the completed status indicator.
          // The user now clicks the prominent Complete Purchase button when
          // they're ready, keeping the flow under their control.
        });
      })
      .catch(function(err) {
        var msg = err.message || String(err);
        // Try to parse JSON error from backend
        try { msg = JSON.parse(msg).detail || msg; } catch(_e) {}
        // Check for rate limit errors
        if (msg.toLowerCase().includes("rate limit") || msg.toLowerCase().includes("429")) {
          msg = "Rate limit exceeded. Please wait a few minutes and try again.";
        }
        // Check for network errors
        if (msg.toLowerCase().includes("failed to fetch") || msg.toLowerCase().includes("networkerror")) {
          msg = "Network error. Please check your internet connection and try again.";
        }
        checkoutProgress.innerHTML +=
          '<div style="margin-top:14px;color:var(--accent-flare);">' +
            '<i class="fas fa-exclamation-triangle"></i> ' + msg +
            '<br><button class="edit-btn" style="margin-top:8px;" ' +
              'onclick="document.getElementById(\'checkoutProgress\').classList.add(\'hidden\');">' +
              '<i class="fas fa-times"></i> Dismiss</button>' +
          '</div>';
        showToast("Checkout failed: " + msg, "error");
      })
      .finally(function() {
        // Re-enable buy buttons
        productGrid.querySelectorAll(".product-buy-btn").forEach(function(btn) {
          var pid = btn.dataset.productId;
          var prod = PRODUCTS.find(function(p) { return p.id === pid; });
          if (prod && state.originalImage && prod.blueprintId && prod.printProviderId) {
            btn.disabled = false;
          }
        });
      });
    }

    /**
     * Get a base64 PNG for Printify upload.
     * If HQ is ready: load HQ image, render canvas with current edits on top, export.
     * If HQ is still generating: wait for it (polling hqCache), then do same.
     * If no HQ task: just export the current canvas (Helioviewer preview + edits).
     */
    function _getCheckoutImageBase64(dateStr) {
      // No HQ task running — use current canvas as-is
      if (!state.hqTaskId && !state.hqReady) {
        return Promise.resolve(getCanvasBase64());
      }

      // HQ already done — load it, rerender with edits, export
      if (state.hqReady && state.hqImageUrl) {
        return _loadHqAndExport(state.hqImageUrl);
      }

      // HQ is still generating — poll until it appears in hqCache
      markCheckoutStep("ckStep1", "active", "Waiting for HQ image to finish rendering…");
      var cacheKey = dateStr + "_" + state.wavelength;
      return new Promise(function(resolve, reject) {
        var attempts = 0;
        var maxAttempts = 120; // up to 4 minutes
        function checkCache() {
          attempts++;
          var cached = hqCache[cacheKey];
          if (state.hqReady && state.hqImageUrl) {
            _loadHqAndExport(state.hqImageUrl).then(resolve).catch(reject);
          } else if (cached && cached.url) {
            state.hqImageUrl = cached.url;
            state.hqReady = true;
            _loadHqAndExport(cached.url).then(resolve).catch(reject);
          } else if (attempts >= maxAttempts) {
            // Timed out — fall back to current canvas
            resolve(getCanvasBase64());
          } else {
            setTimeout(checkCache, 2000);
          }
        }
        checkCache();
      });
    }

    /**
     * Load the HQ image URL into a temp canvas, apply all current user edits
     * (brightness, contrast, saturation, vignette, text overlay, crop etc.),
     * and export as base64 PNG.
     */
    function _loadHqAndExport(hqUrl) {
      return loadImage(hqUrl).then(function(hqImg) {
        // Swap originalImage to HQ, render with all edits, export, then restore
        var prevImg = state.originalImage;
        state.originalImage = hqImg;
        renderCanvas();
        var b64 = getCanvasBase64();
        // Restore — user keeps editing the preview canvas
        state.originalImage = prevImg;
        renderCanvas();
        return b64;
      }).catch(function() {
        // If HQ can't be loaded (CORS etc), fall back to current canvas
        return getCanvasBase64();
      });
    }

    function markCheckoutStep(stepId, status, text) {
      var el = document.getElementById(stepId);
      if (!el) return;
      el.className = "checkout-step " + status;
      var icon = el.querySelector("i");
      var span = el.querySelector("span");
      if (status === "done") {
        icon.className = "fas fa-check-circle";
        icon.style.fontSize = "";
      } else if (status === "active") {
        icon.className = "fas fa-spinner fa-spin";
        icon.style.fontSize = "";
      }
      if (span && text) span.textContent = text;
    }

    function pollShopifyUrl(printifyProductId) {
      var maxAttempts = 30;  // 30 × 3s = 90s max wait
      var attempt = 0;

      return new Promise(function(resolve, reject) {
        function tick() {
          attempt++;
          if (attempt > maxAttempts) {
            // Timed out waiting — give fallback link to store
            resolve("https://" + SHOPIFY_STORE + "/collections/all");
            return;
          }

          fetchWithTimeout(
            API_BASE + "/api/printify/product/" + printifyProductId + "/shopify-url",
            { method: "GET" },
            15000
          )
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.status === "ready" && data.shopify_url) {
              resolve(data.shopify_url);
            } else {
              var step4 = document.getElementById("ckStep4");
              if (step4) {
                var span = step4.querySelector("span");
                if (span) span.textContent = "Waiting for Shopify… (attempt " + attempt + ")";
              }
              setTimeout(tick, 3000);
            }
          })
          .catch(function() {
            setTimeout(tick, 3000);
          });
        }
        tick();
      });
    }

    // (Shopify Store / Printify Dashboard buttons removed)

    // Product tiles are NOT pre-rendered on load.
    // renderProducts() is called by _installPreviewImage() once a date is selected and the
    // solar preview loads, ensuring cards only populate after the user picks a date.

    // ── Pre-editor variant picker + confirmation modal ────────────
    // Colour chooser for a merged product (e.g. the mug, whose White/Black
    // colours are separate Printify blueprints). Shows one tile per colour
    // with a live mockup of that colour; picking one resolves to the real
    // child product and runs the normal commit→editor flow. Built
    // dynamically so it doesn't touch the markup. Gated to open only when
    // an image is loaded (so the mockups render).
    function showColorChooser(product) {
      var opts = (product.colorOptions || []).filter(function(o) {
        return o && o.productId && PRODUCTS.some(function(p) { return p.id === o.productId; });
      });
      if (opts.length < 2) {
        showConfirmSelectModal(product, function() { commitProductSelection(product); });
        return;
      }
      var prevFocus = document.activeElement;
      var overlay = document.createElement("div");
      overlay.className = "color-chooser-modal";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Choose a colour for " + product.name);

      var backdrop = document.createElement("div");
      backdrop.className = "color-chooser-backdrop";
      overlay.appendChild(backdrop);

      var panel = document.createElement("div");
      panel.className = "color-chooser-panel";
      panel.innerHTML =
        '<button class="color-chooser-close" type="button" aria-label="Close">&#x2715;</button>' +
        '<h2 class="color-chooser-title">' + escapeHtmlSimple(product.name) + '</h2>' +
        '<p class="color-chooser-sub">Choose a colour — then customize on the next screen.</p>' +
        '<div class="color-chooser-grid"></div>';
      overlay.appendChild(panel);
      document.body.appendChild(overlay);

      var grid = panel.querySelector(".color-chooser-grid");
      opts.forEach(function(opt) {
        var child = PRODUCTS.find(function(p) { return p.id === opt.productId; });
        if (!child) return;
        var tile = document.createElement("button");
        tile.type = "button";
        tile.className = "color-chooser-tile";
        tile.setAttribute("aria-label", opt.label + " " + product.name);
        // Live mockup of this colour.
        var prev = document.createElement("div");
        prev.className = "color-chooser-preview";
        try {
          if (state.originalImage && typeof drawProductMockup === "function" && solarCanvas && solarCanvas.width > 0) {
            var cv = document.createElement("canvas");
            cv.width = 240; cv.height = 240;
            var mctx = cv.getContext("2d"); mctx.scale(2, 2);
            var variant = (typeof getSelectedVariantForProduct === "function") ? getSelectedVariantForProduct(child.id) : null;
            drawProductMockup(mctx, child.id, solarCanvas.width, solarCanvas.height, variant);
            prev.appendChild(cv);
          }
        } catch (_e) {}
        var sw = document.createElement("span");
        sw.className = "color-chooser-swatch";
        sw.style.background = opt.hex || "#888";
        var lbl = document.createElement("span");
        lbl.className = "color-chooser-label";
        lbl.appendChild(sw);
        lbl.appendChild(document.createTextNode(" " + opt.label));
        tile.appendChild(prev);
        tile.appendChild(lbl);
        tile.addEventListener("click", function() {
          close();
          // Resolve to the real child product and run the standard flow.
          if (state.selectedVariantByProduct[child.id] == null && child.variantId != null) {
            state.selectedVariantByProduct[child.id] = child.variantId;
          }
          commitProductSelection(child);
        });
        grid.appendChild(tile);
      });

      function close() {
        document.removeEventListener("keydown", onKey);
        if (release) { release(); release = null; }
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (_e) {}
      }
      function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }
      backdrop.addEventListener("click", close);
      panel.querySelector(".color-chooser-close").addEventListener("click", close);
      document.addEventListener("keydown", onKey);
      var release = (typeof installModalFocusTrap === "function")
        ? installModalFocusTrap(overlay, { onEscape: close }) : null;
    }

    // Single-step variant selection: clicking "Pick a variant" on a product
    // card opens this modal with a scrollable list of variants, a live mockup
    // preview, and a Continue button. Tapping a variant updates the mockup
    // and the summary line; Continue commits the highlighted variant and
    // opens the editor. Replaces the previous two-step flow (inline collapse
    // → per-row Select → confirm dialog) that beta testers found cluttered.
    function showConfirmSelectModal(product, onContinue) {
      var modal = document.getElementById("confirmSelectModal");
      var listEl = document.getElementById("confirmSelectVariantList");
      var summaryEl = document.getElementById("confirmSelectSummary");
      var swatchesEl = document.getElementById("confirmSelectColorSwatches");
      var colorLabelEl = document.getElementById("confirmSelectColorLabel");
      var sizeChipsEl = document.getElementById("confirmSelectSizeChips");
      var mockupEl = document.getElementById("confirmSelectMockup");
      var titleEl = document.getElementById("confirmSelectTitle");
      var subEl = document.getElementById("confirmSelectSub");
      var continueBtn = document.getElementById("confirmSelectContinue");
      var closeBtn = document.getElementById("confirmSelectClose");
      var backdrop = document.getElementById("confirmSelectBackdrop");

      if (!modal || !listEl || !continueBtn) {
        if (onContinue) onContinue();
        return;
      }

      var cacheKey = product.blueprintId + "_" + product.printProviderId;
      // Snapshot original state so a Cancel/Esc/backdrop click restores it —
      // the modal mutates state.selectedVariantByProduct + variantAspectRatio
      // + cropZoom live so the mockup re-renders correctly on each tile tap.
      var originalVariantId = state.selectedVariantByProduct[product.id];
      var originalAR = state.variantAspectRatioByProduct[product.id];
      var originalCropZoom = state.cropZoom;

      var pendingVariantId = (originalVariantId != null) ? originalVariantId : product.variantId;
      // Layout mode (set by _renderSelectors): true when the product has
      // BOTH a colour axis and a size axis (clothing-style). Drives which
      // selectors render so we never show two controls for the same choice.
      var _twoAxis = false;

      if (titleEl) titleEl.textContent = product.name;
      if (subEl) {
        subEl.textContent = product._isUserRequested
          ? "Your request (pending review). Tap a variant, then continue."
          : "Tap a variant to preview, then continue to the editor.";
      }

      function _variantsList() {
        return sortVariantsByPrice(product, filterVariantsForProduct(product, variantCache[cacheKey] || []));
      }
      function _pricingMap() {
        return variantPricingCache[cacheKey] || {};
      }
      function _priceForVariant(v) {
        // Delegates to the shared retail formula (cost + markup anchored to
        // product.checkoutPrice) so the inline read-only panel and this
        // modal can't drift apart.
        return priceForVariantDisplay(product, v) || product.price || "";
      }
      function _renderSummary(variant) {
        if (!summaryEl) return;
        var ar = getEffectiveAspectRatio(product);
        var simplified = ar ? simplifyAspectRatio(ar.w, ar.h) : null;
        var arText = simplified ? (simplified.w + ":" + simplified.h) : "flexible";
        var price = _priceForVariant(variant);
        summaryEl.innerHTML =
          '<span class="confirm-summary-aspect">Aspect ratio <strong>' + escapeHtmlSimple(arText) + '</strong></span>' +
          (price ? ' <span class="confirm-summary-dot">·</span> <span class="confirm-summary-price">' + escapeHtmlSimple(price) + '</span>' : '');
      }
      function _renderMockup(variant) {
        if (!mockupEl) return;
        mockupEl.innerHTML = "";
        var canDraw = !!state.originalImage && typeof drawProductMockup === "function"
          && solarCanvas && solarCanvas.width > 0;
        if (!canDraw) { mockupEl.classList.add("empty"); return; }
        // Promote the editor filter to the highest available tier (HQ RHEF >
        // RHEF/Raw > JPG) before snapshotting, so the picker's mockup matches
        // the photorealistic showcase tile next to it instead of falling
        // back to the Helioviewer JPG preview. No-op when state.editorFilter
        // is already at the best tier.
        if (typeof _promoteFilterToBest === "function") {
          try { _promoteFilterToBest(); } catch (_e) {}
        }
        try {
          var c = document.createElement("canvas");
          c.width = 320; c.height = 320;
          c.className = "confirm-mockup-canvas";
          var mctx = c.getContext("2d");
          mctx.scale(2, 2);
          // useSelectedSource: the picker opens BEFORE commitProductSelection
          // runs, so productId !== state.selectedProduct (the previous
          // selection or null). Force the solarCanvas path anyway — we just
          // promoted to the best tier, and the alternative (JPG-backed
          // shareSrc) would visibly soften the preview.
          drawProductMockup(mctx, product.id, solarCanvas.width, solarCanvas.height, variant,
                            { useSelectedSource: true });
          mockupEl.appendChild(c);
          mockupEl.classList.remove("empty");
        } catch (e) { mockupEl.classList.add("empty"); }
      }
      function _selectInModal(vid) {
        pendingVariantId = vid;
        // Mutate live state so getEffectiveAspectRatio() reflects this choice
        // when re-rendering the mockup, and so the editor opens with the
        // correct frame on Continue. Restored on Cancel.
        state.selectedVariantByProduct[product.id] = vid;
        var variants = _variantsList();
        var v = variants.find(function(x) { return x.id === vid; });
        if (v) {
          var parsedAR = parseVariantAspectRatio(v);
          if (parsedAR) state.variantAspectRatioByProduct[product.id] = parsedAR;
          else delete state.variantAspectRatioByProduct[product.id];
        }
        // Variant-driven aspect ratios should use FILL (cropZoom=100) so the
        // print area is covered edge-to-edge — switching variants while
        // letterboxing is in effect leaves dead bars that don't match the
        // print outcome. Fill is the most faithful preview of "your image
        // covers this surface." Products with an extreme print panel (e.g.
        // crew socks at 1:2.83) override via `initialCropZoom` so the
        // editor opens with the disk-inscribed view instead of a thin
        // vertical band that's mostly outside the disk.
        state.cropZoom = (typeof product.initialCropZoom === "number" && product.initialCropZoom > 0)
          ? product.initialCropZoom
          : 100;
        listEl.querySelectorAll(".confirm-variant-tile").forEach(function(t) {
          var match = parseInt(t.dataset.variantId, 10) === vid;
          t.classList.toggle("active", match);
          t.setAttribute("aria-selected", match ? "true" : "false");
        });
        // Update the swatch row's active highlight too — handles both
        // tile clicks (which need the swatch to follow) and swatch
        // clicks (which already routed through this function).
        if (swatchesEl) {
          var newColor = v && variantColorOption(v);
          var newHex = newColor && newColor.hex;
          swatchesEl.querySelectorAll(".confirm-color-swatch").forEach(function(s) {
            s.classList.toggle("active", s.dataset.hex === newHex);
          });
        }
        // Re-render the size chips so the active size + unavailable
        // shading update when colour changes (a size dimmed under
        // "Red" may light up again under "Black", etc.). Only in
        // 2-axis mode — single-axis layouts hide the chips entirely,
        // and re-rendering would re-show the redundant row.
        if (_twoAxis && typeof _renderSizeChips === "function") _renderSizeChips();
        if (typeof _setColorLabel === "function") _setColorLabel();
        // Refresh any extra colour-axis rows (e.g. wall-clock hands) so
        // the active swatch + the "<Label>: <value>" header update.
        if (product.colorAxes && typeof _renderAllExtraAxes === "function") _renderAllExtraAxes();
        _renderSummary(v);
        _renderMockup(v);
      }
      // Human term for what the colour axis actually changes on THIS
      // product, so the swatches aren't unlabelled squares. Frames /
      // garments are the common cases; default to a plain "Color".
      function _colorAxisTerm() {
        var n = ((product && product.name) || "").toLowerCase();
        if (/frame/.test(n)) return "Frame color";
        if (/shirt|tee|hoodie|sweat|tank|crew|garment|apparel/.test(n)) return "Garment color";
        return "Color";
      }
      // Update the swatch-row label to "<term>: <selected colour>" with
      // a help tooltip clarifying it's the physical product, not the
      // solar image. Hidden whenever the swatch row is hidden.
      function _setColorLabel() {
        if (!colorLabelEl) return;
        if (!swatchesEl || swatchesEl.classList.contains("hidden")) {
          colorLabelEl.classList.add("hidden");
          colorLabelEl.textContent = "";
          return;
        }
        var term = _colorAxisTerm();
        var v = _variantsList().find(function(x) { return x.id === pendingVariantId; });
        var c = v && variantColorOption(v);
        colorLabelEl.textContent = term + (c && c.name ? ": " + c.name : "");
        colorLabelEl.title = "Sets the " + term.toLowerCase() +
          " of the printed product — your solar image stays the same.";
        if (swatchesEl) swatchesEl.setAttribute("aria-label", term);
        colorLabelEl.classList.remove("hidden");
      }
      // Build the colour-swatch row: one square per distinct colour
      // across the product's variants. Clicking a swatch jumps to a
      // variant matching that colour, preferring one that shares the
      // currently-active variant's size when possible (so toggling
      // "Black → Red" on a 2XL stays on 2XL).
      function _renderColorSwatches() {
        if (!swatchesEl) return;
        var variants = _variantsList();
        // Map colourHex → { name, sample variants[] } keyed by hex so
        // multiple "Solid Red"-ish names collapse onto a single swatch.
        var bucketsByHex = {};
        var orderedHexes = [];
        variants.forEach(function(v) {
          var c = variantColorOption(v);
          if (!c) return;
          if (!bucketsByHex[c.hex]) {
            bucketsByHex[c.hex] = { name: c.name, variants: [] };
            orderedHexes.push(c.hex);
          }
          bucketsByHex[c.hex].variants.push(v);
        });
        if (orderedHexes.length < 2) {
          // 0 colours → product has no colour option to swatch.
          // 1 colour → swatch row is redundant; the variant list is the picker.
          swatchesEl.classList.add("hidden");
          swatchesEl.innerHTML = "";
          if (typeof _setColorLabel === "function") _setColorLabel();
          return;
        }
        // Resolve the active variant's colour so we can mark a swatch
        // as currently selected.
        var activeVariant = variants.find(function(v) { return v.id === pendingVariantId; });
        var activeColor = activeVariant && variantColorOption(activeVariant);
        var activeHex = activeColor && activeColor.hex;
        // Detect "dark" swatches so the CSS can ring them with a
        // lighter outline that's visible on the modal background.
        function _isDark(hex) {
          var r = parseInt(hex.slice(1, 3), 16);
          var g = parseInt(hex.slice(3, 5), 16);
          var b = parseInt(hex.slice(5, 7), 16);
          // Standard relative luminance, threshold ≈ 28%.
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.28;
        }
        var html = "";
        orderedHexes.forEach(function(hex) {
          var bucket = bucketsByHex[hex];
          var isActive = (hex === activeHex) ? " active" : "";
          var tone = _isDark(hex) ? "dark" : "light";
          html += '<button type="button" role="option" class="confirm-color-swatch' + isActive + '"' +
                  ' data-hex="' + hex + '"' +
                  ' data-tone="' + tone + '"' +
                  ' title="' + escapeHtmlSimple(bucket.name) + ' (' + bucket.variants.length + ')"' +
                  ' style="background:' + hex + ';"></button>';
        });
        swatchesEl.innerHTML = html;
        swatchesEl.classList.remove("hidden");
        _setColorLabel();
      }

      function _onSwatchClick(hex) {
        var variants = _variantsList();
        // Try to keep the user on the same size when they switch colours.
        var current = variants.find(function(v) { return v.id === pendingVariantId; });
        var currentSize = _variantSize(current);
        var pool = variants.filter(function(v) {
          var c = variantColorOption(v);
          return c && c.hex === hex;
        });
        if (!pool.length) return;
        var pick = currentSize
          ? pool.find(function(v) { return _variantSize(v) === currentSize; }) || pool[0]
          : pool[0];
        // Also preserve any extra colour axes (e.g. wall-clock hands)
        // when switching the primary colour.
        if (product.colorAxes && product.colorAxes.length) {
          var preserved = pool.filter(function(v) {
            return (product.colorAxes || []).every(function(ax) {
              var cur = _variantAxisValue(current, ax);
              if (cur == null) return true;
              return _variantAxisValue(v, ax) === cur;
            });
          });
          if (preserved.length) pick = preserved[0];
        }
        _selectInModal(pick.id);
      }

      // ── Extra colour axes (e.g. wall-clock hands) ─────────────────
      // Read variant.options[<matching key>] case-insensitively. Each
      // axis declares a string regex (axisDef.keyPattern) to match
      // catalog key variations like "Hands" / "hand".
      function _variantAxisValue(v, axisDef) {
        if (!v || !v.options || !axisDef) return null;
        var re = new RegExp(axisDef.keyPattern || ("^" + axisDef.key + "$"), "i");
        var keys = Object.keys(v.options);
        for (var i = 0; i < keys.length; i++) {
          if (re.test(keys[i])) {
            var val = v.options[keys[i]];
            return (val == null || val === "") ? null : String(val);
          }
        }
        return null;
      }

      // Build a swatch row for an extra colour axis. Returns the
      // container element (a div appended after the primary swatches).
      // Reuses .confirm-color-swatch styling so it matches visually.
      function _ensureExtraAxesEl() {
        var el = document.getElementById("confirmSelectExtraAxes");
        if (!el && swatchesEl && swatchesEl.parentNode) {
          el = document.createElement("div");
          el.id = "confirmSelectExtraAxes";
          el.className = "confirm-extra-axes";
          swatchesEl.parentNode.insertBefore(el, swatchesEl.nextSibling);
        }
        return el;
      }
      function _renderExtraAxisSwatches(axisDef) {
        var container = _ensureExtraAxesEl();
        if (!container) return;
        var variants = _variantsList();
        // Bucket variants by this axis's value.
        var ordered = [];
        var bucketsByVal = {};
        variants.forEach(function(v) {
          var val = _variantAxisValue(v, axisDef);
          if (!val) return;
          if (!bucketsByVal[val]) {
            bucketsByVal[val] = { variants: [], hex: hexForColorName(val) || "#888" };
            ordered.push(val);
          }
          bucketsByVal[val].variants.push(v);
        });
        if (ordered.length < 2) return; // nothing meaningful to pick

        var activeV = variants.find(function(v) { return v.id === pendingVariantId; });
        var activeVal = _variantAxisValue(activeV, axisDef);
        var label = axisDef.label || axisDef.key;

        var html = '<div class="confirm-axis-label" title="' +
          escapeHtmlSimple("Sets the " + label.toLowerCase() + " of the printed product — your solar image stays the same.") +
          '">' + escapeHtmlSimple(label) + (activeVal ? ": " + escapeHtmlSimple(activeVal) : "") + '</div>' +
          '<div class="confirm-color-swatches" role="listbox" aria-label="' + escapeHtmlSimple(label) + '" data-axis-key="' + escapeHtmlSimple(axisDef.key) + '">';
        ordered.forEach(function(val) {
          var hex = bucketsByVal[val].hex;
          var isActive = (val === activeVal) ? " active" : "";
          var tone = (function(h) {
            var r = parseInt(h.slice(1,3),16), g = parseInt(h.slice(3,5),16), b = parseInt(h.slice(5,7),16);
            return ((0.2126*r + 0.7152*g + 0.0722*b)/255 < 0.28) ? "dark" : "light";
          })(hex);
          html += '<button type="button" role="option" class="confirm-color-swatch' + isActive + '"' +
                  ' data-axis-value="' + escapeHtmlSimple(val) + '"' +
                  ' data-tone="' + tone + '"' +
                  ' title="' + escapeHtmlSimple(val + " (" + bucketsByVal[val].variants.length + ")") + '"' +
                  ' style="background:' + hex + ';"></button>';
        });
        html += '</div>';
        // Append/replace this axis's block inside the container.
        var blockId = "confirmSelectAxis_" + axisDef.key;
        var existing = document.getElementById(blockId);
        var wrap = document.createElement("div");
        wrap.id = blockId;
        wrap.innerHTML = html;
        if (existing) existing.replaceWith(wrap);
        else container.appendChild(wrap);
      }
      function _renderAllExtraAxes() {
        if (!product.colorAxes || !product.colorAxes.length) {
          var el = document.getElementById("confirmSelectExtraAxes");
          if (el) el.innerHTML = "";
          return;
        }
        var el = _ensureExtraAxesEl();
        if (el) el.innerHTML = ""; // clear stale before re-render
        product.colorAxes.forEach(function(ax) { _renderExtraAxisSwatches(ax); });
      }
      function _onExtraAxisClick(axisKey, value) {
        var axisDef = (product.colorAxes || []).find(function(a) { return a.key === axisKey; });
        if (!axisDef) return;
        var variants = _variantsList();
        var current = variants.find(function(v) { return v.id === pendingVariantId; });
        // Preserve the primary (base) colour + any OTHER extra axes;
        // only the clicked axis flips to `value`.
        var primary = variantColorOption(current);
        var primaryHex = primary && primary.hex;
        var otherAxisVals = (product.colorAxes || [])
          .filter(function(a) { return a.key !== axisKey; })
          .map(function(a) { return { ax: a, want: _variantAxisValue(current, a) }; });
        var pool = variants.filter(function(v) {
          if (_variantAxisValue(v, axisDef) !== value) return false;
          if (primaryHex) {
            var c = variantColorOption(v);
            if (c && c.hex !== primaryHex) return false;
          }
          for (var i = 0; i < otherAxisVals.length; i++) {
            var oth = otherAxisVals[i];
            if (oth.want != null && _variantAxisValue(v, oth.ax) !== oth.want) return false;
          }
          return true;
        });
        if (!pool.length) {
          // Loosen: same axis value only.
          pool = variants.filter(function(v) { return _variantAxisValue(v, axisDef) === value; });
        }
        if (pool.length) _selectInModal(pool[0].id);
      }

      // Read whichever option key carries a size value. Most providers
      // use lower-case "size"; a handful use "Size" or other casings,
      // and a few products (mug 15oz) only have a single variant with
      // no size key at all — _variantSize returns null in that case.
      function _variantSize(v) {
        if (!v || !v.options) return null;
        var keys = Object.keys(v.options);
        for (var i = 0; i < keys.length; i++) {
          if (/^size$/i.test(keys[i])) {
            var val = v.options[keys[i]];
            if (val != null && val !== "") return String(val);
          }
        }
        return null;
      }

      // Build the size-chip row. Ordered S → M → L → XL → 2XL → 3XL …
      // by parsing common size tokens; anything that doesn't match
      // falls back to original catalog order.
      var _SIZE_ORDER_HINT = {
        "xxs": 0, "xs": 1, "s": 2, "small": 2, "m": 3, "medium": 3,
        "l": 4, "large": 4, "xl": 5, "2xl": 6, "xxl": 6, "3xl": 7, "xxxl": 7,
        "4xl": 8, "5xl": 9, "6xl": 10,
      };
      function _sizeSortKey(label, fallbackIdx) {
        var s = String(label || "").toLowerCase().trim();
        if (_SIZE_ORDER_HINT[s] != null) return _SIZE_ORDER_HINT[s];
        // "Size 10" / "10 oz" / "8 x 10" → try to peel off a leading number.
        var m = /^(\d+)/.exec(s);
        if (m) return 100 + parseInt(m[1], 10);
        return 1000 + fallbackIdx;
      }

      function _renderSizeChips() {
        if (!sizeChipsEl) return;
        var variants = _variantsList();
        // Bucket variants by size string; preserve first-seen order so
        // unknown labels keep their original catalog ordering.
        var bucketsBySize = {};
        var orderedSizes = [];
        variants.forEach(function(v) {
          var sz = _variantSize(v);
          if (!sz) return;
          if (!bucketsBySize[sz]) {
            bucketsBySize[sz] = { variants: [], firstIdx: orderedSizes.length };
            orderedSizes.push(sz);
          }
          bucketsBySize[sz].variants.push(v);
        });
        if (orderedSizes.length < 2) {
          // Hide the row when only 0 or 1 sizes exist — nothing to pick.
          sizeChipsEl.classList.add("hidden");
          sizeChipsEl.innerHTML = "";
          return;
        }
        // Stable-sort with the hint table.
        orderedSizes.sort(function(a, b) {
          return _sizeSortKey(a, bucketsBySize[a].firstIdx) - _sizeSortKey(b, bucketsBySize[b].firstIdx);
        });

        var activeVariant = variants.find(function(v) { return v.id === pendingVariantId; });
        var activeSize = _variantSize(activeVariant);
        var activeColor = activeVariant && variantColorOption(activeVariant);
        var activeHex = activeColor && activeColor.hex;

        var html = "";
        orderedSizes.forEach(function(sz) {
          var bucket = bucketsBySize[sz];
          var isActive = (sz === activeSize) ? " active" : "";
          // Mark unavailable if the active colour doesn't ship in this size.
          var unavailable = false;
          if (activeHex) {
            unavailable = !bucket.variants.some(function(v) {
              var c = variantColorOption(v);
              return c && c.hex === activeHex;
            });
          }
          html += '<button type="button" role="option" class="confirm-size-chip' + isActive + '"' +
                  ' data-size="' + escapeHtmlSimple(sz) + '"' +
                  (unavailable ? ' data-unavailable="true"' : '') +
                  ' title="' + escapeHtmlSimple(sz) + (unavailable ? " (not in this colour)" : "") + '">' +
                  escapeHtmlSimple(sz) + '</button>';
        });
        sizeChipsEl.innerHTML = html;
        sizeChipsEl.classList.remove("hidden");
      }

      function _onSizeChipClick(size) {
        var variants = _variantsList();
        // Match the active colour where possible; otherwise pick any
        // variant with the chosen size.
        var current = variants.find(function(v) { return v.id === pendingVariantId; });
        var currentColor = current && variantColorOption(current);
        var currentHex = currentColor && currentColor.hex;
        var pool = variants.filter(function(v) { return _variantSize(v) === size; });
        if (!pool.length) return;
        var pick = currentHex
          ? pool.find(function(v) {
              var c = variantColorOption(v);
              return c && c.hex === currentHex;
            }) || pool[0]
          : pool[0];
        _selectInModal(pick.id);
      }

      function _renderTiles() {
        var variants = _variantsList();
        if (!variants.length) {
          listEl.innerHTML = '<div class="confirm-variant-empty">No variant info available</div>';
          return;
        }
        if (!variants.find(function(v) { return v.id === pendingVariantId; })) {
          pendingVariantId = variants[0].id;
        }
        var html = "";
        // Round products read as "diameter", everything else reads "tall".
        // Printify's clock variants are square print areas (1:1) so width
        // and height converge — the user-facing word matters, not the math.
        // Honors printShape so user-requested round products get the
        // right label too.
        var isRound = (product.id === "wall_clock") || (product && product.printShape === "circle");
        variants.forEach(function(v) {
          var label = variantLabel(v);
          var price = _priceForVariant(v);
          var dims = getVariantPrintDims(v);
          var dimSuffix = isRound ? '" diameter' : '" tall';
          var heightText = dims ? dims.heightIn.toFixed(1) + dimSuffix : "";
          var isActive = (v.id === pendingVariantId);
          var tooltip = label + (price ? " — " + price : "") + (dims ? " — " + dims.widthIn.toFixed(1) + '" × ' + dims.heightIn.toFixed(1) + '"' : "");
          html +=
            '<button type="button" role="option"' +
              ' class="confirm-variant-tile' + (isActive ? ' active' : '') + '"' +
              ' aria-selected="' + (isActive ? "true" : "false") + '"' +
              ' data-variant-id="' + v.id + '"' +
              ' title="' + escapeHtmlSimple(tooltip) + '">' +
              '<span class="confirm-variant-tile-label">' + escapeHtmlSimple(label) + '</span>' +
              (price ? '<span class="confirm-variant-tile-price">' + escapeHtmlSimple(price) + '</span>' : '') +
              (heightText ? '<span class="confirm-variant-tile-dims">' + escapeHtmlSimple(heightText) + '</span>' : '') +
            '</button>';
        });
        listEl.innerHTML = html;
        var active = listEl.querySelector(".confirm-variant-tile.active");
        if (active && active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
      }
      // Decide how many real variant axes this product has, then render
      // ONLY the selector(s) that fit — never two controls for the same
      // choice (the redundancy beta testers hit on single-axis products
      // like photo tiles, where size-chips duplicated the variant grid).
      //   • 2 axes (colour × size, e.g. shirts): compose via swatches +
      //     size-chips; hide the full variant grid (it'd be a big
      //     colour×size wall that the two selectors already cover).
      //   • ≤1 axis (size-only tiles/prints, colour-only, single variant):
      //     the rich variant tiles ARE the selector; hide chips + swatches.
      function _axisInfo() {
        var variants = _variantsList();
        var colors = {}, sizes = {};
        variants.forEach(function(v) {
          var c = variantColorOption(v);
          if (c && c.hex) colors[c.hex] = 1;
          var s = _variantSize(v);
          if (s) sizes[s] = 1;
        });
        var nColors = Object.keys(colors).length;
        var nSizes = Object.keys(sizes).length;
        return { twoAxis: (nColors > 1 && nSizes > 1) };
      }
      function _renderSelectors() {
        // Multi-colour-axis products (e.g. wall clock: base × hands) get
        // one swatch row per axis, composing the selection. The variant
        // grid is hidden so the modal stays compact.
        if (product.colorAxes && product.colorAxes.length) {
          _twoAxis = true; // suppress the "re-render chips on swatch click" path
          _renderColorSwatches();
          _renderAllExtraAxes();
          if (sizeChipsEl) { sizeChipsEl.innerHTML = ""; sizeChipsEl.classList.add("hidden"); }
          if (listEl) { listEl.innerHTML = ""; listEl.classList.add("hidden"); }
          return;
        }
        _twoAxis = _axisInfo().twoAxis;
        if (_twoAxis) {
          _renderColorSwatches();
          _renderSizeChips();
          // Hide the redundant full variant grid.
          if (listEl) { listEl.innerHTML = ""; listEl.classList.add("hidden"); }
          var _xa = document.getElementById("confirmSelectExtraAxes");
          if (_xa) _xa.innerHTML = "";
        } else {
          if (listEl) listEl.classList.remove("hidden");
          _renderTiles();
          if (swatchesEl) { swatchesEl.innerHTML = ""; swatchesEl.classList.add("hidden"); }
          if (sizeChipsEl) { sizeChipsEl.innerHTML = ""; sizeChipsEl.classList.add("hidden"); }
          if (colorLabelEl) { colorLabelEl.classList.add("hidden"); colorLabelEl.textContent = ""; }
          var _xa2 = document.getElementById("confirmSelectExtraAxes");
          if (_xa2) _xa2.innerHTML = "";
        }
      }
      function _refreshAfterPricing() {
        // Re-render the active selector(s) + summary so the real Printify
        // cost replaces the placeholder "From $X.XX" label.
        _renderSelectors();
        var variants = _variantsList();
        var v = variants.find(function(x) { return x.id === pendingVariantId; });
        _renderSummary(v || null);
      }
      function _bootstrap() {
        // Variants AND per-variant pricing are needed for the full picker.
        // Variants are fast (catalog API), pricing is slower (must scan shop
        // products on cold cache). Show variants as soon as they arrive so
        // the user can interact, then re-render the price labels in place
        // when pricing lands.
        if (variantCache[cacheKey]) {
          _renderSelectors();
          _selectInModal(pendingVariantId);
        } else {
          listEl.innerHTML = '<div class="confirm-variant-loading"><div class="spinner" style="width:16px;height:16px;display:inline-block;vertical-align:-3px;margin-right:6px;"></div> Loading sizes &amp; colors…</div>';
          if (swatchesEl) swatchesEl.classList.add("hidden");
          if (sizeChipsEl) sizeChipsEl.classList.add("hidden");
          _renderSummary(null);
          _renderMockup(null);
          loadVariants(product).then(function() {
            _renderSelectors();
            var variants = _variantsList();
            var first = variants.find(function(v) { return v.id === pendingVariantId; }) || variants[0];
            if (first) _selectInModal(first.id);
            else _renderSummary(null);
          }).catch(function() {
            listEl.innerHTML = '<div class="confirm-variant-empty">Could not load variants. Try again in a moment.</div>';
          });
        }
        // Pricing fetch runs in parallel — refresh tiles when it lands.
        loadVariantPricing(product).then(function() {
          if (modal.classList.contains("hidden")) return; // user closed already
          _refreshAfterPricing();
        });
      }

      // Focus trap — installed at modal open below, released here.
      // The released() function restores focus to whatever was
      // focused before the modal opened so the page reads naturally
      // to keyboard / screen-reader users.
      var _releaseFocusTrap = null;
      function _close(restoreState) {
        modal.classList.add("hidden");
        if (restoreState) {
          if (originalVariantId == null) delete state.selectedVariantByProduct[product.id];
          else state.selectedVariantByProduct[product.id] = originalVariantId;
          if (originalAR == null) delete state.variantAspectRatioByProduct[product.id];
          else state.variantAspectRatioByProduct[product.id] = originalAR;
          state.cropZoom = originalCropZoom;
        }
        listEl.removeEventListener("click", onListClick);
        if (swatchesEl) swatchesEl.removeEventListener("click", onSwatchClick);
        if (sizeChipsEl) sizeChipsEl.removeEventListener("click", onSizeChipClick);
        modal.removeEventListener("click", onExtraAxisClick);
        continueBtn.removeEventListener("click", onContinueClick);
        closeBtn.removeEventListener("click", onCancel);
        backdrop.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey);
        if (_releaseFocusTrap) { _releaseFocusTrap(); _releaseFocusTrap = null; }
      }
      function onCancel() { _close(true); }
      function onContinueClick() {
        // Commit the picker's pending variant. selectedVariantByProduct is
        // already set; clear pending and reset _close so it doesn't restore.
        state.selectedVariantByProduct[product.id] = pendingVariantId;
        state.pendingVariantByProduct[product.id] = undefined;
        _close(false);
        if (onContinue) onContinue();
        // (Data-credits popup now fires from commitProductSelection — the
        // single editor-entry chokepoint — so it covers the mug colour
        // chooser path too. No need to trigger it here.)
      }
      function onListClick(e) {
        var tile = e.target.closest(".confirm-variant-tile");
        if (!tile) return;
        e.preventDefault();
        _selectInModal(parseInt(tile.dataset.variantId, 10));
      }
      function onSwatchClick(e) {
        var sw = e.target.closest(".confirm-color-swatch");
        if (!sw) return;
        e.preventDefault();
        _onSwatchClick(sw.dataset.hex);
      }
      function onSizeChipClick(e) {
        var chip = e.target.closest(".confirm-size-chip");
        if (!chip) return;
        e.preventDefault();
        _onSizeChipClick(chip.dataset.size);
      }
      // Delegated click handler for extra colour-axis swatches (the
      // wall-clock "Hand color" row, etc.). Each swatch carries
      // data-axis-value; its row carries data-axis-key.
      function onExtraAxisClick(e) {
        var sw = e.target.closest(".confirm-color-swatch[data-axis-value]");
        if (!sw) return;
        var row = sw.closest("[data-axis-key]");
        if (!row) return;
        e.preventDefault();
        _onExtraAxisClick(row.dataset.axisKey, sw.dataset.axisValue);
      }
      function onKey(e) {
        if (e.key === "Escape") onCancel();
        else if (e.key === "Enter") { e.preventDefault(); onContinueClick(); }
      }

      listEl.addEventListener("click", onListClick);
      if (swatchesEl) swatchesEl.addEventListener("click", onSwatchClick);
      if (sizeChipsEl) sizeChipsEl.addEventListener("click", onSizeChipClick);
      // Delegated listener for extra-axis swatches (clock hands, etc.).
      // Bound to the modal panel so it covers the dynamically-injected
      // confirmSelectExtraAxes container.
      modal.addEventListener("click", onExtraAxisClick);
      continueBtn.addEventListener("click", onContinueClick);
      closeBtn.addEventListener("click", onCancel);
      backdrop.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);

      modal.classList.remove("hidden");
      _bootstrap();
      // Focus trap: Tab cycles within the modal, Escape dismisses,
      // and the previously-focused element is restored on close.
      // installModalFocusTrap already handles touch-device skip and
      // first-element focus, so we don't need the separate
      // continueBtn.focus() timeout below for the keyboard path.
      _releaseFocusTrap = installModalFocusTrap(modal, { onEscape: onCancel });
      // Embedded mode (Shopify iframe): the modal renders inline in
      // document flow rather than overlaying the viewport. Scroll
      // the user to it so they land on the picker instead of being
      // left where they were on the outer page.
      if (document.documentElement.classList.contains("embedded")) {
        try { modal.scrollIntoView({ behavior: "smooth", block: "start" }); }
        catch (_e) { modal.scrollIntoView(); }
      }
      // Continue button focus on desktop is the convenience landing
      // — the focus trap already focuses the first focusable
      // (typically the close-X), but for desktop UX we'd prefer the
      // user's Enter to commit the picker. Override.
      var _isTouch = ('ontouchstart' in window) ||
                     (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
      if (!_isTouch) {
        setTimeout(function() { continueBtn.focus(); }, 40);
      }
    }

    function escapeHtmlSimple(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // ───────────────────────────────────────────────────────────────
    // Feedback widget — moved to ./feedback.js as step 5 of the
    // module split. The widget is self-contained (zero state.X
    // reads), so the extraction is a thin deps-injection wrapper:
    // the five helpers it borrows from this file are passed in via
    // setupFeedback({…}). When those helpers themselves migrate to
    // modules, the import path here changes but the contract stays.
    // ───────────────────────────────────────────────────────────────
    setupFeedback({
      installModalFocusTrap: installModalFocusTrap,
      addToSessionCatalog:   addToSessionCatalog,
      makeProductFromRequest: makeProductFromRequest,
      renderProducts:        renderProducts,
      showToast:             showToast,
    });
