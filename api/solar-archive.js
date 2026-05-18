/* ===============================================================
   Solar Archive — Poe Canvas App
   =============================================================== */
   (function () {
    "use strict";

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
      SDO_ACK: "Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams.",
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
    window.addEventListener("popstate", function() {
      var ed = document.getElementById("editSection");
      // If the editor is visible, treat back as "close the editor."
      if (ed && !ed.classList.contains("hidden")) {
        ed.classList.add("hidden");
        var ps = document.getElementById("productSection");
        if (ps) {
          try { ps.scrollIntoView({ behavior: "smooth", block: "start" }); }
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
      // and fonts settle), on every body resize (ResizeObserver
      // catches modal opens, tab expansions, etc.), and on a slow
      // safety-net interval for things observer can miss (animated
      // transitions, image decode completing after layout).
      document.addEventListener("DOMContentLoaded", _postIframeHeight);
      window.addEventListener("load", _postIframeHeight);
      window.addEventListener("resize", _postIframeHeight);
      if (typeof ResizeObserver !== "undefined") {
        try {
          var _saResizeObs = new ResizeObserver(_postIframeHeight);
          _saResizeObs.observe(document.body);
          _saResizeObs.observe(document.documentElement);
        } catch (_e) { /* old browser; safety-net interval still runs */ }
      }
      // 800ms safety net — cheap and catches anything missed above.
      setInterval(_postIframeHeight, 800);
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
    //         f.contentWindow.postMessage({
    //           source: "solar-archive-parent",
    //           type: "viewport",
    //           visibleBottomInIframe: visibleBottomInIframe
    //         }, "*");
    //       });
    //     }
    //     window.addEventListener("scroll", _saSendViewport, { passive: true });
    //     window.addEventListener("resize", _saSendViewport);
    //     document.addEventListener("DOMContentLoaded", _saSendViewport);
    //   </script>
    //
    // Without the parent listener the FAB falls back to whatever its
    // CSS rule provides — same iframe behaviour as today.
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
    if (document.documentElement.classList.contains("embedded")) {
      window.addEventListener("message", function(e) {
        if (PARENT_ORIGIN_ALLOWLIST.indexOf(e.origin) === -1) return;
        if (!e.data || e.data.source !== "solar-archive-parent") return;
        if (e.data.type !== "viewport") return;
        var fab = document.getElementById("feedbackFabGroup");
        if (!fab) return;
        var vis = e.data.visibleBottomInIframe;
        if (typeof vis !== "number" || !isFinite(vis)) return;
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
      });
    }

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

    // ── State ────────────────────────────────────────────────────
    var state = {
      wavelength: 171,
      originalImage: null,
      editedImageData: null,
      brightness: 0,
      contrast: 0,
      saturation: 100,
      hue: 0,            // degrees, -180..+180; 0 = no rotation
      rotation: 0,
      flipH: false,
      flipV: false,
      inverted: false,
      cropping: false,
      cropStart: null,
      cropEnd: null,
      cropRatio: "1:1",
      cropZoom: 100,
      panX: 0,
      panY: 0,
      selectedProduct: null,
      hqReady: false,
      lastImageUrl: "",
      backendOnline: false,
      vignette: 24,
      vignetteWidth: 0,
      vignetteFade: "black",         // "transparent" | "black" | "white" | "mode" | "custom"
      vignetteFadeColor: "#000000",
      // Crop-edge feather is now split per-axis so users can soften the
      // left/right edges independently of the top/bottom (e.g. a wide
      // mug strip wants strong horizontal feather but minimal vertical).
      // 0–100 each; the SVG mask's feGaussianBlur takes "X Y" as
      // stdDeviation, so two channels map cleanly into one filter.
      cropEdgeFeatherX: 0,
      cropEdgeFeatherY: 0,
      textMode: false,
      hqImageUrl: null,   // URL of completed HQ PNG (separate from originalImage)
      hqTaskId: null,     // running HQ background task ID
      textOverlay: null,  // { text, x, y, size, font, color, strokeColor, strokeWidth }
      // Caption stamp (Tools → Timestamp). Just an on/off flag; the
      // displayed text is composed at render time from the active date,
      // noon UTC (matches the FITS/JPG fetch time), and wavelength.
      timestampStamp: false,
      // 2×3 grid: "top|bottom" + "-" + "left|center|right". Default to
      // bottom-right so the original placement is preserved.
      timestampPos: "bottom-right",
      // Pixel-fraction offset from the chosen vertical anchor, 0..100 →
      // 0..30% of the canvas's shorter dimension. Lets users nudge the
      // caption inward when it gets clipped by a corona / mockup bezel.
      timestampVOffset: 0,
      clockNumbers: null, // wall_clock only: { font, color, strokeColor, strokeWidth, size, radiusPct }
      mockups: {},         // { productId: { images: [{src, position, is_default}], printifyProductId } }
      uploadedPrintifyId: null,  // reusable image ID from Printify upload
      editorFilter: "jpg",       // "jpg" | "raw" | "rhef" — preview only; HQ is separate button
      jpgImage: null,            // JPG = Helioviewer-derived from backend; distinct from raw and RHEF
      rhefImage: null,            // RHE-processed preview image
      rawBackendImage: null,     // backend raw preview (no RHEF) for toggling with rhefImage
      rhefFetching: false,       // true while background RHEF fetch is in-flight
      rhefFetchPromise: null,    // Promise for in-flight RHEF fetch (deduplication)
      hqFilterImage: null,       // loaded HQ full-res Image object
      hqFormat: null,            // "jpg" | "raw" | "rhef" — which format the current hqFilterImage is
      hqFetching: false,         // true while HQ generation is in progress
      mockupsRaw: {},            // cached mockups for raw version
      mockupsFiltered: {},       // cached mockups for filtered (RHEF/HQ) version
      uploadedPrintifyIdRaw: null,      // Printify upload ID for raw canvas
      uploadedPrintifyIdFiltered: null, // Printify upload ID for filtered canvas
      transitionInProgress: false,      // prevents toggle spam during wipe animation
      selectedVariantByProduct: {},    // productId -> variantId (user-confirmed)
      pendingVariantByProduct: {},     // productId -> variantId (first click, not yet confirmed)
      variantAspectRatioByProduct: {}, // productId -> { w, h } parsed from selected variant
      aspectFlippedByProduct: {},      // productId -> bool: user manually swapped w↔h
      // Layout mode for dual-panel products (throw_pillow, journal_hardcover).
      // "match" → editor canvas = single face, uploaded PNG is two copies
      //           concatenated horizontally (front = back).
      // "span"  → editor canvas = full panel aspect (front + back as one
      //           continuous design; sun-center can land on the seam).
      // Missing entry defaults to "match" so first-time users get the
      // safer "same on both sides" behaviour.
      dualPanelModeByProduct: {},      // productId -> "match" | "span"
      mockupSlideIndex: {},            // productId -> current slide index in mockup slideshow
      showOverlay: true,               // draw orange frame border on canvas
      showGuides: false                // draw centre-line / spine guide lines on canvas
    };

    // ── Product catalog (Printify blueprint/provider/variant model) ──
    // IDs are pre-resolved from the live Printify catalog.
    // blueprintId = product type, printProviderId = fulfiller,
    // variantId = default size/color (customer picks final variant on Shopify).
    //
    // previewView controls how each gallery mockup frames the shared source
    // image (state.originalImage) so every card shows a distinct subset:
    //   - zoom >1 tightens the crop (detail view), <1 shows more breathing room
    //   - cx, cy (0..1) offset the center of the source rect — tweak these so
    //     different products look visually different even when aspect matches
    // The selected product in the editor keeps using the live solarCanvas so
    // user edits are reflected; non-selected gallery cards use this preset.
    // Aspect ratios are taken from each blueprint's actual print-panel
    // dimensions (queried from the Printify catalog), not arbitrary
    // declared aspects. parseVariantAspectRatio overrides per-variant
    // when a variant title encodes WxH (e.g. canvas 12"×16"); the
    // product default below is the panel aspect for the variantId
    // shown here, so canvas + upload + Printify panel all agree even
    // before variants finish loading.
    var PRODUCTS = [
      // ── Wall Art & Home Decor ──
      { id: "canvas_stretched",     name: "Stretched Canvas",    desc: "Gallery-wrapped canvas, 1.25\" bars",       icon: "fa-palette",      price: "From $29.99", checkoutPrice: 2999, blueprintId: 555,  printProviderId: 69,  variantId: 70880, position: "front", aspectRatio: { w: 2400, h: 3000 } },
      { id: "metal_sign",           name: "Metal Art Sign",      desc: "Vibrant aluminum print, ready to hang",     icon: "fa-shield-alt",   price: "From $24.99", checkoutPrice: 2499, blueprintId: 1206, printProviderId: 228, variantId: 91993, position: "front", aspectRatio: { w: 2250, h: 1650 } },
      { id: "acrylic_print",        name: "Acrylic Wall Art",    desc: "High-gloss acrylic panel with standoffs",   icon: "fa-gem",          price: "From $34.99", checkoutPrice: 3499, blueprintId: 1098, printProviderId: 228, variantId: 82057, position: "front", aspectRatio: { w: 2250, h: 1650 } },
      { id: "poster_matte",         name: "Matte Poster",        desc: "Museum-quality matte paper, multiple sizes", icon: "fa-image",       price: "From $9.99",  checkoutPrice: 999,  blueprintId: 282,  printProviderId: 99,  variantId: 43135, position: "front", aspectRatio: { w: 11, h: 14 } },
      { id: "framed_poster",        name: "Framed Poster",       desc: "Ready-to-hang framed museum print",         icon: "fa-square",       price: "From $29.99", checkoutPrice: 2999, blueprintId: 492,  printProviderId: 36,  variantId: 65400, position: "front", aspectRatio: { w: 11, h: 14 } },
      { id: "wall_clock",           name: "Wall Clock",          desc: "Round acrylic clock — the Sun tells time",  icon: "fa-clock",        price: "From $29.99", checkoutPrice: 2999, blueprintId: 277,  printProviderId: 1,   variantId: 43008, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "tapestry",             name: "Wall Tapestry",       desc: "Large-format indoor wall hanging",          icon: "fa-scroll",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 241,  printProviderId: 10,  variantId: 41686, position: "front", aspectRatio: { w: 4350, h: 5850 } },
      // ── Drinkware ──
      // NOTE: Printify splits mug color across separate blueprints rather than
      // exposing color as a variant. White lives at BP 425; black lives at BP 1152.
      // Both are listed so the gallery carries both options.
      { id: "mug_15oz",             name: "Ceramic Mug — 15oz (White)", desc: "Large white ceramic mug, full-wrap print", icon: "fa-mug-hot", price: "From $14.99", checkoutPrice: 1499, blueprintId: 425,  printProviderId: 1,   variantId: 62014, position: "front", aspectRatio: { w: 2790, h: 1219 } },
      { id: "mug_15oz_black",       name: "Ceramic Mug — 15oz (Black)", desc: "Large black ceramic mug, full-wrap print", icon: "fa-mug-hot", price: "From $14.99", checkoutPrice: 1499, blueprintId: 1152, printProviderId: 28,  variantId: 88132, position: "front", aspectRatio: { w: 2448, h: 1266 } },
      // Tumbler print panel is 2795×2100 (~4:3 landscape), not the rolled-out
      // 2:1 we used to advertise. The mug-15oz-white panel is closer to 2:1
      // (genuine full-wrap) but the tumbler's panel reflects a single-side
      // print area shaped like the cup face.
      { id: "tumbler_20oz",         name: "Tumbler — 20oz",      desc: "Insulated stainless steel with lid",        icon: "fa-glass-whiskey", price: "From $19.99", checkoutPrice: 1999, blueprintId: 353,  printProviderId: 1,   variantId: 44519, position: "front", aspectRatio: { w: 2795, h: 2100 } },
      // ── Apparel ──
      // T-shirt/hoodie/crewneck DTG print area is 3319×3761 (slightly
      // taller than wide). All three share the same panel because
      // they use provider 29 (Monster Digital) with a single DTG
      // press; only the garment template differs.
      { id: "tshirt_unisex",        name: "Unisex T-Shirt",      desc: "Bella+Canvas 3001 jersey tee, DTG print",   icon: "fa-tshirt",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 12,   printProviderId: 29,  variantId: 18052, position: "front", aspectRatio: { w: 3319, h: 3761 },
        variantFilter: { sizes: ["XS","S","M","L","XL","2XL","3XL"], colors: ["Black","White","Navy","Forest Green","Dark Heather","Athletic Heather","True Royal","Maroon","Red","Military Green"] } },
      { id: "hoodie_pullover",      name: "Pullover Hoodie",     desc: "Unisex heavy blend hooded sweatshirt",      icon: "fa-mitten",       price: "From $39.99", checkoutPrice: 3999, blueprintId: 77,   printProviderId: 29,  variantId: 32878, position: "front", aspectRatio: { w: 3319, h: 3761 },
        variantFilter: { sizes: ["S","M","L","XL","2XL","3XL"], colors: ["Black","White","Navy","Dark Heather","Sport Grey","Maroon","Forest Green","Military Green"] } },
      { id: "crewneck_sweatshirt",  name: "Crewneck Sweatshirt", desc: "Unisex heavy blend crewneck",               icon: "fa-vest",         price: "From $34.99", checkoutPrice: 3499, blueprintId: 49,   printProviderId: 29,  variantId: 25377, position: "front", aspectRatio: { w: 3319, h: 3761 },
        variantFilter: { sizes: ["S","M","L","XL","2XL","3XL"], colors: ["Black","White","Navy","Dark Heather","Sport Grey","Maroon","Forest Green"] } },
      // Crew socks blueprint requires four 1358×3839 leg-panel placeholders
      // (front_left_leg, front_right_leg, back_left_leg, back_right_leg).
      // The editor canvas mirrors the panel aspect — the same image is
      // sent to all four panels, so the design has to look right within
      // the tall narrow rectangle. initialCropZoom of 136 zooms in to the
      // largest sock-aspect rectangle that fits inside the solar disk
      // (formula in selectProductCard): the full disk doesn't fit in a
      // 1:2.83 panel, but a slice through it does, and looks like an
      // intentional close-up rather than letterboxed white space.
      { id: "crew_socks",           name: "Crew Socks",          desc: "All-over sublimation print socks",          icon: "fa-socks",        price: "From $14.99", checkoutPrice: 1499, blueprintId: 365,  printProviderId: 14,  variantId: 44904, position: "front", aspectRatio: { w: 1358, h: 3839 }, initialCropZoom: 136,
        variantFilter: { sizes: ["S","M","L","XS","XL","2XL"] } },
      // ── Tech & Desk ──
      // Blueprint 269 / provider 1 (SPOKE) covers iPhone 11–17 and Samsung Galaxy S21–S25.
      // Google Pixel cases require blueprint 421 / provider 23 (WOYC) — a separate product
      // entry can be added once that blueprint's checkout flow is verified.
      { id: "phone_case",           name: "Phone Case",          desc: "Tough snap case — iPhone & Samsung",        icon: "fa-mobile-alt",   price: "From $19.99", checkoutPrice: 1999, blueprintId: 269,  printProviderId: 1,   variantId: 62582, position: "front", aspectRatio: { w: 1290, h: 2160 } },
      // Pixel Phone Case — blueprint 421, provider 23 (WOYC). Uncomment and verify variant IDs
      // before enabling.  Pixel 7/8/8a/9/9 Pro confirmed on WOYC catalog.
      // { id: "phone_case_pixel", name: "Phone Case (Pixel)", desc: "Tough snap case — Google Pixel", icon: "fa-mobile-alt", price: "From $19.99", checkoutPrice: 1999, blueprintId: 421, printProviderId: 23, variantId: null, position: "front", aspectRatio: { w: 9, h: 19 } },
      { id: "laptop_sleeve",        name: "Laptop Sleeve",       desc: "Padded neoprene sleeve, snug fit",          icon: "fa-laptop",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 429,  printProviderId: 1,   variantId: 62037, position: "front", aspectRatio: { w: 4, h: 3 } },
      // Mouse pad's physical print area is a circle, not a square. Same treatment
      // as wall_clock — round frame border in the editor, circular clip on the
      // canvas, and a circular preview in the mockup pane.
      { id: "mouse_pad",            name: "Mouse Pad",           desc: "Non-slip rubber base, smooth fabric top",   icon: "fa-mouse",        price: "From $11.99", checkoutPrice: 1199, blueprintId: 582,  printProviderId: 99,  variantId: 71665, position: "front", aspectRatio: { w: 1, h: 1 }, printShape: "circle" },
      { id: "desk_mat",             name: "Desk Mat",            desc: "Large-format mat for your workspace",       icon: "fa-desktop",      price: "From $24.99", checkoutPrice: 2499, blueprintId: 488,  printProviderId: 1,   variantId: 65240, position: "front", aspectRatio: { w: 5610, h: 3839 }, forceOrientation: "landscape" },
      // ── Home & Living ──
      // throw_pillow + journal_hardcover are "dual-panel" products: the
      // Printify print area is a two-face wraparound (front + back on
      // the pillow; back-cover + spine + front-cover on the journal),
      // but the user designs against one face. The editor canvas uses
      // aspectRatio (the single-face shape). At upload, layoutMode
      // controls how the canvas maps onto the panel:
      //   • "match"  → render canvas, duplicate horizontally, upload
      //                a panelAspectRatio PNG — same design on both
      //                sides (default; safest for a glance-test)
      //   • "span"   → editor canvas becomes the full panel aspect so
      //                the design can intentionally bridge front+back
      //                (sun-center on the spine, etc.)
      // dualPanelToggle UI sits in the preview pane.
      { id: "throw_pillow",         name: "Throw Pillow",        desc: "Spun polyester square pillow with insert",  icon: "fa-couch",        price: "From $22.99", checkoutPrice: 2299, blueprintId: 220,  printProviderId: 10,  variantId: 41521, position: "front", aspectRatio: { w: 1, h: 1 }, dualPanel: true, panelAspectRatio: { w: 4650, h: 2325 } },
      { id: "sherpa_blanket",       name: "Sherpa Blanket",      desc: "Ultra-soft fleece with sherpa backing",     icon: "fa-cloud",        price: "From $44.99", checkoutPrice: 4499, blueprintId: 238,  printProviderId: 99,  variantId: 41656, position: "front", aspectRatio: { w: 7875, h: 9375 } },
      { id: "shower_curtain",       name: "Shower Curtain",      desc: "Polyester shower curtain, vibrant print",   icon: "fa-shower",       price: "From $34.99", checkoutPrice: 3499, blueprintId: 235,  printProviderId: 10,  variantId: 41653, position: "front", aspectRatio: { w: 7104, h: 7392 } },
      { id: "puzzle_1000",          name: "Jigsaw Puzzle",       desc: "252-piece puzzle in a tin box",             icon: "fa-puzzle-piece",  price: "From $24.99", checkoutPrice: 2499, blueprintId: 532,  printProviderId: 59,  variantId: 68984, position: "front", aspectRatio: { w: 4200, h: 3300 } },
      { id: "coaster_set",          name: "Coaster Set",         desc: "4-pack corkwood coasters, glossy top",      icon: "fa-circle",       price: "From $14.99", checkoutPrice: 1499, blueprintId: 510,  printProviderId: 48,  variantId: 72872, position: "front", aspectRatio: { w: 1, h: 1 } },
      // ── Accessories & Stationery ──
      { id: "sticker_kiss",         name: "Kiss-Cut Stickers",   desc: "Die-cut vinyl stickers, multiple sizes",    icon: "fa-sticky-note",  price: "From $2.99",  checkoutPrice: 299,  blueprintId: 400,  printProviderId: 99,  variantId: 45748, position: "front", aspectRatio: { w: 1, h: 1 },
        sizePricing: { 45748: "$2.99", 45750: "$3.99", 45752: "$4.99", 45754: "$7.99" } },
      // Hardcover journal panel is 4065×2850 — back cover + spine +
      // front cover laid flat. Editor canvas uses the single front-cover
      // aspect 2032×2850 (panel halved); dualPanel concatenation paints
      // the same design on both faces at upload. Spine is treated as
      // part of one face for simplicity (a slim slice of the design
      // shows on the spine).
      { id: "journal_hardcover",    name: "Hardcover Journal",   desc: "Matte hardcover, ruled pages",              icon: "fa-book",         price: "From $17.99", checkoutPrice: 1799, blueprintId: 485,  printProviderId: 28,  variantId: 65223, position: "front", aspectRatio: { w: 2032, h: 2850 }, dualPanel: true, panelAspectRatio: { w: 4065, h: 2850 } },
      // Backpack disabled — it's an all-over print with seven separate
      // placeholders (front, back, left/right side, top-to-front, top-to-
      // back, front pocket, pocket flap). Each panel needs its own design
      // crop, so one editor canvas can't represent the product faithfully.
      // Re-enable once we have a panel-picker UI to drive multi-placeholder
      // products.
      // { id: "backpack",             name: "Backpack",            desc: "All-over print, padded straps",             icon: "fa-bag-shopping", price: "From $44.99", checkoutPrice: 4499, blueprintId: 347,  printProviderId: 14,  variantId: 44419, position: "front", aspectRatio: null }
    ];

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
          try { wlGrid.scrollIntoView({ behavior: "smooth", block: "start" }); }
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
      // Always use a square 260×260 canvas — the product shape drawn inside it communicates
      // the proportions without distorting the illustration by squashing the canvas itself.
      var mockupContainer = previewPane.querySelector(".preview-mockup");
      var existing = mockupContainer.querySelector("canvas.live-preview-canvas");
      var pw = 260;
      var ph = 260;
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

        if (labelEl) labelEl.textContent = "Reset to mock mockup";
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
        if (productSection) productSection.scrollIntoView({ behavior: "smooth", block: "start" });
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
        if (productSec) productSec.scrollIntoView({ behavior: "smooth", block: "start" });
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
                if (myToken === _mockupCallToken) {
                  _setMockupBtnLoading(false);
                  _unbusy();
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

      if (!dateInput.value) {
        showToast("Select a date first", "error");
        return;
      }

      // Request a scroll to the product section once it becomes visible.
      // If it's already visible (subsequent tile clicks), scroll immediately.
      // If it's still hidden (first load), set a flag so _installPreviewImage scrolls after revealing it.
      var productSectionEl = document.getElementById("productSection");
      if (productSectionEl && !productSectionEl.classList.contains("hidden")) {
        productSectionEl.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        state.scrollToProductsOnLoad = true;
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
        productSection.scrollIntoView({ behavior: "smooth", block: "start" });
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
          editSection.scrollIntoView({ behavior: "smooth", block: "start" });
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
        var proxyUrl256 = API_BASE
          ? API_BASE + "/api/helioviewer_thumb?date=" +
              encodeURIComponent(isoDate) + "&wavelength=" + wl + "&image_scale=12&size=256"
          : null;

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
              var maxAttempts = 60; // 2 min at 1.5s intervals
              var POLL_PER_REQUEST_TIMEOUT_MS = 15000;
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
                        if (attempts >= maxAttempts) reject(new Error("RHE preview timed out after 2 minutes"));
                        else setTimeout(poll, 1500);
                        return;
                      }
                      reject(new Error(d.error || "No VSO data for this date"));
                      return;
                    }
                    attempts++;
                    if (attempts >= maxAttempts) reject(new Error("RHE preview timed out after 2 minutes"));
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
                      if (attempts >= maxAttempts) {
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

    // Load thumbnails on date change and on initial page load
    if (dateInput) {
      dateInput.addEventListener("change", loadWavelengthThumbnails);
      dateInput.addEventListener("input", loadWavelengthThumbnails);
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
        var def = new Date();
        def.setDate(def.getDate() - 7);
        var yyyy = def.getFullYear();
        var mm = String(def.getMonth() + 1).padStart(2, "0");
        var dd = String(def.getDate()).padStart(2, "0");
        dateInput.value = yyyy + "-" + mm + "-" + dd;
        // Fire change so the tile-loading pipeline runs immediately.
        dateInput.dispatchEvent(new Event("change", { bubbles: true }));
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

      // Update ARIA live region for screen readers
      var statusRegion = document.getElementById("statusRegion");
      if (statusRegion) statusRegion.textContent = msg;
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
      btn.addEventListener("click", function() {
        overlay.remove();
      });
      // Embedded mode: overlay is styled as an inline block (see CSS),
      // not a viewport-fixed overlay. Scroll the user to it so it
      // doesn't end up at the top of the iframe coordinate space far
      // above their current outer-page scroll position.
      if (document.documentElement.classList.contains("embedded")) {
        try { overlay.scrollIntoView({ behavior: "smooth", block: "center" }); }
        catch (_e) { overlay.scrollIntoView(); }
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

    // ── Data credits modal (footer link) ─────────────────────────
    // Surfaces the full attribution stack — NASA SDO rules-of-the-
    // road acknowledgement, AIA instrument paper (Lemen 2012), the
    // RHEF method paper (Gilly 2025), and the Helioviewer Project
    // credit (only used by the JPG-tier preview path). The footer
    // already carries the short SDO-team acknowledgement; this
    // expanded list is for users who want to cite the imagery
    // properly or verify the data provenance.
    (function() {
      var link = document.getElementById("dataCreditsLink");
      if (!link) return;
      link.addEventListener("click", function(e) {
        e.preventDefault();
        var html =
          '<div style="text-align:left;font-size:0.85rem;line-height:1.55;">' +
            '<p style="margin-bottom:10px;"><strong>Imagery</strong></p>' +
            '<p style="margin-bottom:10px;">' + CITATIONS.SDO_ACK + '</p>' +
            '<p style="margin-bottom:14px;color:var(--text-secondary);">Raw, RHEF, and HQ&nbsp;RHEF tiers use AIA FITS frames distributed through the Joint Science Operations Center (JSOC) at Stanford, accessed via the Virtual Solar Observatory (VSO). JPG previews are rendered by the Helioviewer Project.</p>' +
            '<p style="margin-bottom:6px;"><strong>Instrument</strong></p>' +
            '<p style="margin-bottom:14px;">' + CITATIONS.AIA_PAPER + '</p>' +
            '<p style="margin-bottom:6px;"><strong>RHEF method</strong></p>' +
            '<p style="margin-bottom:14px;">' + CITATIONS.RHEF_PAPER + '</p>' +
            '<p style="margin-bottom:6px;"><strong>JPG previews</strong></p>' +
            '<p style="margin-bottom:0;">' + CITATIONS.HELIOVIEWER_ACK + '</p>' +
          '</div>';
        // {html:true}: this modal body is fully developer-authored
        // and contains markup (paragraphs, strong, citation strings).
        showInfo("Data credits", html, { html: true });
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
        state.vignette = 24;
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
        $("#vignetteSlider").value = 100 - 24;
        $("#vigWidthSlider").value = 0;
        if ($("#cropEdgeXSlider")) { $("#cropEdgeXSlider").value = 0; $("#cropEdgeXVal").textContent = "0"; }
        if ($("#cropEdgeYSlider")) { $("#cropEdgeYSlider").value = 0; $("#cropEdgeYVal").textContent = "0"; }
        $("#brightnessVal").textContent = "0";
        $("#contrastVal").textContent = "0";
        $("#saturationVal").textContent = "100";
        $("#vignetteVal").textContent = "24";
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

    // ── Clean canvas snapshot (no editor overlays) ──────────────
    // solarCanvas is drawn with an orange frame border + optional guide lines
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
        solarCanvas ? solarCanvas.width : 0,
        solarCanvas ? solarCanvas.height : 0,
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
      if (!solarCanvas || solarCanvas.width === 0) return solarCanvas;
      var sig = _currentCanvasSig();
      if (_cleanSnapshotCanvas && _cleanSnapshotSig === sig
          && _cleanSnapshotCanvas.width === solarCanvas.width
          && _cleanSnapshotCanvas.height === solarCanvas.height) {
        return _cleanSnapshotCanvas;
      }
      var wasBurning = state._burningCanvas;
      state._burningCanvas = true;
      try { renderCanvas(); } catch (_e) {}
      if (!_cleanSnapshotCanvas) _cleanSnapshotCanvas = document.createElement("canvas");
      _cleanSnapshotCanvas.width = solarCanvas.width;
      _cleanSnapshotCanvas.height = solarCanvas.height;
      var cctx = _cleanSnapshotCanvas.getContext("2d");
      cctx.clearRect(0, 0, _cleanSnapshotCanvas.width, _cleanSnapshotCanvas.height);
      cctx.drawImage(solarCanvas, 0, 0);
      state._burningCanvas = wasBurning || false;
      try { renderCanvas(); } catch (_e) {}
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
      if (!solarCanvas) return null;
      var cw = solarCanvas.width;
      var ch = solarCanvas.height;
      if (cw === 0 || ch === 0) return null;
      return { x: 0, y: 0, w: cw, h: ch };
    }

    /**
     * Return the visible portion of solarCanvas for product mockups (same as crop box).
     * Returns { sx, sy, sw, sh } in canvas pixel coordinates.
     */
    function _getCropViewport() {
      var box = getCropBoxInCanvasCoords();
      if (!box) {
        var cw = solarCanvas ? solarCanvas.width : 0;
        var ch = solarCanvas ? solarCanvas.height : 0;
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
     */
    function _fitPrintRectToAR(maxW, maxH, ar) {
      if (!ar || !ar.w || !ar.h) return { w: maxW, h: maxH };
      var R = ar.w / ar.h;
      var w, h;
      if (R >= maxW / maxH) { w = maxW; h = maxW / R; }
      else                  { h = maxH; w = maxH * R; }
      return { w: Math.round(w), h: Math.round(h) };
    }

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

    function drawProductMockup(mctx, productId, sw, sh, variant) {
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
      var isSelected = (productId === state.selectedProduct);
      var sourceCanvas = null;
      var shareSrc = null;
      if (isSelected) {
        sourceCanvas = (typeof getCleanCanvasSnapshot === "function")
          ? getCleanCanvasSnapshot()
          : solarCanvas;
      } else {
        shareSrc = (typeof _getEditedSharedSource === "function")
          ? _getEditedSharedSource()
          : state.originalImage;
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
        var apparelTint = _variantColorOption(variant);
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
        mctx.fillStyle = "#fff";
        mctx.fillRect(pL, pT, pW, pH);
        drawCropped(pL + 5, pT + 5, pW - 10, pH - 10);
        if (productId === "framed_poster") {
          mctx.strokeStyle = "#333";
          mctx.lineWidth = 4;
          mctx.strokeRect(pL, pT, pW, pH);
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
        // Square-ish products
        var pilL = 18, pilT = 18, pilW = 124, pilH = 124;
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
        drawCropped(pilL, pilT, pilW, pilH);
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
        // Journal — double-width cover wrap (front + spine + back)
        var jL = 10, jT = 20, jW = 140, jH = 120, jR = 6;
        // Spine
        mctx.fillStyle = "#4a3728";
        mctx.fillRect(jL + jW / 2 - 3, jT, 6, jH);
        // Shadow
        mctx.fillStyle = "rgba(0,0,0,0.3)";
        mctx.fillRect(jL + 4, jT + 4, jW, jH);
        // Cover image
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
        drawCropped(jL, jT, jW, jH);
        mctx.restore();
        // Spine overlay
        mctx.fillStyle = "rgba(0,0,0,0.15)";
        mctx.fillRect(jL + jW / 2 - 2, jT, 4, jH);
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
    // Printify's catalog API names variant colours but doesn't expose
    // hex values — every product/provider names "navy blue" slightly
    // differently. This is a curated palette covering Printify's most
    // common apparel + accessory tokens, normalised to lowercase.
    // Used by:
    //   • drawProductMockup's apparel/accessory branches to paint the
    //     mock-mockup silhouette in the variant's actual colour
    //     instead of a generic grey.
    //   • The variant-picker swatch row, which shows one clickable
    //     square per distinct colour so users can browse by colour
    //     before drilling into sizes.
    var _PRINTIFY_COLOR_HEX = {
      "white": "#ffffff", "natural": "#f4ecd8", "ash": "#cdd0d4", "cream": "#efe5cb",
      "light blue": "#a6c5e0", "carolina blue": "#7ba4d9", "sky blue": "#7fbcd9",
      "blue": "#3b6cb8", "royal": "#1c3aa3", "royal blue": "#1c3aa3", "navy": "#1a2240",
      "midnight navy": "#0f1a3c",
      "aqua": "#5fcfd6", "teal": "#1f8a8a", "turquoise": "#3bb7b7",
      "purple": "#5b3a9e", "violet": "#6a3aa8", "lavender": "#c4a6d6", "lilac": "#c8a8db",
      "red": "#c2202c", "true red": "#c2202c", "cardinal red": "#a8202b", "cherry": "#a8232f",
      "maroon": "#601822", "burgundy": "#5a1f29",
      "pink": "#f4a3c5", "soft pink": "#f7c4d2", "heather pink": "#dca0b1", "berry": "#a83a73",
      "orange": "#e25b27", "burnt orange": "#b85128", "rust": "#a3401f", "peach": "#f7c3a1",
      "yellow": "#f3c100", "gold": "#cd9c2b", "old gold": "#a8842c", "daisy": "#fadc6e",
      "mustard": "#c69a16",
      "green": "#2f7d3a", "kelly": "#2f7d3a", "irish green": "#1f7a37", "mint": "#a8d8b2",
      "forest green": "#1f4a2a", "forest": "#1f4a2a", "olive": "#5b5a30",
      "military green": "#4a4f2c", "army": "#4a4f2c", "sage": "#8fa68a",
      "heather grey": "#9aa1a8", "heather gray": "#9aa1a8", "athletic heather": "#b9bdc1",
      "dark heather": "#4a4d51", "sport grey": "#9aa1a8", "sport gray": "#9aa1a8",
      "heavy metal": "#6a6e72",
      "grey": "#7e8489", "gray": "#7e8489", "charcoal": "#3f4347", "graphite heather": "#525558",
      "graphite": "#36393d",
      "black": "#1a1a1a", "deep black": "#0d0d0d", "vintage black": "#2a2a2a", "jet black": "#0a0a0a",
      "silver": "#c8c8c8",
      "brown": "#5a3a23", "chocolate": "#3a2618", "tan": "#b09373", "camel": "#a98763",
      "khaki": "#a8956b", "sand": "#d4c39b"
    };
    function _hexForColorName(name) {
      if (!name) return null;
      var s = String(name).toLowerCase().trim();
      if (_PRINTIFY_COLOR_HEX[s]) return _PRINTIFY_COLOR_HEX[s];
      // Strip common provider-specific prefixes ("Solid Red" → "red",
      // "Heavy Metal" already in palette, etc.) so we resolve the long
      // tail of provider-coined names.
      var stripped = s.replace(/^(solid|vintage|deep|light|dark|true|cardinal|sport|athletic|graphite|heavy)\s+/, "");
      if (_PRINTIFY_COLOR_HEX[stripped]) return _PRINTIFY_COLOR_HEX[stripped];
      var stripped2 = s.replace(/^heather\s+/, "");
      if (_PRINTIFY_COLOR_HEX[stripped2]) return _PRINTIFY_COLOR_HEX[stripped2];
      // Last-ditch substring scan ("solid midnight navy" → "navy").
      for (var k in _PRINTIFY_COLOR_HEX) {
        if (s.indexOf(k) !== -1) return _PRINTIFY_COLOR_HEX[k];
      }
      return null;
    }
    // Returns { name, hex } for a variant's colour option, or null if
    // the variant carries no colour or the colour can't be resolved.
    // Walks every option key because some products use "Color" rather
    // than "color", and a few use "Frame" or other domain-specific labels.
    function _variantColorOption(v) {
      if (!v || !v.options) return null;
      var keys = Object.keys(v.options);
      // Prefer keys that LOOK like color labels first; otherwise scan all.
      var preferred = keys.filter(function(k) { return /col?or|colour/i.test(k); });
      var ordered = preferred.concat(keys.filter(function(k) { return preferred.indexOf(k) === -1; }));
      for (var i = 0; i < ordered.length; i++) {
        var v2 = v.options[ordered[i]];
        var hex = _hexForColorName(v2);
        if (hex) return { name: v2, hex: hex };
      }
      return null;
    }

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
      PRODUCTS.forEach(function(p) {
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
      editSection.scrollIntoView({ behavior: "smooth", block: "start" });
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
      function onKey(e) {
        if (e.key === "Escape" && typeof opts.onEscape === "function") {
          e.preventDefault();
          opts.onEscape();
          return;
        }
        if (e.key !== "Tab") return;
        var focusables = _focusableInsideModal(modalEl);
        if (!focusables.length) return;
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
        if (fs.length && !isTouch) fs[0].focus();
      });
      return function release() {
        document.removeEventListener("keydown", onKey);
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
      return !!(entry && entry.images && entry.images.length > 0);
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
      var pid = state.selectedProduct;
      var hasMocks = !!(pid && state.mockups && state.mockups[pid]
                        && state.mockups[pid].images && state.mockups[pid].images.length);
      btnBuyInEditor.title = hasMocks
        ? "Beta: save your design + all generated product mockups as a .zip."
        : "Generate a real mockup first (use the Generate real mockup button in the preview pane), then download the bundle.";
      btnBuyInEditor.disabled = !hasMocks;
      btnBuyInEditor.classList.toggle("buy-locked", !hasMocks);
      // Swap the icon for a download glyph.
      var icon = btnBuyInEditor.querySelector("i");
      if (icon) icon.className = "fas fa-download";
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

    function _saveDesignLocally() {
      // Render the canvas with edits baked in (no orange frame border)
      // — same trick the clock/text "burn" path uses.
      if (!solarCanvas) return;
      var product = state.selectedProduct
        ? PRODUCTS.find(function(p) { return p.id === state.selectedProduct; })
        : null;
      var prevBurning = state._burningCanvas;
      state._burningCanvas = true;
      try { renderCanvas(); } catch (_e) {}
      state._burningCanvas = prevBurning || false;
      var dateStr = (dateInput && dateInput.value) || "design";
      var timeStr = _solarTimeValue ? _solarTimeValue() : "";
      var wl = state.wavelength || "";
      var pid = product ? product.id : "design";
      var baseName = "solar-archive_" + _slugForFilename(dateStr)
                     + (timeStr ? "_" + _slugForFilename(timeStr) : "")
                     + (wl ? "_" + wl + "A" : "")
                     + "_" + _slugForFilename(pid);
      var canvasFileName = baseName + ".png";

      // Find any generated Printify mockups for the selected product.
      // If there are any, we'll bundle them with the canvas PNG into a
      // single .zip so the tester walks away with the full preview set.
      var mockupEntry = (state.mockups && pid && state.mockups[pid]) || null;
      var mockupImages = (mockupEntry && Array.isArray(mockupEntry.images))
        ? mockupEntry.images.filter(function(img) { return img && img.src; })
        : [];

      var startedMessage = mockupImages.length
        ? "Packaging your design + " + mockupImages.length + " mockup" + (mockupImages.length === 1 ? "" : "s") + "…"
        : null;
      if (startedMessage) showToast(startedMessage);

      _canvasToBlob(solarCanvas, "image/png").then(function(canvasBlob) {
        if (!mockupImages.length) {
          // No mockups → fall back to the simple single-PNG download.
          _downloadBlob(canvasBlob, canvasFileName);
          return null;
        }
        // Otherwise bundle canvas + mockups into a zip.
        return _loadJSZip().then(function(JSZip) {
          var zip = new JSZip();
          zip.file(canvasFileName, canvasBlob);
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
        _canvasToBlob(solarCanvas, "image/png")
          .then(function(b) { _downloadBlob(b, canvasFileName); })
          .catch(function() {
            showToast("Couldn't save the design — try again or screenshot the canvas.", "error");
          });
      });
      // Re-render once more so the editor goes back to its non-burning
      // state (frame border + handles re-appear).
      try { renderCanvas(); } catch (_e) {}

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
        var sw = solarCanvas.width, sh = solarCanvas.height;
        var scale = Math.min(1, MAX_DIM / Math.max(sw, sh));
        if (scale >= 1) {
          canvasImageDataUrl = solarCanvas.toDataURL("image/png");
        } else {
          var tmp = document.createElement("canvas");
          tmp.width  = Math.max(1, Math.round(sw * scale));
          tmp.height = Math.max(1, Math.round(sh * scale));
          tmp.getContext("2d").drawImage(solarCanvas, 0, 0, tmp.width, tmp.height);
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
        fetch(API_BASE + "/api/feedback", {
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
      showToast(doneToast, "success");
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
      if (typeof renderProducts === "function") {
        try { renderProducts(); } catch (_e) {}
      }
      // Hide the editor section since there's no product selected.
      var editSection = document.getElementById("editSection");
      if (editSection) editSection.classList.add("hidden");
      // Scroll back to the date / wavelength picker so the workflow
      // visibly starts over.
      var top = document.querySelector(".section") || document.body;
      top.scrollIntoView({ behavior: "smooth", block: "start" });
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
            if (ok) _saveDesignLocally();
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
          statusRegion.textContent = txt;
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
        sendHint.textContent = "Click a product to choose a variant, then Select this product to edit; buy from the editor.";
        sendHint.style.color = "var(--text-dim)";
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
        try {
          var c = document.createElement("canvas");
          c.width = 320; c.height = 320;
          c.className = "confirm-mockup-canvas";
          var mctx = c.getContext("2d");
          mctx.scale(2, 2);
          drawProductMockup(mctx, product.id, solarCanvas.width, solarCanvas.height, variant);
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
          var newColor = v && _variantColorOption(v);
          var newHex = newColor && newColor.hex;
          swatchesEl.querySelectorAll(".confirm-color-swatch").forEach(function(s) {
            s.classList.toggle("active", s.dataset.hex === newHex);
          });
        }
        // Re-render the size chips so the active size + unavailable
        // shading update when colour changes (a size dimmed under
        // "Red" may light up again under "Black", etc.).
        if (typeof _renderSizeChips === "function") _renderSizeChips();
        _renderSummary(v);
        _renderMockup(v);
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
          var c = _variantColorOption(v);
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
          return;
        }
        // Resolve the active variant's colour so we can mark a swatch
        // as currently selected.
        var activeVariant = variants.find(function(v) { return v.id === pendingVariantId; });
        var activeColor = activeVariant && _variantColorOption(activeVariant);
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
      }

      function _onSwatchClick(hex) {
        var variants = _variantsList();
        // Try to keep the user on the same size when they switch colours.
        var current = variants.find(function(v) { return v.id === pendingVariantId; });
        var currentSize = _variantSize(current);
        var pool = variants.filter(function(v) {
          var c = _variantColorOption(v);
          return c && c.hex === hex;
        });
        if (!pool.length) return;
        var pick = currentSize
          ? pool.find(function(v) { return _variantSize(v) === currentSize; }) || pool[0]
          : pool[0];
        _selectInModal(pick.id);
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
        var activeColor = activeVariant && _variantColorOption(activeVariant);
        var activeHex = activeColor && activeColor.hex;

        var html = "";
        orderedSizes.forEach(function(sz) {
          var bucket = bucketsBySize[sz];
          var isActive = (sz === activeSize) ? " active" : "";
          // Mark unavailable if the active colour doesn't ship in this size.
          var unavailable = false;
          if (activeHex) {
            unavailable = !bucket.variants.some(function(v) {
              var c = _variantColorOption(v);
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
        var currentColor = current && _variantColorOption(current);
        var currentHex = currentColor && currentColor.hex;
        var pool = variants.filter(function(v) { return _variantSize(v) === size; });
        if (!pool.length) return;
        var pick = currentHex
          ? pool.find(function(v) {
              var c = _variantColorOption(v);
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
      function _refreshAfterPricing() {
        // Re-render tiles + summary so the real Printify cost replaces the
        // placeholder "From $X.XX" label. Active variant + scroll position
        // preserved by _renderTiles' active-class lookup.
        _renderTiles();
        _renderColorSwatches();
        _renderSizeChips();
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
          _renderTiles();
          _renderColorSwatches();
          _renderSizeChips();
          _selectInModal(pendingVariantId);
        } else {
          listEl.innerHTML = '<div class="confirm-variant-loading"><div class="spinner" style="width:16px;height:16px;display:inline-block;vertical-align:-3px;margin-right:6px;"></div> Loading sizes &amp; colors…</div>';
          if (swatchesEl) swatchesEl.classList.add("hidden");
          if (sizeChipsEl) sizeChipsEl.classList.add("hidden");
          _renderSummary(null);
          _renderMockup(null);
          loadVariants(product).then(function() {
            _renderTiles();
            _renderColorSwatches();
            _renderSizeChips();
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
      function onKey(e) {
        if (e.key === "Escape") onCancel();
        else if (e.key === "Enter") { e.preventDefault(); onContinueClick(); }
      }

      listEl.addEventListener("click", onListClick);
      if (swatchesEl) swatchesEl.addEventListener("click", onSwatchClick);
      if (sizeChipsEl) sizeChipsEl.addEventListener("click", onSizeChipClick);
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
    // Feedback widget — floating button + modal with two tabs:
    //   1. Free-text comment  → POST /api/feedback
    //   2. Product request    → search /api/printify/blueprints, pick
    //      a blueprint + provider + variant, attach a note, submit.
    //
    // Auto-captures the page context (date, wavelength, filter, selected
    // product, URL, user agent) so the operator can reproduce what the user
    // was looking at when they submitted.
    // ───────────────────────────────────────────────────────────────
    (function setupFeedbackWidget() {
      // Two FABs (Request / Comment) replace the prior single Feedback pill.
      // Each opens the modal directly to the matching tab; the modal still
      // has both tabs so users can switch once inside.
      var fabRequest = document.getElementById("feedbackFabRequest");
      var fabComment = document.getElementById("feedbackFabComment");
      var modal = document.getElementById("feedbackModal");
      if ((!fabRequest && !fabComment) || !modal) return;

      var backdrop = document.getElementById("feedbackModalBackdrop");
      var closeBtn = document.getElementById("feedbackCloseBtn");
      var tabComment = document.getElementById("feedbackTabComment");
      var tabProduct = document.getElementById("feedbackTabProduct");
      var panelComment = document.getElementById("feedbackPanelComment");
      var panelProduct = document.getElementById("feedbackPanelProduct");
      var panelThanks = document.getElementById("feedbackPanelThanks");
      var commentBody = document.getElementById("feedbackCommentBody");
      var commentName = document.getElementById("feedbackCommentName");
      var commentEmail = document.getElementById("feedbackCommentEmail");
      var commentSubmit = document.getElementById("feedbackCommentSubmit");
      var productSearch = document.getElementById("feedbackProductSearch");
      var productHint = document.getElementById("feedbackProductHint");
      var productResults = document.getElementById("feedbackProductResults");
      var categoryRow = document.getElementById("feedbackCategoryRow");
      var productChosen = document.getElementById("feedbackProductChosen");
      var chosenName = document.getElementById("feedbackChosenName");
      var chosenBrand = document.getElementById("feedbackChosenBrand");
      var chosenMockup = document.getElementById("feedbackChosenMockup");
      var chosenClear = document.getElementById("feedbackChosenClear");
      var providerSelect = document.getElementById("feedbackProviderSelect");
      var providerRow = document.getElementById("feedbackProviderRow");
      var providerAuto = document.getElementById("feedbackProviderAuto");
      var variantSelect = document.getElementById("feedbackVariantSelect");
      var productNote = document.getElementById("feedbackProductNote");
      var productName = document.getElementById("feedbackProductName");
      var productEmail = document.getElementById("feedbackProductEmail");
      var productSubmit = document.getElementById("feedbackProductSubmit");
      var thanksMsg = document.getElementById("feedbackThanksMsg");
      var thanksAnother = document.getElementById("feedbackThanksAnother");

      // ── Textarea auto-resize ──────────────────────────────────
      // CSS sets resize:none + overflow-y:hidden so the user can't
      // wrestle a tiny drag-handle on touch screens. Instead, the
      // textarea grows with its content (capped at 60vh so it never
      // pushes the rest of the form below the visible viewport on
      // mobile). Resets to the CSS min-height when the modal closes.
      function _autoResizeTextarea(el) {
        if (!el) return;
        el.style.height = "auto";
        var max = Math.round(window.innerHeight * 0.6);
        el.style.height = Math.min(el.scrollHeight, max) + "px";
      }
      if (commentBody) {
        commentBody.addEventListener("input", function() { _autoResizeTextarea(commentBody); });
      }
      if (productNote) {
        productNote.addEventListener("input", function() { _autoResizeTextarea(productNote); });
      }

      // Blueprint catalog cache. Loaded lazily on first open of the Request tab.
      var _blueprints = null;
      var _blueprintsLoading = null;
      var _chosenBlueprint = null;
      // Map of {blueprint_id: cheapest_cost_cents} from /blueprints/cheapest_costs.
      // Populated alongside the catalog on first Request-tab open. Blueprints
      // the shop has never produced are simply absent from the map — we
      // surface "Pricing on request" rather than fabricating a number.
      var _cheapestCosts = null;
      // Active category filter — null means "show everything".
      var _activeCategory = null;

      // Printify groups its catalog by product family on its website but
      // doesn't expose the grouping via the public API. We infer a category
      // per blueprint from its title using ordered keyword regexes — the
      // first match wins, so put more-specific categories before generic
      // ones (e.g. "phone case" before "accessories"). Anything that doesn't
      // match falls into "Other" so nothing disappears from the list.
      var FEEDBACK_CATEGORIES = [
        { key: "drinkware", label: "Drinkware",   icon: "fa-mug-hot",      match: /\b(mug|tumbler|stein|wine glass|water bottle|sport bottle|coaster|drinkware|shot glass|coffee|sippy)\b/i },
        { key: "wall_art",  label: "Wall Art",    icon: "fa-image",        match: /\b(poster|canvas|metal sign|metal art|acrylic|wall art|framed|tapestry|wood print|wall hanging|photo print|matte paper)\b/i },
        { key: "stickers",  label: "Stickers",    icon: "fa-sticky-note",  match: /\b(sticker|decal|bumper|kiss[- ]?cut|magnet)\b/i },
        { key: "phone",     label: "Phone",       icon: "fa-mobile-screen",match: /\b(phone case|phone grip|popsocket|airpod|airtag|tablet case)\b/i },
        { key: "tech",      label: "Tech & Office", icon: "fa-laptop",     match: /\b(laptop sleeve|laptop case|mouse ?pad|mousepad|desk mat|keyboard|stylus|sanitizer|charger|wireless)\b/i },
        { key: "bags",      label: "Bags",        icon: "fa-bag-shopping", match: /\b(tote|backpack|duffle|messenger|fanny pack|drawstring|pouch|wallet|purse|shopping bag)\b/i },
        { key: "home",      label: "Home & Living", icon: "fa-couch",      match: /\b(pillow|blanket|throw|shower curtain|bath mat|towel|rug|placemat|tablecloth|table runner|napkin|apron|oven mitt|cutting board|garden flag|stocking|christmas|ornament|car mat)\b/i },
        { key: "puzzle",    label: "Puzzles & Games", icon: "fa-puzzle-piece", match: /\b(puzzle|jigsaw|playing cards|board game|game)\b/i },
        { key: "stationery", label: "Stationery", icon: "fa-book",         match: /\b(journal|notebook|sketchbook|planner|notepad|postcard|business card|sticky note|calendar|greeting card|pen|pencil|notepad|envelope)\b/i },
        { key: "jewelry",   label: "Jewelry",     icon: "fa-gem",          match: /\b(necklace|earring|bracelet|charm|pendant|cufflink|jewelry)\b/i },
        { key: "pets",      label: "Pets",        icon: "fa-paw",          match: /\b(pet |dog |cat |doggie|leash|collar|pet bowl|pet bed)\b/i },
        { key: "footwear",  label: "Footwear",    icon: "fa-shoe-prints",  match: /\b(socks?|sneaker|shoes?|slippers?|sandals?|boots?|flip[- ]?flops?)\b/i },
        { key: "headwear",  label: "Hats & Headwear", icon: "fa-hat-cowboy", match: /\b(hat|cap|beanie|visor|bandana|headband)\b/i },
        { key: "apparel",   label: "Apparel",     icon: "fa-shirt",        match: /\b(tee|t[- ]?shirt|hoodie|sweatshirt|tank top|crewneck|polo|jersey|jacket|cardigan|joggers|shorts?|leggings?|yoga|swim|underwear|romper|robe|gown|dress|skirt|kimono|onesie|vest|long sleeve|short sleeve|raglan|crop top|muscle|baby|infant|toddler|kids?|youth|women|men|unisex)\b/i },
        { key: "auto",      label: "Auto",        icon: "fa-car",          match: /\b(license plate|car decal|sun shade|car mat)\b/i },
        { key: "accessories", label: "Accessories", icon: "fa-tags",       match: /\b(scarf|gloves|mittens|sunglasses|tie\b|keychain|lanyard|patch|bandana|umbrella|fan)\b/i },
      ];
      function _categorize(bp) {
        if (!bp) return "other";
        var hay = (bp.title || "") + " " + (bp.brand || "");
        for (var i = 0; i < FEEDBACK_CATEGORIES.length; i++) {
          if (FEEDBACK_CATEGORIES[i].match.test(hay)) return FEEDBACK_CATEGORIES[i].key;
        }
        return "other";
      }
      // Fallback API base when served from a different origin (e.g., Shopify).
      var API_BASE = (typeof window !== "undefined" && window.location && window.location.origin) || "";

      function captureContext() {
        // Pull a small, helpful snapshot of what the user is looking at. Values
        // are derived from global state if available; missing fields are fine.
        var ctx = {};
        try {
          var dateInput = document.getElementById("solarDate");
          if (dateInput && dateInput.value) ctx.date = dateInput.value;
          var selectedCard = document.querySelector(".wl-card.selected");
          if (selectedCard && selectedCard.dataset.wl) ctx.wavelength = selectedCard.dataset.wl;
          var filterChecked = document.querySelector('input[name="editorFilter"]:checked');
          if (filterChecked) ctx.filter = filterChecked.value;
          var bgChecked = document.querySelector('input[name="vignetteFade"]:checked');
          if (bgChecked) ctx.background = bgChecked.value;
          var selectedProduct = document.querySelector(".product-card.selected");
          if (selectedProduct) ctx.selectedProduct = selectedProduct.dataset.productId;
        } catch (_e) { /* best-effort */ }
        return ctx;
      }

      // ── Contact prefill / persistence ──────────────────────────
      // Name + email are required on submit; remember whatever the
      // user typed last so a tester filing a second comment doesn't
      // have to re-type both. localStorage is fine — these are the
      // user's own contact details, not anything sensitive.
      var _CONTACT_KEY = "solarArchive.feedbackContact.v1";
      function _loadContact() {
        try {
          var raw = localStorage.getItem(_CONTACT_KEY);
          if (!raw) return null;
          var obj = JSON.parse(raw);
          return (obj && typeof obj === "object") ? obj : null;
        } catch (_e) { return null; }
      }
      function _rememberContact(name, email) {
        try {
          localStorage.setItem(_CONTACT_KEY, JSON.stringify({ name: name || "", email: email || "" }));
        } catch (_e) { /* private mode, etc. — silently skip */ }
      }
      // Very forgiving sanity check — just enough to catch "no @" and
      // "ends with a dot or no dot at all". Server-side trims +
      // length-caps, so we don't need a strict RFC validator here.
      function _looksLikeEmail(s) {
        return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
      }
      function _prefillContactFields() {
        var saved = _loadContact() || {};
        if (commentName && !commentName.value) commentName.value = saved.name || "";
        if (commentEmail && !commentEmail.value) commentEmail.value = saved.email || "";
        if (productName && !productName.value) productName.value = saved.name || "";
        if (productEmail && !productEmail.value) productEmail.value = saved.email || "";
      }

      // Focus trap state — installed in openModal, released in closeModal.
      var _feedbackReleaseFocusTrap = null;

      function openModal(initialTab) {
        modal.classList.remove("hidden");
        // Default to comment if no tab specified — preserves prior behavior
        // for any caller that doesn't pass an explicit tab name.
        var tab = initialTab === "product" ? "product" : "comment";
        showTab(tab);
        _prefillContactFields();
        // Embedded mode (Shopify iframe): the modal flows inline in
        // the document rather than overlaying. Scroll to it so the
        // user finds it instead of staring at their old scroll spot.
        if (document.documentElement.classList.contains("embedded")) {
          try { modal.scrollIntoView({ behavior: "smooth", block: "start" }); }
          catch (_e) { modal.scrollIntoView(); }
        }
        // Install the focus trap: keyboard users can Tab within the
        // modal, Escape dismisses, and focus is restored on close.
        // The trap also handles the touch-device "don't programmatically
        // focus an input" rule — so this replaces the special-case
        // setTimeout below for the keyboard path, but we keep the
        // textarea-focus convenience on desktop because the user
        // landed here to type, not to tab.
        if (_feedbackReleaseFocusTrap) _feedbackReleaseFocusTrap();
        _feedbackReleaseFocusTrap = installModalFocusTrap(modal, { onEscape: closeModal });
        // Tier-1 mobile fix: iOS Safari (and Android Chrome) only pop the
        // soft keyboard when focus is triggered by a user gesture in the
        // SAME synchronous call stack. The setTimeout below breaks that
        // chain, so on mobile the textarea got focus (cursor visible)
        // but no keyboard — beta tester Sandi reported "squiggly line
        // appeared but I couldn't type." Worse: with the textarea
        // already focused, a follow-up tap doesn't re-focus, so the
        // keyboard never opens. Skip the auto-focus on touch devices;
        // the user's first tap will focus the field and the keyboard
        // opens naturally. Desktop keeps the convenience focus because
        // it has no keyboard-gesture requirement.
        var isTouch = ('ontouchstart' in window) ||
                      (navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
        if (!isTouch) {
          setTimeout(function() {
            if (tab === "comment" && commentBody) commentBody.focus();
            else if (tab === "product" && productSearch) productSearch.focus();
          }, 60);
        }
      }

      function closeModal() {
        modal.classList.add("hidden");
        if (_feedbackReleaseFocusTrap) {
          _feedbackReleaseFocusTrap();
          _feedbackReleaseFocusTrap = null;
        }
        // Clear the bodies + email fields on close so next open starts
        // clean. Name/email are intentionally NOT wiped — _prefillContactFields
        // restores them from localStorage the next time the modal opens.
        if (commentBody) { commentBody.value = ""; commentBody.style.height = ""; }
        if (commentName) commentName.value = "";
        if (commentEmail) commentEmail.value = "";
        if (productSearch) productSearch.value = "";
        if (productResults) productResults.innerHTML = "";
        if (productNote) { productNote.value = ""; productNote.style.height = ""; }
        if (productName) productName.value = "";
        if (productEmail) productEmail.value = "";
        _activeCategory = null;
        if (_blueprints) renderCategoryChips();
        clearChosen();
        // Hide any floating mockup popover so it doesn't outlive the modal.
        var pop = document.querySelector(".feedback-hit-popover");
        if (pop) pop.classList.remove("visible");
      }

      function showTab(name) {
        panelComment.classList.toggle("hidden", name !== "comment");
        panelProduct.classList.toggle("hidden", name !== "product");
        panelThanks.classList.add("hidden");
        tabComment.classList.toggle("active", name === "comment");
        tabProduct.classList.toggle("active", name === "product");
        tabComment.setAttribute("aria-selected", name === "comment" ? "true" : "false");
        tabProduct.setAttribute("aria-selected", name === "product" ? "true" : "false");
        if (name === "product") loadBlueprints();
      }

      function showThanks(msg) {
        panelComment.classList.add("hidden");
        panelProduct.classList.add("hidden");
        panelThanks.classList.remove("hidden");
        if (thanksMsg) thanksMsg.textContent = msg || "Your note is on its way.";
      }

      function loadBlueprints() {
        if (_blueprints || _blueprintsLoading) {
          if (_blueprints) renderResults(productSearch.value.trim());
          return;
        }
        productHint.classList.remove("hidden");
        productHint.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading catalog\u2026';
        // Fetch the catalog and the cached "cheapest cost per blueprint" map
        // in parallel \u2014 the catalog is the slow path, the cost map is small
        // and lets us render prices on the search rows.
        _blueprintsLoading = Promise.all([
          fetch(API_BASE + "/api/printify/blueprints").then(function(r) { return r.json(); }),
          fetch(API_BASE + "/api/printify/blueprints/cheapest_costs")
            .then(function(r) { return r.ok ? r.json() : { costs: {} }; })
            .catch(function() { return { costs: {} }; }),
        ])
          .then(function(results) {
            _blueprints = Array.isArray(results[0]) ? results[0] : [];
            _cheapestCosts = (results[1] && results[1].costs) || {};
            productHint.classList.add("hidden");
            renderCategoryChips();
            renderResults(productSearch.value.trim());
          })
          .catch(function(err) {
            productHint.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Couldn\u2019t load catalog. Try again in a minute.';
            console.warn("[feedback] blueprints load failed:", err);
          })
          .finally(function() { _blueprintsLoading = null; });
      }

      function renderCategoryChips() {
        if (!categoryRow || !_blueprints) return;
        // Count blueprints per category so the chip labels read as
        // "Apparel · 412" — gives the user a sense of breadth before they
        // commit to a click.
        var counts = {};
        _blueprints.forEach(function(b) {
          var k = _categorize(b);
          counts[k] = (counts[k] || 0) + 1;
        });
        // Render in declared order (most relevant first), then "Other" at
        // the end if anything fell through. Chips with zero hits are
        // hidden so we don't surface empty filters.
        var html = "";
        FEEDBACK_CATEGORIES.forEach(function(cat) {
          var n = counts[cat.key] || 0;
          if (!n) return;
          var active = (_activeCategory === cat.key) ? " active" : "";
          html += '<button type="button" class="feedback-category-chip' + active + '" data-cat="' + cat.key + '">' +
                  '<i class="fas ' + cat.icon + '"></i> ' + escapeHtml(cat.label) +
                  ' <span class="feedback-category-chip-count">' + n + '</span>' +
                  '</button>';
        });
        if (counts.other) {
          var activeOther = (_activeCategory === "other") ? " active" : "";
          html += '<button type="button" class="feedback-category-chip' + activeOther + '" data-cat="other">' +
                  '<i class="fas fa-ellipsis"></i> Other' +
                  ' <span class="feedback-category-chip-count">' + counts.other + '</span>' +
                  '</button>';
        }
        categoryRow.innerHTML = html;
      }

      // NOTE: Per-variant mockups (e.g. a red shirt photo for the "Red"
      // variant) require Printify's Mockup Generator API — uploading a
      // design and round-tripping through their async renderer. We don't
      // have a design at "request a product" time, so we just keep the
      // generic blueprint image until we wire up that pipeline.

      function _bpThumbUrl(bp) {
        // Catalog blueprints carry an `images` array; prefer the first
        // entry if present, falling back to a placeholder mark.
        if (bp && Array.isArray(bp.images) && bp.images.length) return bp.images[0];
        return null;
      }
      function _bpPriceLabel(bp) {
        if (!_cheapestCosts || !bp) return null;
        var c = _cheapestCosts[bp.id];
        if (c == null) return null;
        return "From $" + (c / 100).toFixed(2);
      }

      function renderResults(query) {
        if (!_blueprints) return;
        if (!productResults) return;
        query = (query || "").toLowerCase().trim();
        // Query and category chip stack \u2014 both must match for a row to land
        // in the list. With neither set we show the empty-state hint so the
        // modal doesn't dump 1300+ rows.
        var hasQuery = !!query;
        var hasCategory = !!_activeCategory;
        if (!hasQuery && !hasCategory) {
          productResults.innerHTML = '<div class="feedback-product-placeholder">Type above to search \u2014 try "tote", "wine", "pet", "ornament"&hellip; or pick a category.</div>';
          return;
        }
        var items = _blueprints.filter(function(b) {
          if (hasCategory && _categorize(b) !== _activeCategory) return false;
          if (hasQuery) {
            var t = (b.title || "").toLowerCase();
            var br = (b.brand || "").toLowerCase();
            if (t.indexOf(query) === -1 && br.indexOf(query) === -1) return false;
          }
          return true;
        }).slice(0, 20);
        if (!items.length) {
          var empty = hasQuery
            ? 'No matches for \u201c' + escapeHtml(query) + '\u201d' + (hasCategory ? ' in this category.' : '.')
            : 'Nothing in this category.';
          productResults.innerHTML = '<div class="feedback-product-placeholder">' + empty + '</div>';
          return;
        }
        productResults.innerHTML = items.map(function(b) {
          var thumb = _bpThumbUrl(b);
          var priceLabel = _bpPriceLabel(b);
          var thumbHtml = thumb
            ? '<img class="feedback-product-hit-thumb" src="' + escapeHtml(thumb) + '" alt="" loading="lazy">'
            : '<span class="feedback-product-hit-thumb-empty"><i class="fas fa-image"></i></span>';
          var priceHtml = priceLabel
            ? '<span class="feedback-product-hit-price">' + escapeHtml(priceLabel) + '</span>'
            : '<span class="feedback-product-hit-price-empty">Pricing on request</span>';
          // The full-size mockup URL is stashed in a data attribute and
          // surfaced by a JS-driven popover (appended to <body>) so it
          // floats above the scrollable result list without getting clipped.
          var popoverAttr = thumb ? ' data-popover-img="' + escapeHtml(thumb) + '"' : '';
          return '<button type="button" class="feedback-product-hit" data-bp="' + b.id + '"' + popoverAttr + '>' +
                   thumbHtml +
                   '<span class="feedback-product-hit-text">' +
                     '<span class="feedback-product-hit-title">' + escapeHtml(b.title || "") + '</span>' +
                     '<span class="feedback-product-hit-brand">' + escapeHtml(b.brand || "") + '</span>' +
                   '</span>' +
                   priceHtml +
                 '</button>';
        }).join("");
      }

      function escapeHtml(s) {
        return String(s == null ? "" : s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      function chooseBlueprint(bp) {
        _chosenBlueprint = bp;
        chosenName.textContent = bp.title || ("Blueprint " + bp.id);
        var priceLabel = _bpPriceLabel(bp);
        chosenBrand.textContent =
          (bp.brand ? "Brand: " + bp.brand : "") +
          (bp.brand && priceLabel ? " · " : "") +
          (priceLabel || "");
        // Carry the row's mockup image into the chosen pane so the user
        // sees what they picked once the result list collapses.
        if (chosenMockup) {
          var thumb = _bpThumbUrl(bp);
          if (thumb) {
            chosenMockup.innerHTML = '<img src="' + escapeHtml(thumb) + '" alt="' + escapeHtml(bp.title || "") + '">';
            chosenMockup.classList.remove("hidden");
          } else {
            chosenMockup.innerHTML = '<span class="feedback-chosen-mockup-empty"><i class="fas fa-image"></i> No preview available</span>';
          }
        }
        productChosen.classList.remove("hidden");
        productResults.innerHTML = "";
        if (productSearch) productSearch.value = "";
        // Load providers
        providerSelect.innerHTML = '<option>Loading providers\u2026</option>';
        if (providerRow) providerRow.classList.remove("hidden");
        if (providerAuto) providerAuto.classList.add("hidden");
        variantSelect.innerHTML = '<option>Pick a provider first</option>';
        fetch(API_BASE + "/api/printify/blueprints/" + encodeURIComponent(bp.id) + "/providers")
          .then(function(r) { return r.ok ? r.json() : null; })
          .catch(function() { return null; })
          .then(function(providers) {
            // Some environments only expose the variants endpoint (which needs a
            // provider id). If /providers doesn't exist, show a manual provider
            // entry box instead of blocking the submission.
            if (!Array.isArray(providers) || !providers.length) {
              providerSelect.innerHTML = '<option value="">(provider lookup unavailable — we\u2019ll assign one)</option>';
              variantSelect.innerHTML = '<option value="">(any)</option>';
              return;
            }
            // Single provider: skip the dropdown entirely. Picking from a
            // one-item list is busywork, and the user still sees who's
            // fulfilling via the read-only "Fulfilled by ..." line.
            if (providers.length === 1) {
              var only = providers[0];
              providerSelect.innerHTML = '<option value="' + only.id + '">' + escapeHtml(only.title || ("Provider " + only.id)) + '</option>';
              providerSelect.value = String(only.id);
              if (providerRow) providerRow.classList.add("hidden");
              if (providerAuto) {
                providerAuto.classList.remove("hidden");
                providerAuto.innerHTML = '<i class="fas fa-truck"></i> Fulfilled by <strong>' + escapeHtml(only.title || ("Provider " + only.id)) + '</strong>';
              }
              loadVariants(bp.id, only.id);
              return;
            }
            providerSelect.innerHTML = '<option value="">Pick a provider\u2026</option>' +
              providers.map(function(p) {
                return '<option value="' + p.id + '">' + escapeHtml(p.title || ("Provider " + p.id)) + '</option>';
              }).join("");
            variantSelect.innerHTML = '<option value="">Pick a provider first</option>';
          });
      }

      function loadVariants(bpId, providerId) {
        if (!bpId || !providerId) return;
        variantSelect.innerHTML = '<option>Loading variants\u2026</option>';
        fetch(API_BASE + "/api/printify/blueprints/" + encodeURIComponent(bpId) + "/providers/" + encodeURIComponent(providerId) + "/variants")
          .then(function(r) { return r.json(); })
          .then(function(data) {
            var vs = (data && Array.isArray(data.variants)) ? data.variants : [];
            if (!vs.length) {
              variantSelect.innerHTML = '<option value="">(no variants returned)</option>';
              return;
            }
            variantSelect.innerHTML = '<option value="">Any variant is fine</option>' +
              vs.map(function(v) {
                var opts = v.options ? Object.keys(v.options).map(function(k) { return v.options[k]; }).join(" · ") : "";
                // Stash the print-area placeholder dimensions on the
                // <option> so the submit handler can derive an aspect
                // ratio without re-fetching the variant list. Prefer the
                // "front" placeholder (the most common print position),
                // fall back to whichever the variant exposes first.
                var phs = Array.isArray(v.placeholders) ? v.placeholders : [];
                var ph = phs.find(function(p) { return p && p.position === "front"; }) || phs[0] || null;
                var phAttr = (ph && ph.width && ph.height)
                  ? ' data-ph-w="' + ph.width + '" data-ph-h="' + ph.height + '"'
                  : '';
                return '<option value="' + v.id + '" data-title="' + escapeHtml(v.title || "") + '"' + phAttr + '>' +
                       escapeHtml(v.title || ("Variant " + v.id)) + (opts ? (" (" + escapeHtml(opts) + ")") : "") +
                       '</option>';
              }).join("");
          })
          .catch(function() {
            variantSelect.innerHTML = '<option value="">(couldn\u2019t load variants — we\u2019ll figure it out)</option>';
          });
      }

      function clearChosen() {
        _chosenBlueprint = null;
        if (productChosen) productChosen.classList.add("hidden");
        if (providerSelect) providerSelect.innerHTML = "";
        if (variantSelect) variantSelect.innerHTML = "";
        if (chosenMockup) chosenMockup.innerHTML = "";
      }

      // Capture a downscaled PNG dataURL of the editor canvas. Used by
      // both submit paths when the "Include a snapshot…" checkbox is
      // on. We scale the long side down to 800px so the payload stays
      // ~50-200KB instead of multi-megabyte at HQ resolution; the
      // operator just needs enough fidelity to see what the tester
      // was looking at. Returns null if there's nothing to capture.
      function _captureCanvasSnapshot() {
        try {
          if (!solarCanvas || !solarCanvas.width || !solarCanvas.height) return null;
          var MAX_DIM = 800;
          var sw = solarCanvas.width, sh = solarCanvas.height;
          var scale = Math.min(1, MAX_DIM / Math.max(sw, sh));
          var dw = Math.max(1, Math.round(sw * scale));
          var dh = Math.max(1, Math.round(sh * scale));
          if (dw === sw && dh === sh) {
            return solarCanvas.toDataURL("image/png");
          }
          var tmp = document.createElement("canvas");
          tmp.width = dw; tmp.height = dh;
          var tctx = tmp.getContext("2d");
          tctx.drawImage(solarCanvas, 0, 0, dw, dh);
          return tmp.toDataURL("image/png");
        } catch (_e) { return null; }
      }
      function _shouldIncludeCanvas(checkboxId) {
        var cb = document.getElementById(checkboxId);
        return !!(cb && cb.checked);
      }

      function submitComment() {
        var body = (commentBody.value || "").trim();
        var nameVal = (commentName && commentName.value || "").trim();
        var emailVal = (commentEmail.value || "").trim();
        // Validate body, name, and email in that visual order so the
        // first-error focus matches the form's top-to-bottom layout.
        var bad = !body ? commentBody
                : !nameVal ? commentName
                : (!emailVal || !_looksLikeEmail(emailVal)) ? commentEmail
                : null;
        if (bad) {
          bad.focus();
          bad.classList.add("feedback-field-error");
          setTimeout(function() { bad.classList.remove("feedback-field-error"); }, 1500);
          return;
        }
        _rememberContact(nameVal, emailVal);
        var payload = {
          kind: "comment",
          body: body,
          name: nameVal,
          email: emailVal,
          url: window.location.href,
          user_agent: navigator.userAgent,
          context: captureContext(),
          canvas_image: _shouldIncludeCanvas("feedbackIncludeCanvasComment")
            ? _captureCanvasSnapshot()
            : null,
        };
        commentSubmit.disabled = true;
        commentSubmit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending\u2026';
        sendFeedback(payload)
          .then(function() { showThanks("Thanks — your feedback is logged."); })
          .catch(function(e) {
            showToast("Couldn't send feedback: " + (e && e.message ? e.message : "please try again"), "error");
          })
          .finally(function() {
            commentSubmit.disabled = false;
            commentSubmit.innerHTML = '<i class="fas fa-paper-plane"></i> Send feedback';
          });
      }

      function submitProductRequest() {
        if (!_chosenBlueprint) {
          showToast("Pick a product first.", "error");
          return;
        }
        var providerId = providerSelect.value ? parseInt(providerSelect.value, 10) : null;
        var variantId = variantSelect.value ? parseInt(variantSelect.value, 10) : null;
        var variantTitle = variantSelect.selectedOptions[0] ? variantSelect.selectedOptions[0].dataset.title : null;
        var note = (productNote.value || "").trim();
        var nameVal = (productName && productName.value || "").trim();
        var emailVal = (productEmail && productEmail.value || "").trim();
        // Validate contact fields BEFORE building the payload so we
        // can shake the wrong one in place. Body is the bottom of the
        // form so it's checked last; the picker already gates above.
        var bad = !nameVal ? productName
                : (!emailVal || !_looksLikeEmail(emailVal)) ? productEmail
                : null;
        if (bad) {
          bad.focus();
          bad.classList.add("feedback-field-error");
          setTimeout(function() { bad.classList.remove("feedback-field-error"); }, 1500);
          return;
        }
        _rememberContact(nameVal, emailVal);
        var shapeRadio = document.querySelector('input[name="feedbackPrintShape"]:checked');
        var printShape = shapeRadio ? shapeRadio.value : "rectangle";

        var payload = {
          kind: "product_request",
          body: note || ("Request: " + (_chosenBlueprint.title || ("BP " + _chosenBlueprint.id))),
          name: nameVal,
          email: emailVal,
          url: window.location.href,
          user_agent: navigator.userAgent,
          context: captureContext(),
          canvas_image: _shouldIncludeCanvas("feedbackIncludeCanvasProduct")
            ? _captureCanvasSnapshot()
            : null,
          product_request: {
            blueprintId: _chosenBlueprint.id,
            title: _chosenBlueprint.title || null,
            brand: _chosenBlueprint.brand || null,
            printProviderId: providerId,
            variantId: variantId,
            variantTitle: variantTitle || null,
            printShape: printShape,
          },
        };
        productSubmit.disabled = true;
        productSubmit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending\u2026';

        // Derive aspect ratio straight from the variant's print-area
        // placeholder (width × height in pixels). This is the actual
        // bounding box Printify uses for the print, so 791×791 → 1:1
        // for the round leash button, 3319×3761 → ~7:8 for the front
        // of a tee, etc. Fall back to parsing dimensions out of the
        // variant title if the placeholder is missing, then 1:1.
        var aspectRatio = { w: 1, h: 1 };
        try {
          var opts = variantSelect.selectedOptions[0];
          var phW = opts && parseInt(opts.dataset.phW, 10);
          var phH = opts && parseInt(opts.dataset.phH, 10);
          if (phW && phH && phW > 0 && phH > 0) {
            aspectRatio = { w: phW, h: phH };
          } else if (opts && /(\d+)\s*[x×]\s*(\d+)/i.test(opts.textContent || "")) {
            var m = (opts.textContent || "").match(/(\d+)\s*[x×]\s*(\d+)/i);
            if (m) aspectRatio = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
          }
        } catch (_e) { /* best-effort */ }

        sendFeedback(payload)
          .then(function() {
            // Build a session-only product entry so the user can use what they
            // just requested without waiting for admin approval.
            if (typeof makeProductFromRequest === "function" && typeof addToSessionCatalog === "function") {
              var sessionEntry = makeProductFromRequest(payload.product_request, { aspectRatio: aspectRatio, printShape: printShape });
              if (sessionEntry) {
                addToSessionCatalog(sessionEntry);
                // Merge into the live PRODUCTS array. Replace any existing
                // entry with the same id rather than skipping, so re-
                // submissions actually update fields like printShape and
                // aspectRatio (we used to silently keep the original).
                if (typeof PRODUCTS !== "undefined") {
                  var existingIdx = PRODUCTS.findIndex(function(p) { return p.id === sessionEntry.id; });
                  if (existingIdx >= 0) PRODUCTS[existingIdx] = sessionEntry;
                  else PRODUCTS.push(sessionEntry);
                }
                // Re-render so the Your Requests section picks it up immediately
                if (typeof renderProducts === "function") renderProducts();
              }
            }
            showThanks("Got it \u2014 your product is ready below under \u201cYour Requests\u201d. We'll review for adding to the permanent catalog.");
          })
          .catch(function(e) {
            showToast("Couldn't send request: " + (e && e.message ? e.message : "please try again"), "error");
          })
          .finally(function() {
            productSubmit.disabled = false;
            productSubmit.innerHTML = '<i class="fas fa-star"></i> Request this product';
          });
      }

      function sendFeedback(payload) {
        return fetch(API_BASE + "/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).then(function(r) {
          if (!r.ok) return r.text().then(function(t) { throw new Error(t || ("HTTP " + r.status)); });
          return r.json();
        });
      }

      // Wire events
      if (fabRequest) fabRequest.addEventListener("click", function() { openModal("product"); });
      if (fabComment) fabComment.addEventListener("click", function() { openModal("comment"); });
      backdrop.addEventListener("click", closeModal);
      closeBtn.addEventListener("click", closeModal);
      tabComment.addEventListener("click", function() { showTab("comment"); });
      tabProduct.addEventListener("click", function() { showTab("product"); });
      commentSubmit.addEventListener("click", submitComment);
      productSubmit.addEventListener("click", submitProductRequest);
      chosenClear.addEventListener("click", clearChosen);
      thanksAnother.addEventListener("click", function() { showTab("comment"); });

      // Debounced search
      var searchTimer = null;
      productSearch.addEventListener("input", function() {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(function() { renderResults(productSearch.value.trim()); }, 120);
      });

      // Category chip clicks toggle the filter — clicking the active chip
      // again clears the filter, so the row doubles as a "clear" affordance.
      if (categoryRow) {
        categoryRow.addEventListener("click", function(e) {
          var chip = e.target.closest(".feedback-category-chip");
          if (!chip) return;
          var key = chip.dataset.cat;
          _activeCategory = (_activeCategory === key) ? null : key;
          renderCategoryChips();
          renderResults(productSearch.value.trim());
        });
      }

      // Delegated click for product hits
      productResults.addEventListener("click", function(e) {
        var hit = e.target.closest(".feedback-product-hit");
        if (!hit) return;
        var bpId = parseInt(hit.dataset.bp, 10);
        var bp = (_blueprints || []).find(function(b) { return b.id === bpId; });
        if (bp) chooseBlueprint(bp);
      });

      // Floating mockup popover for hovered rows. We append to <body>
      // (instead of relying on CSS :hover within the row) so the popover
      // can escape the scrollable result list's overflow clipping.
      var _popoverEl = null;
      function _ensurePopover() {
        if (_popoverEl) return _popoverEl;
        _popoverEl = document.createElement("div");
        _popoverEl.className = "feedback-hit-popover";
        _popoverEl.setAttribute("aria-hidden", "true");
        _popoverEl.appendChild(document.createElement("img"));
        document.body.appendChild(_popoverEl);
        return _popoverEl;
      }
      function _showPopover(hit) {
        var src = hit.getAttribute("data-popover-img");
        if (!src) return;
        var pop = _ensurePopover();
        pop.querySelector("img").src = src;
        // Anchor to the right of the row, vertically centered, but flip
        // to the left if there's not enough room (e.g. modal hugging the
        // right edge on a narrow window).
        var r = hit.getBoundingClientRect();
        var popW = 200, popH = 200, gap = 12;
        var left = r.right + gap;
        if (left + popW > window.innerWidth - 8) left = r.left - gap - popW;
        if (left < 8) left = 8;
        var top = r.top + (r.height / 2) - (popH / 2);
        if (top < 8) top = 8;
        if (top + popH > window.innerHeight - 8) top = window.innerHeight - popH - 8;
        pop.style.left = left + "px";
        pop.style.top = top + "px";
        pop.classList.add("visible");
      }
      function _hidePopover() {
        if (_popoverEl) _popoverEl.classList.remove("visible");
      }
      productResults.addEventListener("mouseover", function(e) {
        var hit = e.target.closest(".feedback-product-hit");
        if (!hit) return;
        if (e.relatedTarget && hit.contains(e.relatedTarget)) return;
        _showPopover(hit);
      });
      productResults.addEventListener("mouseout", function(e) {
        var hit = e.target.closest(".feedback-product-hit");
        if (!hit) return;
        if (e.relatedTarget && hit.contains(e.relatedTarget)) return;
        _hidePopover();
      });
      // Hide on scroll so a stale popover doesn't drift past the row.
      productResults.addEventListener("scroll", _hidePopover, { passive: true });

      // Variant list depends on provider selection
      providerSelect.addEventListener("change", function() {
        if (!_chosenBlueprint) return;
        var pid = providerSelect.value;
        if (pid) loadVariants(_chosenBlueprint.id, pid);
      });

      // Escape key closes the modal when it's open
      document.addEventListener("keydown", function(e) {
        if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
      });
    })();

  })();