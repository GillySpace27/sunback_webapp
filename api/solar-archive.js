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
      cropEdgeFeather: 0,          // 0–100: feather at edges of crop viewport
      textMode: false,
      hqImageUrl: null,   // URL of completed HQ PNG (separate from originalImage)
      hqTaskId: null,     // running HQ background task ID
      textOverlay: null,  // { text, x, y, size, font, color, strokeColor, strokeWidth }
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
    var PRODUCTS = [
      // ── Wall Art & Home Decor ──
      { id: "canvas_stretched",     name: "Stretched Canvas",    desc: "Gallery-wrapped canvas, 1.25\" bars",       icon: "fa-palette",      price: "From $29.99", checkoutPrice: 2999, blueprintId: 555,  printProviderId: 69,  variantId: 70880, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "metal_sign",           name: "Metal Art Sign",      desc: "Vibrant aluminum print, ready to hang",     icon: "fa-shield-alt",   price: "From $24.99", checkoutPrice: 2499, blueprintId: 1206, printProviderId: 228, variantId: 91993, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "acrylic_print",        name: "Acrylic Wall Art",    desc: "High-gloss acrylic panel with standoffs",   icon: "fa-gem",          price: "From $34.99", checkoutPrice: 3499, blueprintId: 1098, printProviderId: 228, variantId: 82057, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "poster_matte",         name: "Matte Poster",        desc: "Museum-quality matte paper, multiple sizes", icon: "fa-image",       price: "From $9.99",  checkoutPrice: 999,  blueprintId: 282,  printProviderId: 99,  variantId: 43135, position: "front", aspectRatio: { w: 11, h: 14 } },
      { id: "framed_poster",        name: "Framed Poster",       desc: "Ready-to-hang framed museum print",         icon: "fa-square",       price: "From $29.99", checkoutPrice: 2999, blueprintId: 492,  printProviderId: 36,  variantId: 65400, position: "front", aspectRatio: { w: 11, h: 14 } },
      { id: "wall_clock",           name: "Wall Clock",          desc: "Round acrylic clock — the Sun tells time",  icon: "fa-clock",        price: "From $29.99", checkoutPrice: 2999, blueprintId: 277,  printProviderId: 1,   variantId: 43008, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "tapestry",             name: "Wall Tapestry",       desc: "Large-format indoor wall hanging",          icon: "fa-scroll",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 241,  printProviderId: 10,  variantId: 41686, position: "front", aspectRatio: { w: 1, h: 1 } },
      // ── Drinkware ──
      // NOTE: Printify splits mug color across separate blueprints rather than
      // exposing color as a variant. White lives at BP 425; black lives at BP 1152.
      // Both are listed so the gallery carries both options.
      { id: "mug_15oz",             name: "Ceramic Mug — 15oz (White)", desc: "Large white ceramic mug, full-wrap print", icon: "fa-mug-hot", price: "From $14.99", checkoutPrice: 1499, blueprintId: 425,  printProviderId: 1,   variantId: 62014, position: "front", aspectRatio: { w: 2, h: 1 } },
      { id: "mug_15oz_black",       name: "Ceramic Mug — 15oz (Black)", desc: "Large black ceramic mug, full-wrap print", icon: "fa-mug-hot", price: "From $14.99", checkoutPrice: 1499, blueprintId: 1152, printProviderId: 28,  variantId: 88132, position: "front", aspectRatio: { w: 2448, h: 1266 } },
      { id: "tumbler_20oz",         name: "Tumbler — 20oz",      desc: "Insulated stainless steel with lid",        icon: "fa-glass-whiskey", price: "From $19.99", checkoutPrice: 1999, blueprintId: 353,  printProviderId: 1,   variantId: 44519, position: "front", aspectRatio: { w: 2, h: 1 } },
      // ── Apparel ──
      { id: "tshirt_unisex",        name: "Unisex T-Shirt",      desc: "Bella+Canvas 3001 jersey tee, DTG print",   icon: "fa-tshirt",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 12,   printProviderId: 29,  variantId: 18052, position: "front", aspectRatio: { w: 1, h: 1 },
        variantFilter: { sizes: ["XS","S","M","L","XL","2XL","3XL"], colors: ["Black","White","Navy","Forest Green","Dark Heather","Athletic Heather","True Royal","Maroon","Red","Military Green"] } },
      { id: "hoodie_pullover",      name: "Pullover Hoodie",     desc: "Unisex heavy blend hooded sweatshirt",      icon: "fa-mitten",       price: "From $39.99", checkoutPrice: 3999, blueprintId: 77,   printProviderId: 29,  variantId: 32878, position: "front", aspectRatio: { w: 1, h: 1 },
        variantFilter: { sizes: ["S","M","L","XL","2XL","3XL"], colors: ["Black","White","Navy","Dark Heather","Sport Grey","Maroon","Forest Green","Military Green"] } },
      { id: "crewneck_sweatshirt",  name: "Crewneck Sweatshirt", desc: "Unisex heavy blend crewneck",               icon: "fa-vest",         price: "From $34.99", checkoutPrice: 3499, blueprintId: 49,   printProviderId: 29,  variantId: 25377, position: "front", aspectRatio: { w: 1, h: 1 },
        variantFilter: { sizes: ["S","M","L","XL","2XL","3XL"], colors: ["Black","White","Navy","Dark Heather","Sport Grey","Maroon","Forest Green"] } },
      { id: "crew_socks",           name: "Crew Socks",          desc: "All-over sublimation print socks",          icon: "fa-socks",        price: "From $14.99", checkoutPrice: 1499, blueprintId: 365,  printProviderId: 14,  variantId: 44904, position: "front", aspectRatio: { w: 1, h: 1 },
        variantFilter: { sizes: ["S","M","L","XS","XL","2XL"] } },
      // ── Tech & Desk ──
      // Blueprint 269 / provider 1 (SPOKE) covers iPhone 11–17 and Samsung Galaxy S21–S25.
      // Google Pixel cases require blueprint 421 / provider 23 (WOYC) — a separate product
      // entry can be added once that blueprint's checkout flow is verified.
      { id: "phone_case",           name: "Phone Case",          desc: "Tough snap case — iPhone & Samsung",        icon: "fa-mobile-alt",   price: "From $19.99", checkoutPrice: 1999, blueprintId: 269,  printProviderId: 1,   variantId: 62582, position: "front", aspectRatio: { w: 9, h: 19 } },
      // Pixel Phone Case — blueprint 421, provider 23 (WOYC). Uncomment and verify variant IDs
      // before enabling.  Pixel 7/8/8a/9/9 Pro confirmed on WOYC catalog.
      // { id: "phone_case_pixel", name: "Phone Case (Pixel)", desc: "Tough snap case — Google Pixel", icon: "fa-mobile-alt", price: "From $19.99", checkoutPrice: 1999, blueprintId: 421, printProviderId: 23, variantId: null, position: "front", aspectRatio: { w: 9, h: 19 } },
      { id: "laptop_sleeve",        name: "Laptop Sleeve",       desc: "Padded neoprene sleeve, snug fit",          icon: "fa-laptop",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 429,  printProviderId: 1,   variantId: 62037, position: "front", aspectRatio: { w: 4, h: 3 } },
      { id: "mouse_pad",            name: "Mouse Pad",           desc: "Non-slip rubber base, smooth fabric top",   icon: "fa-mouse",        price: "From $11.99", checkoutPrice: 1199, blueprintId: 582,  printProviderId: 99,  variantId: 71665, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "desk_mat",             name: "Desk Mat",            desc: "Large-format mat for your workspace",       icon: "fa-desktop",      price: "From $24.99", checkoutPrice: 2499, blueprintId: 488,  printProviderId: 1,   variantId: 65240, position: "front", aspectRatio: { w: 2, h: 1 }, forceOrientation: "landscape" },
      // ── Home & Living ──
      { id: "throw_pillow",         name: "Throw Pillow",        desc: "Spun polyester square pillow with insert",  icon: "fa-couch",        price: "From $22.99", checkoutPrice: 2299, blueprintId: 220,  printProviderId: 10,  variantId: 41521, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "sherpa_blanket",       name: "Sherpa Blanket",      desc: "Ultra-soft fleece with sherpa backing",     icon: "fa-cloud",        price: "From $44.99", checkoutPrice: 4499, blueprintId: 238,  printProviderId: 99,  variantId: 41656, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "shower_curtain",       name: "Shower Curtain",      desc: "Polyester shower curtain, vibrant print",   icon: "fa-shower",       price: "From $34.99", checkoutPrice: 3499, blueprintId: 235,  printProviderId: 10,  variantId: 41653, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "puzzle_1000",          name: "Jigsaw Puzzle",       desc: "252-piece puzzle in a tin box",             icon: "fa-puzzle-piece",  price: "From $24.99", checkoutPrice: 2499, blueprintId: 532,  printProviderId: 59,  variantId: 68984, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "coaster_set",          name: "Coaster Set",         desc: "4-pack corkwood coasters, glossy top",      icon: "fa-circle",       price: "From $14.99", checkoutPrice: 1499, blueprintId: 510,  printProviderId: 48,  variantId: 72872, position: "front", aspectRatio: { w: 1, h: 1 } },
      // ── Accessories & Stationery ──
      { id: "sticker_kiss",         name: "Kiss-Cut Stickers",   desc: "Die-cut vinyl stickers, multiple sizes",    icon: "fa-sticky-note",  price: "From $2.99",  checkoutPrice: 299,  blueprintId: 400,  printProviderId: 99,  variantId: 45748, position: "front", aspectRatio: null,
        sizePricing: { 45748: "$2.99", 45750: "$3.99", 45752: "$4.99", 45754: "$7.99" } },
      { id: "journal_hardcover",    name: "Hardcover Journal",   desc: "Matte hardcover, ruled pages",              icon: "fa-book",         price: "From $17.99", checkoutPrice: 1799, blueprintId: 485,  printProviderId: 28,  variantId: 65223, position: "front", aspectRatio: { w: 151, h: 100 } },
      { id: "backpack",             name: "Backpack",            desc: "All-over print, padded straps",             icon: "fa-bag-shopping", price: "From $44.99", checkoutPrice: 4499, blueprintId: 347,  printProviderId: 14,  variantId: 44419, position: "front", aspectRatio: null }
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
      return {
        id: id,
        name: title,
        desc: req.variantTitle ? ("Variant: " + req.variantTitle) : "User-requested product",
        icon: "fa-sparkles",
        price: price,
        checkoutPrice: checkoutPrice,
        blueprintId: req.blueprintId,
        printProviderId: req.printProviderId || null,
        variantId: req.variantId || null,
        position: "front",
        aspectRatio: ar,
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
        title.textContent = "Product Examples";
        intro.innerHTML = "Your image looks great on all of these. Click any card to switch your selection \u2014 or stick with what you have and scroll up to check out.";
      } else {
        title.textContent = "Choose Your Product";
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
      state.cropZoom = 100;
      var cropSlider = $("#cropSlider");
      var cropVal = $("#cropVal");
      if (cropSlider) { cropSlider.value = 100; }
      if (cropVal) { cropVal.textContent = "100%"; }

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

    // Called once when the user selects a product: sets labels and creates
    // the persistent canvas inside the preview pane.
    function updateSelectedProductPreview(product) {
      var previewPane = document.getElementById("selectedProductPreview");
      if (!previewPane) return;
      if (!product) {
        previewPane.classList.add("hidden");
        livePreviewCanvas = null;
        return;
      }
      previewPane.classList.remove("hidden");
      previewPane.querySelector(".preview-product-name").textContent = product.name;
      var ar = getEffectiveAspectRatio(product);
      var arSimple = ar ? simplifyAspectRatio(ar.w, ar.h) : null;
      var ratioText = arSimple ? arSimple.w + ":" + arSimple.h : "flexible";
      previewPane.querySelector(".preview-product-ratio").textContent = "Aspect ratio: " + ratioText;

      // Update create button label. Price intentionally omitted — the price
      // lives in the preview pane; a "create" button that also shows price
      // reads as "buy now" to beta testers and blurs the create vs. purchase
      // steps (purchase happens on Shopify after this).
      var buyLabel = document.getElementById("btnBuyLabel");
      if (buyLabel) {
        buyLabel.textContent = "Create on Shopify";
      }

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
      // Circular preview for round products (wall_clock)
      if (product.id === "wall_clock") {
        existing.classList.add("circular");
      } else {
        existing.classList.remove("circular");
      }
      livePreviewCanvas = existing;

      // Variant selector: load variants and show dropdown so user can override in place
      updatePreviewVariantSelector(product);
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
      btnPreviewMockup.addEventListener("click", function() {
        if (!state.selectedProduct) return;
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
        } else {
          if (!state.originalImage) {
            showInfo("No Image", "Select a wavelength tile to load the solar image first.");
            return;
          }
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

          if (typeof autoGenerateMockups === "function") autoGenerateMockups(mockupVariant, productId);
          showToast("Generating real mockup for this product…");
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

      // Get raw canvas from thumbCache or fetch fresh
      var cached = thumbCache[String(wl)];
      if (cached && cached.canvas2048) {
        _startPreviewFromCanvas(cached.canvas2048, cached, wl, dateVal);
      } else {
        // Fetch preview for main canvas via backend proxy (512px — fast & reliable from Helioviewer,
        // image_scale=12 → ~1.5 R_sun FOV). 2048px was unreliable; 512px is sufficient for editing.
        var isoDate = dateVal + "T12:00:00Z";
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
      state.vignette = 24;
      state.vignetteWidth = 0;
      state.vignetteFade = "black";
      state.vignetteFadeColor = "#000000";
      state.cropEdgeFeather = 0;
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
      var alreadyLoadedThisDate = dateVal === lastThumbDate && Object.keys(thumbCache).length > 0;
      tileLog("loadWavelengthThumbnails", { dateVal: dateVal, lastThumbDate: lastThumbDate, thumbCount: thumbCount, alreadyLoadedThisDate: alreadyLoadedThisDate });
      if (!dateVal || alreadyLoadedThisDate) return;
      lastThumbDate = dateVal;
      thumbCache = {};  // clear cache for new date

      var isoDate = dateVal + "T12:00:00Z";

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
    function fetchBackendRHEPreview(dateStr, wavelength, onProgress) {
      dateStr = (dateStr || "").trim();
      if (!dateStr || !wavelength) return Promise.reject(new Error("Missing date or wavelength"));
      if (onProgress) onProgress(10, "Requesting RHE…");
      return fetch(API_BASE + "/api/generate_preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr, wavelength: wavelength, mission: "SDO" })
      }).then(function(res) { return res.json().then(function(data) { return { status: res.status, data: data }; }); })
        .then(function(result) {
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
              function poll() {
                if (onProgress) onProgress(20 + Math.min(50, (attempts / maxAttempts) * 50), "Generating RHE from science data…");
                fetch(API_BASE + "/api/generate_preview", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ date: dateStr, wavelength: wavelength, mission: "SDO" })
                }).then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
                  .then(function(pollResult) {
                    var d = pollResult.data;
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
                  .catch(reject);
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

    function showInfo(title, message) {
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      overlay.innerHTML =
        '<div class="modal-box">' +
          "<h3>" + title + "</h3>" +
          "<p>" + message + "</p>" +
          '<div class="modal-actions">' +
            '<button class="btn-confirm">OK</button>' +
          "</div>" +
        "</div>";
      document.body.appendChild(overlay);
      overlay.querySelector(".btn-confirm").addEventListener("click", function() {
        overlay.remove();
      });
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

    // ── Filter status line (console output under toggle) ────────
    var _filterStatusTimer = null;
    function updateFilterStatusLine(msg, type) {
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

    function updateRhefLoadingUI() {
      var el = document.getElementById("filterLoadingIndicator");
      if (el) {
        if (state.rhefFetching || state.hqFetching) el.classList.remove("hidden");
        else el.classList.add("hidden");
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
          showInfo("Run a local server",
            "In a terminal, go to the folder containing index.html (the api folder) and run:<br><br>" +
            "<code>python -m http.server 8000</code><br><br>" +
            "Then open <a href=\"http://localhost:8000\" target=\"_blank\" rel=\"noopener\">http://localhost:8000</a> in your browser."
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

      var cacheKey = date + "_" + wavelength + "_hq_" + format;
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
        wavelength: wavelength,
        mission: "SDO",
        detector: "AIA",
        format: format
      }, 180000).then(function(res) {
        if (!res.task_id || !res.status_url) throw new Error("HQ task failed to start");
        var statusUrl = API_BASE + res.status_url;
        setProgress(30);
        return pollStatus(statusUrl, function(data) {
          if (data.status === "started" || data.status === "processing") {
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
      // (for vignette centering) and by the circular-clip code below.
      var isCircularProduct = (state.selectedProduct === "wall_clock");

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
                           state.saturation !== 100 || state.inverted || state.vignette > 0;
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

      // ── Text overlay (live preview, not burned in) ────────────
      if (state.textOverlay && state.textOverlay.text) {
        var tov = state.textOverlay;
        ctx.save();
        ctx.font = "bold " + tov.size + "px '" + tov.font + "', sans-serif";
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
            ctx.strokeText(tov.text, tov.x, tov.y);
          }
          if (!tov.outlined) {
            ctx.fillStyle = tov.color;
            ctx.fillText(tov.text, tov.x, tov.y);
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
        var r = (cn.radiusPct != null ? cn.radiusPct : 42) / 100 * half;
        // Font size + stroke width are scaled by half / CLOCK_REF_HALF so the
        // numerals are always the same fraction of the clock face regardless
        // of whether the canvas is 512 (preview) or 1536 (HQ active) or 65
        // (mockup). Without this, after the HQ canvas-resolution bump the
        // user's "size = 28" became invisible in the editor and the mockup
        // path used a different multiplier — the two panes drifted out of
        // sync. CLOCK_REF_HALF=256 matches the original 512-px canvas so
        // existing slider values look the same as before.
        var CLOCK_REF_HALF = 256;
        var sizeUnit = cn.size != null ? cn.size : 28;
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
        state.vignette = 24;
        state.vignetteWidth = 0;
        state.vignetteFade = "black";
        state.vignetteFadeColor = "#000000";
        state.cropEdgeFeather = 0;
        state.textOverlay = null;
        state.textMode = false;
        if (state.selectedProduct) state.aspectFlippedByProduct[state.selectedProduct] = false;
        state.clockNumbers = null;
        if (typeof syncVignetteFadeUI === "function") syncVignetteFadeUI();
        $("#brightnessSlider").value = 0;
        $("#contrastSlider").value = 0;
        $("#saturationSlider").value = 100;
        $("#vignetteSlider").value = 100 - 24;
        $("#vigWidthSlider").value = 0;
        if ($("#cropEdgeSlider")) { $("#cropEdgeSlider").value = 0; $("#cropEdgeVal").textContent = "0"; }
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

    // ── Adjustments panel toggle ───────────────────────────────────
    // Tab switching (Tools / Geometry / Adjust)
    var adjustmentsBtnEl = null;   // no longer a standalone button — nulled so all guard checks are no-ops
    var adjustmentsPanelEl = null; // same
    (function() {
      var tabs = document.querySelectorAll(".edit-tab");
      tabs.forEach(function(tab) {
        tab.addEventListener("click", function() {
          tabs.forEach(function(t) { t.classList.remove("active"); });
          document.querySelectorAll(".edit-tab-panel").forEach(function(p) { p.classList.add("hidden"); });
          tab.classList.add("active");
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
      tile: 150,                 // zoomed-in detail crop
    };
    // Vignette is split into two presets so each axis is independently
    // selectable: EDGE controls feather softness (vignetteWidth), RADIUS
    // controls how much of the image is inside the clear region (vignette
    // intensity, where 0 = no vignette and higher = tighter circle).
    var VIGNETTE_EDGE_MODES = {
      sharp: 0,   // crisp circle
      soft:  22,  // feathered fade
    };
    var VIGNETTE_RADIUS_MODES = {
      off:  0,    // no vignette
      full: 12,   // gentle fade — vignette only catches the corners
      fit:  24,   // disk + breathing room (default)
      fill: 48,   // tight — close to the solar disk
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
      var v = VIGNETTE_RADIUS_MODES[modeName];
      if (v == null) return;
      state.vignette = v;
      state.cropEdgeFeather = 0;
      // vignetteSlider stores 100 - intensity (per existing convention at line 2609)
      var vs = $("#vignetteSlider"),  vv  = $("#vignetteVal");
      var ces = $("#cropEdgeSlider"), cev = $("#cropEdgeVal");
      if (vs)  { vs.value  = 100 - v; vv.textContent  = v; }
      if (ces) { ces.value = 0;       cev.textContent = 0; }
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
        if (state.vignette === VIGNETTE_RADIUS_MODES[k]) vigRadiusMode = k;
      });
      document.querySelectorAll(".preset-btn[data-vignette-radius]").forEach(function(btn) {
        btn.classList.toggle("active", btn.dataset.vignetteRadius === vigRadiusMode);
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
    function applyCropEdgeMask() {
      if (!solarCanvas) return;
      var v = state.cropEdgeFeather || 0;
      var blurEl = document.getElementById("cropEdgeFeatherBlur");
      if (blurEl) blurEl.setAttribute("stdDeviation", (v / 100) * 0.25);
      if (v <= 0) {
        solarCanvas.style.maskImage = "";
        solarCanvas.style.maskSize = "";
        solarCanvas.style.maskRepeat = "";
        solarCanvas.style.webkitMaskImage = "";
        solarCanvas.style.webkitMaskSize = "";
        solarCanvas.style.webkitMaskRepeat = "";
      } else {
        solarCanvas.style.maskImage = "url(#cropEdgeMask)";
        solarCanvas.style.maskSize = "100% 100%";
        solarCanvas.style.maskRepeat = "no-repeat";
        solarCanvas.style.webkitMaskImage = "url(#cropEdgeMask)";
        solarCanvas.style.webkitMaskSize = "100% 100%";
        solarCanvas.style.webkitMaskRepeat = "no-repeat";
      }
    }
    var cropEdgeSlider = $("#cropEdgeSlider");
    var cropEdgeVal = $("#cropEdgeVal");
    if (cropEdgeSlider) {
      cropEdgeSlider.addEventListener("input", function() {
        state.cropEdgeFeather = parseInt(cropEdgeSlider.value, 10);
        cropEdgeVal.textContent = state.cropEdgeFeather;
        applyCropEdgeMask();
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

      // Initialise overlay at centre of current canvas
      if (!state.textOverlay) {
        state.textOverlay = {
          text: textInput.value || "Hello Sun",
          x: solarCanvas.width / 2,
          y: solarCanvas.height / 2,
          size: parseInt(textSizeSlider.value, 10),
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
      state.textOverlay.text = textInput.value;
      state.textOverlay.size = parseInt(textSizeSlider.value, 10);
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
      var centerX = tov.x;
      var centerY = tov.y + radius; // arc center is below the text anchor

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
        size: clockNumbersSizeSlider ? parseInt(clockNumbersSizeSlider.value, 10) : 28,
        radiusPct: clockNumbersRadiusSlider ? parseInt(clockNumbersRadiusSlider.value, 10) : 42,
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
    var burnClockNumbersBtn = document.getElementById("burnClockNumbers");
    if (burnClockNumbersBtn) burnClockNumbersBtn.addEventListener("click", function() {
      applyClockNumbersFromPanel();
      // Render without frame overlay so the border isn't baked in
      state._burningCanvas = true;
      renderCanvas();
      state._burningCanvas = false;
      var dataUrlClock = solarCanvas.toDataURL("image/png");
      var newImg = new Image();
      newImg.onload = function() {
        state.originalImage = newImg;
        state.panX = newImg.naturalWidth / 2;
        state.panY = newImg.naturalHeight / 2;
        state.cropZoom = 100;
        if ($("#cropSlider")) { $("#cropSlider").value = 100; $("#cropVal").textContent = "100%"; }
        state.jpgImage = null;
        state.rawBackendImage = null;
        state.rhefImage = null;
        state.hqFilterImage = null;
        state.hqFormat = null;
        state.editorFilter = "jpg";
        _syncFilterToggleUI("jpg");
        state.clockNumbers = null;
        var clockPanel = document.getElementById("tabPanel_clock");
        if (clockPanel) clockPanel.classList.add("hidden");
        var panBtn = document.querySelector('[data-tool="pan"]');
        if (panBtn) panBtn.classList.add("active");
        renderCanvas();
        showToast("Clock numbers burned into image.");
      };
      newImg.src = dataUrlClock;
    });
    var cancelClockNumbersBtn = document.getElementById("cancelClockNumbers");
    if (cancelClockNumbersBtn) cancelClockNumbersBtn.addEventListener("click", function() {
      state.clockNumbers = null;
      var panel = document.getElementById("clockNumbersPanel");
      if (panel) panel.classList.add("hidden");
      document.querySelectorAll(".edit-toolbar .edit-btn[data-tool]").forEach(function(b) { b.classList.remove("active"); });
      var panBtn = document.querySelector('[data-tool="pan"]');
      if (panBtn) panBtn.classList.add("active");
      renderCanvas();
    });

    // ── Text drag handling on canvas ───────────────────────────
    function isInsideText(canvasX, canvasY) {
      if (!state.textOverlay || !state.textOverlay.text) return false;
      var tov = state.textOverlay;

      // Arc mode: use circular bounding region
      if (tov.arc && tov.arc.enabled) {
        var arcCenterY = tov.y + tov.arc.radius;
        var dx = canvasX - tov.x;
        var dy = canvasY - arcCenterY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        return Math.abs(dist - tov.arc.radius) < tov.size * 1.2;
      }

      // Straight text: rectangle hit test
      var ctx = solarCanvas.getContext("2d");
      ctx.save();
      ctx.font = "bold " + tov.size + "px '" + tov.font + "', sans-serif";
      var metrics = ctx.measureText(tov.text);
      ctx.restore();
      var hw = metrics.width / 2;
      var hh = tov.size / 2;
      return canvasX >= tov.x - hw && canvasX <= tov.x + hw &&
             canvasY >= tov.y - hh && canvasY <= tov.y + hh;
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
        return;
      }
      // Handle text dragging (takes priority over crop)
      if (state.textMode && state.textOverlay) {
        var coords = getCanvasCoords(e);
        if (isInsideText(coords.x, coords.y)) {
          e.preventDefault();
          textDragging = true;
          textDragOffsetX = coords.x - state.textOverlay.x;
          textDragOffsetY = coords.y - state.textOverlay.y;
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
        state.textOverlay.x = coords.x - textDragOffsetX;
        state.textOverlay.y = coords.y - textDragOffsetY;
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

    // Unified canvas pointer handlers (text drag + crop drag + pan)
    solarCanvas.addEventListener("mousedown", onCanvasPointerDown);
    solarCanvas.addEventListener("touchstart", onCanvasPointerDown, { passive: false });
    document.addEventListener("mousemove", onCanvasPointerMove);
    document.addEventListener("touchmove", onCanvasPointerMove, { passive: false });
    document.addEventListener("mouseup", onCanvasPointerUp);
    document.addEventListener("touchend", onCanvasPointerUp);

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
      // Circular overlay for round products (wall_clock)
      if (state.selectedProduct === "wall_clock") {
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
                           state.saturation !== 100 || state.inverted || state.vignette > 0;
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
        state.brightness || 0,
        state.contrast || 0,
        state.saturation || 100,
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
      // gallery pulls from the shared state.originalImage with its own
      // previewView framing so the gallery reads as variety. Both paths are
      // a single drawImage call — no per-card bitmap allocations.
      var isSelected = (productId === state.selectedProduct);
      var sourceCanvas = null;
      var shareSrc = null; // the shared raw solar image for non-selected cards
      if (isSelected) {
        sourceCanvas = (typeof getCleanCanvasSnapshot === "function")
          ? getCleanCanvasSnapshot()
          : solarCanvas;
      } else {
        shareSrc = state.originalImage;
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
        // Apparel silhouette with image on chest (1:1 print area)
        mctx.fillStyle = productId === "tshirt_unisex" ? "#e8e8e8" : "#d0d0d0";
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
          // Kangaroo pocket
          mctx.fillStyle = "rgba(0,0,0,0.1)";
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
          var radiusPct = (cn.radiusPct != null ? cn.radiusPct : 42) / 100;
          var numR = radiusPct * r;
          var numSize = (cn.size != null ? cn.size : 28) * (r / CLOCK_REF_HALF);
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
      } else if (productId === "throw_pillow" || productId === "mouse_pad" || productId === "sherpa_blanket" ||
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
        // Generic square fallback
        drawCropped(10, 10, 140, 140);
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
      var ar = state.variantAspectRatioByProduct && state.variantAspectRatioByProduct[product.id];
      if (!ar || !ar.w || !ar.h) ar = product.aspectRatio || null;
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
              prevBtn.addEventListener("click", function(e) { e.stopPropagation(); go(-1); });

              var nextBtn = document.createElement("button");
              nextBtn.className = "card-slide-nav card-slide-next";
              nextBtn.innerHTML = "&#8250;";
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
        state.cropEdgeFeather = 0;
        var cs = $("#cropSlider"),  cv  = $("#cropVal");
        var vs = $("#vignetteSlider"), vv = $("#vignetteVal");
        var vws = $("#vigWidthSlider"), vwv = $("#vigWidthVal");
        var ces = $("#cropEdgeSlider"), cev = $("#cropEdgeVal");
        if (cs)  { cs.value  = state.cropZoom;    cv.textContent  = state.cropZoom + "%"; }
        if (vs)  { vs.value  = 100 - state.vignette; vv.textContent = state.vignette; }
        if (vws) { vws.value = state.vignetteWidth;  vwv.textContent = state.vignetteWidth; }
        if (ces) { ces.value = state.cropEdgeFeather; cev.textContent = state.cropEdgeFeather; }
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
    function updateBuyButtonState() {
      if (!btnBuyInEditor) return;
      var ready = !!state.selectedProduct && _hasRealMockup();
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
    if (btnBuyInEditor) {
      btnBuyInEditor.addEventListener("click", function() {
        if (btnBuyInEditor.disabled) return;
        if (!state.selectedProduct) return;
        if (!_hasRealMockup()) return;
        var product = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
        if (product) startCheckout(product);
      });
      updateBuyButtonState();
    }

    // ── Full Catalog Browser ──────────────────────────────────────
    var catalogModal = document.getElementById("catalogModal");
    var catalogCache = null; // cached blueprint list

    $("#btnCatalog").addEventListener("click", function() {
      openCatalog();
    });

    function openCatalog() {
      catalogModal.classList.remove("hidden");
      catalogModal.innerHTML =
        '<div class="catalog-header">' +
          '<h2><i class="fas fa-th-large"></i> Printify Catalog</h2>' +
          '<input class="catalog-search" id="catSearch" type="text" placeholder="Search products…">' +
          '<button class="catalog-close" id="catClose"><i class="fas fa-times"></i></button>' +
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
      // Export the current solar canvas as a JPEG base64 string.
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

      var maxDim = 4096;
      var sw = solarCanvas.width;
      var sh = solarCanvas.height;
      var scale = Math.min(1, maxDim / Math.max(sw, sh));
      var ew = Math.round(sw * scale);
      var eh = Math.round(sh * scale);

      var exportCanvas = document.createElement("canvas");
      exportCanvas.width = ew;
      exportCanvas.height = eh;
      var ectx = exportCanvas.getContext("2d");
      ectx.drawImage(solarCanvas, 0, 0, ew, eh);

      var dataUrl = exportCanvas.toDataURL("image/jpeg", 0.85);

      // Restore on-screen view (with border/guides/text overlay) for the editor.
      state._burningCanvas = wasBurning || false;
      state._fullResRender = wasFullRes || false;
      try { renderCanvas(); } catch (_e) {}

      return dataUrl.split(",")[1];
    }

    // ── Auto-generate Printify mockups after preview ───────────
    var mockupStatus = $("#mockupStatus");

    /**
     * Generate Printify mockups.
     * @param {string} variant - "raw" or "filtered". Determines which cache + upload ID to use.
     * @param {string} [productId] - If provided, generate mockup only for this product (e.g. from floating preview pane).
     */
    function autoGenerateMockups(variant, productId) {
      variant = variant || "raw";
      var isFiltered = (variant !== "raw");
      var targetCache = isFiltered ? state.mockupsFiltered : state.mockupsRaw;
      var uploadIdKey = isFiltered ? "uploadedPrintifyIdFiltered" : "uploadedPrintifyIdRaw";

      var ready = PRODUCTS.filter(function(p) { return p.blueprintId && p.printProviderId && p.variantId; });
      if (productId) ready = ready.filter(function(p) { return p.id === productId; });
      if (ready.length === 0 || !state.originalImage) return;

      var needsMockup = ready.filter(function(p) { return !targetCache[p.id]; });
      if (needsMockup.length === 0) {
        // Already fully mocked for this variant; just update display
        updateMockupDisplay();
        return;
      }

      // Reuse existing upload if available
      if (state[uploadIdKey]) {
        var statusMsg = productId
          ? 'Generating mockup for ' + (needsMockup[0] ? needsMockup[0].name : productId) + '\u2026'
          : 'Generating ' + needsMockup.length + ' ' + variant + ' mockup(s)\u2026';
        mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> ' + statusMsg;
        runMockupQueue(needsMockup, targetCache, state[uploadIdKey], variant, productId);
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

      mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Uploading ' + variant + (productId ? ' for this product' : ' for mockups') + ' (' + Math.round(base64Data.length / 1024) + ' KB)\u2026';

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
        runMockupQueue(unmocked, targetCache, data.id, variant, productId);
      })
      .catch(function(err) {
        mockupStatus.innerHTML = '<span style="color:var(--accent-sun);font-size:12px;"><i class="fas fa-exclamation-triangle"></i> Mockups unavailable: ' + err.message + '</span>';
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
    function runMockupQueue(queue, targetCache, printifyImageId, variant, singleProductId) {
      var total = queue.length;
      var done = 0;

      function createNext() {
        if (queue.length === 0) {
          var doneMsg = singleProductId
            ? '<span style="color:#3ddc84;font-size:12px;"><i class="fas fa-check-circle"></i> Mockup ready</span>'
            : '<span style="color:#3ddc84;font-size:12px;"><i class="fas fa-check-circle"></i> All ' + total + ' ' + (variant || '') + ' mockup(s) ready</span>';
          mockupStatus.innerHTML = doneMsg;
          updateMockupDisplay();
          if (singleProductId && typeof updatePreviewPaneMockupState === "function") updatePreviewPaneMockupState();
          return;
        }
        var product = queue.shift();
        done++;
        mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Mockup ' + done + '/' + total + ': ' + product.name + '\u2026';

        // Use the user's currently-selected variant if they've picked one —
        // beta testers picked "Wooden Base / White hands" on the clock and
        // got back a black-base mockup because we were sending the catalog
        // default variantId (Black Base / Black) every time. Falls back to
        // product.variantId for products the user hasn't yet customised.
        var pickedVariantId = (state.selectedVariantByProduct[product.id] != null)
          ? state.selectedVariantByProduct[product.id]
          : product.variantId;
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
          }
          renderProducts();
          if (typeof updateBuyButtonState === "function") updateBuyButtonState();
          createNext();
        })
        .catch(function(err) {
          mockupStatus.innerHTML = '<span style="color:var(--accent-sun);font-size:12px;"><i class="fas fa-exclamation-triangle"></i> ' + product.name + ': ' + err.message + '</span>';
          setTimeout(createNext, 500);
        });
      }

      createNext();
    }

    // ── Checkout flow: Buy button → create → publish → Shopify ────
    var sendHint = $("#sendHint");
    var SHOPIFY_STORE = "solar-archive.myshopify.com"; // updated at runtime from store-config

    // Fetch store config on load
    fetchWithTimeout(API_BASE + "/api/printify/store-config", {}, 10000)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.shopify_store_domain) {
          SHOPIFY_STORE = data.shopify_store_domain;
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
        // covers this surface."
        state.cropZoom = 100;
        listEl.querySelectorAll(".confirm-variant-tile").forEach(function(t) {
          var match = parseInt(t.dataset.variantId, 10) === vid;
          t.classList.toggle("active", match);
          t.setAttribute("aria-selected", match ? "true" : "false");
        });
        _renderSummary(v);
        _renderMockup(v);
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
        var isRound = (product.id === "wall_clock");
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
          _selectInModal(pendingVariantId);
        } else {
          listEl.innerHTML = '<div class="confirm-variant-loading"><div class="spinner" style="width:16px;height:16px;display:inline-block;vertical-align:-3px;margin-right:6px;"></div> Loading sizes &amp; colors…</div>';
          _renderSummary(null);
          _renderMockup(null);
          loadVariants(product).then(function() {
            _renderTiles();
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
        continueBtn.removeEventListener("click", onContinueClick);
        closeBtn.removeEventListener("click", onCancel);
        backdrop.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey);
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
      function onKey(e) {
        if (e.key === "Escape") onCancel();
        else if (e.key === "Enter") { e.preventDefault(); onContinueClick(); }
      }

      listEl.addEventListener("click", onListClick);
      continueBtn.addEventListener("click", onContinueClick);
      closeBtn.addEventListener("click", onCancel);
      backdrop.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);

      modal.classList.remove("hidden");
      _bootstrap();
      setTimeout(function() { continueBtn.focus(); }, 40);
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
      var fab = document.getElementById("feedbackFab");
      var modal = document.getElementById("feedbackModal");
      if (!fab || !modal) return;

      var backdrop = document.getElementById("feedbackModalBackdrop");
      var closeBtn = document.getElementById("feedbackCloseBtn");
      var tabComment = document.getElementById("feedbackTabComment");
      var tabProduct = document.getElementById("feedbackTabProduct");
      var panelComment = document.getElementById("feedbackPanelComment");
      var panelProduct = document.getElementById("feedbackPanelProduct");
      var panelThanks = document.getElementById("feedbackPanelThanks");
      var commentBody = document.getElementById("feedbackCommentBody");
      var commentEmail = document.getElementById("feedbackCommentEmail");
      var commentSubmit = document.getElementById("feedbackCommentSubmit");
      var productSearch = document.getElementById("feedbackProductSearch");
      var productHint = document.getElementById("feedbackProductHint");
      var productResults = document.getElementById("feedbackProductResults");
      var productChosen = document.getElementById("feedbackProductChosen");
      var chosenName = document.getElementById("feedbackChosenName");
      var chosenBrand = document.getElementById("feedbackChosenBrand");
      var chosenClear = document.getElementById("feedbackChosenClear");
      var providerSelect = document.getElementById("feedbackProviderSelect");
      var variantSelect = document.getElementById("feedbackVariantSelect");
      var productNote = document.getElementById("feedbackProductNote");
      var productSubmit = document.getElementById("feedbackProductSubmit");
      var thanksMsg = document.getElementById("feedbackThanksMsg");
      var thanksAnother = document.getElementById("feedbackThanksAnother");

      // Blueprint catalog cache. Loaded lazily on first open of the Request tab.
      var _blueprints = null;
      var _blueprintsLoading = null;
      var _chosenBlueprint = null;
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

      function openModal() {
        modal.classList.remove("hidden");
        // Reset to comment tab each open
        showTab("comment");
        setTimeout(function() {
          if (commentBody) commentBody.focus();
        }, 60);
      }

      function closeModal() {
        modal.classList.add("hidden");
        // Clear form state so next open starts clean
        if (commentBody) commentBody.value = "";
        if (commentEmail) commentEmail.value = "";
        if (productSearch) productSearch.value = "";
        if (productResults) productResults.innerHTML = "";
        if (productNote) productNote.value = "";
        clearChosen();
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
        _blueprintsLoading = fetch(API_BASE + "/api/printify/blueprints")
          .then(function(r) { return r.json(); })
          .then(function(data) {
            _blueprints = Array.isArray(data) ? data : [];
            productHint.classList.add("hidden");
            renderResults(productSearch.value.trim());
          })
          .catch(function(err) {
            productHint.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Couldn\u2019t load catalog. Try again in a minute.';
            console.warn("[feedback] blueprints load failed:", err);
          })
          .finally(function() { _blueprintsLoading = null; });
      }

      function renderResults(query) {
        if (!_blueprints) return;
        if (!productResults) return;
        query = (query || "").toLowerCase().trim();
        var items;
        if (!query) {
          // No query: show a compact hint + recent popular categories
          productResults.innerHTML = '<div class="feedback-product-placeholder">Type above to search \u2014 try "tote", "wine", "pet", "ornament"&hellip;</div>';
          return;
        }
        items = _blueprints.filter(function(b) {
          var t = (b.title || "").toLowerCase();
          var br = (b.brand || "").toLowerCase();
          return t.indexOf(query) !== -1 || br.indexOf(query) !== -1;
        }).slice(0, 20);
        if (!items.length) {
          productResults.innerHTML = '<div class="feedback-product-placeholder">No matches for \u201c' + escapeHtml(query) + '\u201d.</div>';
          return;
        }
        productResults.innerHTML = items.map(function(b) {
          return '<button type="button" class="feedback-product-hit" data-bp="' + b.id + '">' +
                   '<span class="feedback-product-hit-title">' + escapeHtml(b.title || "") + '</span>' +
                   '<span class="feedback-product-hit-brand">' + escapeHtml(b.brand || "") + '</span>' +
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
        chosenBrand.textContent = bp.brand ? ("Brand: " + bp.brand) : "";
        productChosen.classList.remove("hidden");
        productResults.innerHTML = "";
        if (productSearch) productSearch.value = "";
        // Load providers
        providerSelect.innerHTML = '<option>Loading providers\u2026</option>';
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
                return '<option value="' + v.id + '" data-title="' + escapeHtml(v.title || "") + '">' +
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
      }

      function submitComment() {
        var body = (commentBody.value || "").trim();
        if (!body) {
          commentBody.focus();
          commentBody.classList.add("feedback-field-error");
          setTimeout(function() { commentBody.classList.remove("feedback-field-error"); }, 1500);
          return;
        }
        var payload = {
          kind: "comment",
          body: body,
          email: (commentEmail.value || "").trim() || null,
          url: window.location.href,
          user_agent: navigator.userAgent,
          context: captureContext(),
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

        var payload = {
          kind: "product_request",
          body: note || ("Request: " + (_chosenBlueprint.title || ("BP " + _chosenBlueprint.id))),
          url: window.location.href,
          user_agent: navigator.userAgent,
          context: captureContext(),
          product_request: {
            blueprintId: _chosenBlueprint.id,
            title: _chosenBlueprint.title || null,
            brand: _chosenBlueprint.brand || null,
            printProviderId: providerId,
            variantId: variantId,
            variantTitle: variantTitle || null,
          },
        };
        productSubmit.disabled = true;
        productSubmit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending\u2026';

        // Derive aspect ratio from the variant's placeholder if we can — the
        // rendering path needs something non-null to avoid showing a generic
        // 1:1 square for a 2:1 print area.
        var aspectRatio = { w: 1, h: 1 };
        try {
          var opts = variantSelect.selectedOptions[0];
          var vid = parseInt(opts && opts.value, 10);
          // variantSelect options were populated from /variants; we can re-resolve
          // placeholder dimensions by refetching, but for session purposes the
          // variant's size title carries enough signal. Default 1:1 is safe.
          if (opts && /(\d+)\s*[x×]\s*(\d+)/i.test(opts.textContent || "")) {
            var m = (opts.textContent || "").match(/(\d+)\s*[x×]\s*(\d+)/i);
            if (m) aspectRatio = { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
          }
        } catch (_e) { /* best-effort */ }

        sendFeedback(payload)
          .then(function() {
            // Build a session-only product entry so the user can use what they
            // just requested without waiting for admin approval.
            if (typeof makeProductFromRequest === "function" && typeof addToSessionCatalog === "function") {
              var sessionEntry = makeProductFromRequest(payload.product_request, { aspectRatio: aspectRatio });
              if (sessionEntry) {
                addToSessionCatalog(sessionEntry);
                // Merge into the live PRODUCTS array if not already present
                if (typeof PRODUCTS !== "undefined" && !PRODUCTS.find(function(p) { return p.id === sessionEntry.id; })) {
                  PRODUCTS.push(sessionEntry);
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
      fab.addEventListener("click", openModal);
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

      // Delegated click for product hits
      productResults.addEventListener("click", function(e) {
        var hit = e.target.closest(".feedback-product-hit");
        if (!hit) return;
        var bpId = parseInt(hit.dataset.bp, 10);
        var bp = (_blueprints || []).find(function(b) { return b.id === bpId; });
        if (bp) chooseBlueprint(bp);
      });

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