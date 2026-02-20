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
      vignette: 16,
      vignetteWidth: 0,
      vignetteFade: "transparent",  // "transparent" | "black" | "white" | "color"
      vignetteFadeColor: "#000000",
      cropEdgeFeather: 0,          // 0–100: feather at edges of crop viewport
      textMode: false,
      textOverlay: null,  // { text, x, y, size, font, color, strokeColor, strokeWidth }
      mockups: {},         // { productId: { images: [{src, position, is_default}], printifyProductId } }
      uploadedPrintifyId: null,  // reusable image ID from Printify upload
      hqImageUrl: null,   // URL of completed HQ PNG (separate from originalImage)
      hqTaskId: null,     // running HQ background task ID
      helioPreviewLoaded: false,  // true once a Helioviewer image is in the canvas
      editorFilter: "raw",       // "raw" | "rhef" | "hq" — only in editor, not on tiles
      rhefImage: null,           // RHE-processed image when editorFilter is "rhef"
      rawBackendImage: null,     // backend raw preview (no RHEF) for toggling with rhefImage
      rhefFetching: false,       // true while background RHEF fetch is in-flight
      rhefFetchPromise: null,    // Promise for in-flight RHEF fetch (deduplication)
      hqFilterImage: null,       // loaded HQ filtered Image object
      hqFetching: false,         // true while HQ generation is in progress
      mockupsRaw: {},            // cached mockups for raw version
      mockupsFiltered: {},       // cached mockups for filtered (RHEF/HQ) version
      uploadedPrintifyIdRaw: null,      // Printify upload ID for raw canvas
      uploadedPrintifyIdFiltered: null, // Printify upload ID for filtered canvas
      transitionInProgress: false       // prevents toggle spam during wipe animation
    };

    // ── Product catalog (Printify blueprint/provider/variant model) ──
    // IDs are pre-resolved from the live Printify catalog.
    // blueprintId = product type, printProviderId = fulfiller,
    // variantId = default size/color (customer picks final variant on Shopify).
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
      { id: "mug_15oz",             name: "Ceramic Mug — 15oz",  desc: "Large white ceramic mug, full-wrap print",  icon: "fa-mug-hot",      price: "From $14.99", checkoutPrice: 1499, blueprintId: 425,  printProviderId: 1,   variantId: 62014, position: "front", aspectRatio: { w: 2, h: 1 } },
      { id: "tumbler_20oz",         name: "Tumbler — 20oz",      desc: "Insulated stainless steel with lid",        icon: "fa-glass-whiskey", price: "From $19.99", checkoutPrice: 1999, blueprintId: 353,  printProviderId: 1,   variantId: 44519, position: "front", aspectRatio: { w: 2, h: 1 } },
      // ── Apparel ──
      { id: "tshirt_unisex",        name: "Unisex T-Shirt",      desc: "Bella+Canvas 3001 jersey tee, DTG print",   icon: "fa-tshirt",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 12,   printProviderId: 29,  variantId: 18052, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "hoodie_pullover",      name: "Pullover Hoodie",     desc: "Unisex heavy blend hooded sweatshirt",      icon: "fa-mitten",       price: "From $39.99", checkoutPrice: 3999, blueprintId: 77,   printProviderId: 29,  variantId: 32878, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "crewneck_sweatshirt",  name: "Crewneck Sweatshirt", desc: "Unisex heavy blend crewneck",               icon: "fa-vest",         price: "From $34.99", checkoutPrice: 3499, blueprintId: 49,   printProviderId: 29,  variantId: 25377, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "crew_socks",           name: "Crew Socks",          desc: "All-over sublimation print socks",          icon: "fa-socks",        price: "From $14.99", checkoutPrice: 1499, blueprintId: 365,  printProviderId: 14,  variantId: 44904, position: "front", aspectRatio: { w: 1, h: 1 } },
      // ── Tech & Desk ──
      { id: "phone_case",           name: "Phone Case",          desc: "Tough snap case, glossy finish",            icon: "fa-mobile-alt",   price: "From $19.99", checkoutPrice: 1999, blueprintId: 269,  printProviderId: 1,   variantId: 62582, position: "front", aspectRatio: { w: 9, h: 19 } },
      { id: "laptop_sleeve",        name: "Laptop Sleeve",       desc: "Padded neoprene sleeve, snug fit",          icon: "fa-laptop",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 429,  printProviderId: 1,   variantId: 62037, position: "front", aspectRatio: { w: 4, h: 3 } },
      { id: "mouse_pad",            name: "Mouse Pad",           desc: "Non-slip rubber base, smooth fabric top",   icon: "fa-mouse",        price: "From $11.99", checkoutPrice: 1199, blueprintId: 582,  printProviderId: 99,  variantId: 71665, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "desk_mat",             name: "Desk Mat",            desc: "Large-format mat for your workspace",       icon: "fa-desktop",      price: "From $24.99", checkoutPrice: 2499, blueprintId: 488,  printProviderId: 1,   variantId: 65240, position: "front", aspectRatio: { w: 2, h: 1 } },
      // ── Home & Living ──
      { id: "throw_pillow",         name: "Throw Pillow",        desc: "Spun polyester square pillow with insert",  icon: "fa-couch",        price: "From $22.99", checkoutPrice: 2299, blueprintId: 220,  printProviderId: 10,  variantId: 41521, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "sherpa_blanket",       name: "Sherpa Blanket",      desc: "Ultra-soft fleece with sherpa backing",     icon: "fa-cloud",        price: "From $44.99", checkoutPrice: 4499, blueprintId: 238,  printProviderId: 99,  variantId: 41656, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "shower_curtain",       name: "Shower Curtain",      desc: "Polyester shower curtain, vibrant print",   icon: "fa-shower",       price: "From $34.99", checkoutPrice: 3499, blueprintId: 235,  printProviderId: 10,  variantId: 41653, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "puzzle_1000",          name: "Jigsaw Puzzle",       desc: "252-piece puzzle in a tin box",             icon: "fa-puzzle-piece",  price: "From $24.99", checkoutPrice: 2499, blueprintId: 532,  printProviderId: 59,  variantId: 68984, position: "front", aspectRatio: { w: 1, h: 1 } },
      { id: "coaster_set",          name: "Coaster Set",         desc: "4-pack corkwood coasters, glossy top",      icon: "fa-circle",       price: "From $14.99", checkoutPrice: 1499, blueprintId: 510,  printProviderId: 48,  variantId: 72872, position: "front", aspectRatio: { w: 1, h: 1 } },
      // ── Accessories & Stationery ──
      { id: "sticker_kiss",         name: "Kiss-Cut Stickers",   desc: "Die-cut vinyl stickers, multiple sizes",    icon: "fa-sticky-note",  price: "From $2.99",  checkoutPrice: 299,  blueprintId: 400,  printProviderId: 99,  variantId: 45748, position: "front", aspectRatio: null },
      { id: "journal_hardcover",    name: "Hardcover Journal",   desc: "Matte hardcover, ruled pages",              icon: "fa-book",         price: "From $17.99", checkoutPrice: 1799, blueprintId: 485,  printProviderId: 28,  variantId: 65223, position: "front", aspectRatio: { w: 3, h: 4 } },
      { id: "backpack",             name: "Backpack",            desc: "All-over print, padded straps",             icon: "fa-bag-shopping", price: "From $44.99", checkoutPrice: 4499, blueprintId: 347,  printProviderId: 14,  variantId: 44419, position: "front", aspectRatio: null }
    ];

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

    var loadedFonts = { "Outfit": true, "JetBrains Mono": true }; // preloaded in HTML <link>

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

    // ── DOM refs ─────────────────────────────────────────────────
    var $ = function(sel) { return document.querySelector(sel); };
    var dateInput = $("#solarDate");
    var wlGrid = $("#wlGrid");
    var btnGenerate = $("#btnGenerate");
    var btnPreview = $("#btnPreview");
    var progressTrack = $("#progressTrack");
    var progressFill = $("#progressFill");
    var statusMsg = $("#statusMsg");
    var editSection = $("#editSection");
    var imageStage = $("#imageStage");
    var solarImg = $("#solarImg");
    var solarCanvas = $("#solarCanvas");
    var cropOverlay = $("#cropOverlay");
    var cropControls = $("#cropControls");
    var btnHQ = $("#btnHQ");
    var productSection = $("#productSection");
    var productGrid = $("#productGrid");
    var checkoutProgress = $("#checkoutProgress");
    var orderStatus = $("#orderStatus");
    var toastEl = $("#toast");
    var backendBanner = $("#backendBanner");
    var cspNotice = $("#cspNotice");

    // ── Init date ────────────────────────────────────────────────
    (function initDate() {
      var d = new Date();
      d.setDate(d.getDate() - 8);
      dateInput.value = d.toISOString().split("T")[0];
      dateInput.min = "2010-05-15";
      var maxD = new Date();
      maxD.setDate(maxD.getDate() - 7);
      dateInput.max = maxD.toISOString().split("T")[0];
    })();

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
    function loadHelioviewerPreview(wl, dateVal) {
      setStatus('<i class="fas fa-spinner fa-spin"></i> Loading ' + wl + ' Å preview…', true);
      setProgress(10);

      // Get raw canvas from thumbCache or fetch fresh
      var cached = thumbCache[String(wl)];
      if (cached && cached.canvas1024) {
        _startPreviewFromCanvas(cached.canvas1024, cached, wl, dateVal);
      } else {
        // Fetch high-res unfiltered preview for main canvas (1024px, image_scale=12 → 1.5 R_sun FOV)
        var isoDate = dateVal + "T12:00:00Z";
        var url = API_BASE + "/api/helioviewer_thumb?date=" +
          encodeURIComponent(isoDate) + "&wavelength=" + wl +
          "&image_scale=12&size=1024";

        var img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = function() {
          var rawC = document.createElement("canvas");
          rawC.width = img.naturalWidth || 1024;
          rawC.height = img.naturalHeight || 1024;
          rawC.getContext("2d").drawImage(img, 0, 0);
          var entry = thumbCache[String(wl)] || { raw: null, rhef: null, canvas1024: null };
          entry.canvas1024 = rawC;
          thumbCache[String(wl)] = entry;
          _startPreviewFromCanvas(rawC, entry, wl, dateVal);
        };
        img.onerror = function() {
          setStatus('<i class="fas fa-exclamation-triangle" style="color:var(--accent-flare);"></i> ' +
            'Preview failed — check date and backend status.', false);
          hideProgress();
        };
        img.src = url;
      }
    }

    /**
     * Install the raw high-res image in the editor immediately (no RHE on load).
     * Science-image request is fired in the background to warm the cache.
     */
    function _startPreviewFromCanvas(rawCanvas, cacheEntry, wl, dateVal) {
      var rawImg = new Image();
      rawImg.onload = function() {
        _installPreviewImage(rawImg, wl, dateVal);
      };
      rawImg.src = rawCanvas.toDataURL("image/png");
    }

    /**
     * Install a loaded Image object as the working preview, reset editing state,
     * and reveal the edit / product sections. Called both from Helioviewer click
     * and (legacy path) from the NASA preview flow.
     */
    function _installPreviewImage(img, wl, dateVal) {
      state.originalImage = img;
      state.rhefImage = null;
      state.rawBackendImage = null;
      state.editorFilter = "raw";
      state.rotation = 0;
      state.flipH = false;
      state.flipV = false;
      state.inverted = false;
      state.brightness = 0;
      state.contrast = 0;
      state.saturation = 100;
      state.vignette = 16;
      state.vignetteWidth = 0;
      state.vignetteFade = "transparent";
      state.vignetteFadeColor = "#000000";
      state.cropEdgeFeather = 0;
      state.textOverlay = null;
      state.textMode = false;
      state.mockups = {};
      state.mockupsRaw = {};
      state.mockupsFiltered = {};
      state.uploadedPrintifyId = null;
      state.uploadedPrintifyIdRaw = null;
      state.uploadedPrintifyIdFiltered = null;
      state.hqReady = false;
      state.hqImageUrl = null;
      state.hqTaskId = null;
      state.hqFilterImage = null;
      state.hqFetching = false;
      state.rhefFetching = false;
      state.rhefFetchPromise = null;
      state.transitionInProgress = false;
      state.helioPreviewLoaded = true;

      // Reset filter toggle UI to Raw
      _syncFilterToggleUI("raw");

      // Auto-fetch RHEF in background and switch to it when ready
      if (API_BASE && dateVal && wl) {
        // Check thumbCache for an already-cached RHEF image for this wavelength
        var cachedEntry = thumbCache[String(wl)];
        if (cachedEntry && cachedEntry.rhef) {
          state.rhefImage = cachedEntry.rhef;
          state.rawBackendImage = cachedEntry.rawBackend || null;
          setTimeout(function() {
            applyFilterInstant("rhef");
            showToast("Filtered version loaded! Click Raw to switch back.", "info");
          }, 100);
        } else {
          state.rhefFetching = true;
          updateFilterStatusLine("Generating filtered version\u2026", "loading");
          state.rhefFetchPromise = fetchBackendRHEPreview(dateVal, wl, function(pct, msg) {
            updateFilterStatusLine(msg || "Generating filtered version\u2026", "loading");
          }).then(function(ob) {
            var rhefImg = ob.filteredImg;
            state.rhefImage = rhefImg;
            state.rawBackendImage = ob.rawImg || null;
            state.rhefFetching = false;
            state.rhefFetchPromise = null;
            // Cache in thumbCache
            var entry = thumbCache[String(wl)] || {};
            entry.rhef = rhefImg;
            entry.rawBackend = state.rawBackendImage;
            thumbCache[String(wl)] = entry;
            updateFilterStatusLine("Filtered version ready!", "success");
            applyFilterInstant("rhef");
            showToast("Filtered version loaded! Click Raw to switch back.", "info");
          }).catch(function(err) {
            console.error("[RHEF] Background fetch failed:", err);
            state.rhefFetching = false;
            state.rhefFetchPromise = null;
            updateFilterStatusLine("", "hidden");
          });
        }
      }

      if (typeof updateSendToPrintifyButton === "function") updateSendToPrintifyButton();

      // Reset slider UI
      $("#brightnessSlider").value = 0;
      $("#contrastSlider").value = 0;
      $("#saturationSlider").value = 100;
      $("#vignetteSlider").value = 100 - 16;
      $("#vigWidthSlider").value = 0;
      $("#brightnessVal").textContent = "0";
      $("#contrastVal").textContent = "0";
      $("#saturationVal").textContent = "100";
      $("#vignetteVal").textContent = "16";
      $("#vigWidthVal").textContent = "0";
      if ($("#cropSlider")) { $("#cropSlider").value = 100; $("#cropVal").textContent = "100%"; }
      state.cropZoom = 100;
      state.panX = 0;
      state.panY = 0;
      if (solarCanvas) applyCanvasView();
      if ($("#textToolPanel")) $("#textToolPanel").classList.add("hidden");
      if ($("#adjustmentsPanel")) $("#adjustmentsPanel").classList.add("hidden");
      var textToolBtn = document.querySelector('[data-tool="text"]');
      if (textToolBtn) textToolBtn.classList.remove("active");
      var adjustmentsBtn = document.getElementById("adjustmentsBtn");
      if (adjustmentsBtn) adjustmentsBtn.classList.remove("active");
      if (solarCanvas) solarCanvas.classList.remove("text-dragging");
      if ($("#mockupStatus")) $("#mockupStatus").innerHTML = "";

      renderCanvas();
      setProgress(100);
      setStatus('<i class="fas fa-check-circle" style="color:#3ddc84;"></i> ' + wl + ' Å loaded — edit below (use Raw/RHEF in toolbar), then click <strong>Make Products</strong>');
      showToast(wl + " Å loaded!");

      editSection.classList.remove("hidden");
      imageStage.classList.remove("empty");
      if (btnPreview) btnPreview.classList.remove("hidden");
      btnGenerate.classList.remove("hidden");
      productSection.classList.remove("hidden");
      renderProducts();
      if (typeof updateSendToPrintifyButton === "function") updateSendToPrintifyButton();

      setTimeout(hideProgress, 1200);
    }

    // ── Wavelength thumbnail previews via Helioviewer (proxied + client RHE) ──
    var HELIO_SOURCE_IDS = { 94: 8, 131: 9, 171: 10, 193: 11, 211: 12, 304: 13, 335: 14, 1600: 15, 1700: 16 };
    var lastThumbDate = "";
    var thumbCache = {};  // { "wl": { raw: <canvas>, canvas1024: <canvas>, rhef: <Image> } } — tiles show raw

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

    function loadWavelengthThumbnails() {
      var dateVal = (dateInput && dateInput.value) ? String(dateInput.value).trim() : "";
      if (!dateVal && dateInput) {
        var d = new Date();
        d.setDate(d.getDate() - 8);
        dateVal = d.toISOString().split("T")[0];
        dateInput.value = dateVal;
      }
      var thumbDivs = document.querySelectorAll(".wl-thumb");
      var thumbCount = thumbDivs ? thumbDivs.length : 0;
      var alreadyLoadedThisDate = dateVal === lastThumbDate && Object.keys(thumbCache).length > 0;
      console.log("[tiles] loadWavelengthThumbnails", { dateVal: dateVal, lastThumbDate: lastThumbDate, thumbCount: thumbCount, alreadyLoadedThisDate: alreadyLoadedThisDate });
      if (!dateVal || alreadyLoadedThisDate) return;
      lastThumbDate = dateVal;
      thumbCache = {};  // clear cache for new date

      var isoDate = dateVal + "T12:00:00Z";

      thumbDivs.forEach(function(div) {
        var wl = parseInt(div.dataset.wl, 10);
        if (!HELIO_SOURCE_IDS[wl]) return;

        div.innerHTML = '<div class="wl-thumb-spinner"></div>';
        div.classList.remove("loaded");

        var directUrl = "https://api.helioviewer.org/v2/takeScreenshot/?" +
          "date=" + encodeURIComponent(isoDate) +
          "&imageScale=11.7&layers=[SDO,AIA,AIA," + wl + ",1,100]" +
          "&x0=0&y0=0&width=256&height=256&display=true&watermark=false";

        var tileImg = document.createElement("img");
        tileImg.alt = wl + " Å";
        tileImg.style.width = "100%";
        tileImg.style.height = "100%";
        tileImg.style.objectFit = "cover";
        tileImg.style.borderRadius = "50%";
        tileImg.onload = function() {
          thumbCache[wl] = { raw: null, canvas1024: null, rhef: null };
          div.classList.add("loaded");
          console.log("[tiles] loaded", wl);
        };
        tileImg.onerror = function() {
          div.innerHTML = "";
          console.log("[tiles] error", wl);
        };
        div.innerHTML = "";
        div.appendChild(tileImg);
        tileImg.src = directUrl;
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
            return { filteredUrl: API_BASE + result.data.preview_url, rawUrl: result.data.preview_raw_url ? API_BASE + result.data.preview_raw_url : null };
          }
          if (result.status === 202) {
            return new Promise(function(resolve, reject) {
              var attempts = 0;
              var maxAttempts = 60; // 2 minutes at 2s intervals
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
                      resolve({ filteredUrl: API_BASE + d.preview_url, rawUrl: d.preview_raw_url ? API_BASE + d.preview_raw_url : null });
                      return;
                    }
                    if (pollResult.status === 200 && !d.preview_url) {
                      reject(new Error(d.error || "No VSO data for this date"));
                      return;
                    }
                    attempts++;
                    if (attempts >= maxAttempts) reject(new Error("RHE preview timed out after 2 minutes"));
                    else setTimeout(poll, 3000);
                  })
                  .catch(reject);
              }
              // Give the background task a head-start before first poll
              setTimeout(poll, 3000);
            });
          }
          return Promise.reject(new Error(result.data.error || result.data.detail || "No preview_url"));
        })
        .then(function(urls) {
          return new Promise(function(resolve, reject) {
            var filteredImg = new Image();
            var rawImg = urls.rawUrl ? new Image() : null;
            var done = 0;
            var need = rawImg ? 2 : 1;
            function maybeResolve() {
              if (++done >= need) {
                if (onProgress) onProgress(100, "Done");
                resolve({ filteredImg: filteredImg, rawImg: rawImg });
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

    function _syncFilterToggleUI(filterValue) {
      var toggleEl = document.getElementById("editorFilterToggle");
      if (!toggleEl) return;
      var radio = toggleEl.querySelector('input[value="' + filterValue + '"]');
      if (radio) radio.checked = true;
      toggleEl.querySelectorAll(".filter-opt").forEach(function(opt) {
        opt.classList.remove("active");
      });
      var activeLabel = radio && radio.closest(".filter-opt");
      if (activeLabel) activeLabel.classList.add("active");
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
    }

    // ── Editor filter: Raw ↔ RHEF ↔ HQ (radio: only one selected; instant when cached) ──
    var editorFilterToggleEl = document.getElementById("editorFilterToggle");
    if (editorFilterToggleEl) {
      editorFilterToggleEl.addEventListener("change", function(e) {
        var radio = e.target;
        if (radio.name !== "editorFilter" || radio.type !== "radio") return;
        var newFilter = radio.value;
        if (newFilter === state.editorFilter) return;

        if (newFilter === "hq") {
          if (state.hqFilterImage) {
            applyFilterInstant("hq");
          } else {
            editorFilterToggleEl.querySelector('input[value="' + state.editorFilter + '"]').checked = true;
            if (state.hqFetching) {
              showToast("HQ is generating, please wait\u2026", "info");
              return;
            }
            showModal(
              "High-Quality Filter",
              "This will generate a full-resolution filtered image (3000\u00d73000px, 300 DPI). " +
              "It may take about a minute. Continue?",
              function() {
                startHqFilterGeneration(dateInput.value, state.wavelength);
              },
              "Generate HQ"
            );
          }
          return;
        }

        if (newFilter === "rhef") {
          if (state.rhefImage) {
            applyFilterInstant("rhef");
          } else if (state.rhefFetching) {
            showToast("Filtered version is generating, please wait\u2026", "info");
            editorFilterToggleEl.querySelector('input[value="' + state.editorFilter + '"]').checked = true;
          } else {
            var dateVal = dateInput ? dateInput.value : "";
            if (API_BASE && dateVal) {
              editorFilterToggleEl.querySelector('input[value="' + state.editorFilter + '"]').checked = true;
              state.rhefFetching = true;
              updateFilterStatusLine("Requesting RHEF\u2026", "loading");
              fetchBackendRHEPreview(dateVal, state.wavelength, function(pct, msg) {
                updateFilterStatusLine(msg || "Generating filtered version\u2026", "loading");
              }).then(function(ob) {
                state.rhefImage = ob.filteredImg;
                state.rawBackendImage = ob.rawImg || null;
                state.rhefFetching = false;
                updateFilterStatusLine("Filtered version ready!", "success");
                applyFilterInstant("rhef");
                showToast("Filtered version loaded! Click Raw to switch back.", "info");
              }).catch(function(err) {
                console.error("[RHEF] Fetch failed:", err);
                state.rhefFetching = false;
                updateFilterStatusLine("RHEF unavailable for this date", "error");
              });
            } else {
              editorFilterToggleEl.querySelector('input[value="' + state.editorFilter + '"]').checked = true;
              showToast("RHEF requires backend and date.", "error");
            }
          }
          return;
        }

        // "raw" selected — always instant (originalImage or rawBackendImage)
        applyFilterInstant("raw");
      });
      _syncFilterToggleUI(state.editorFilter);
    }

    // Load thumbnails on date change and on initial page load
    if (dateInput) {
      dateInput.addEventListener("change", loadWavelengthThumbnails);
      dateInput.addEventListener("input", loadWavelengthThumbnails);
    }
    setTimeout(loadWavelengthThumbnails, 0);
    setTimeout(loadWavelengthThumbnails, 400);

    // ── Toast ────────────────────────────────────────────────────
    var toastTimer = null;
    function showToast(msg, type) {
      type = type || "success";
      toastEl.textContent = msg;
      toastEl.className = "toast " + type;
      requestAnimationFrame(function() { toastEl.classList.add("show"); });
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function() { toastEl.classList.remove("show"); }, 4000);
    }

    // ── Custom modals (no alert/confirm/prompt) ──────────────────
    function showModal(title, message, onConfirm, confirmText) {
      confirmText = confirmText || "OK";
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
      overlay.querySelector(".btn-cancel").addEventListener("click", function() {
        overlay.remove();
      });
      overlay.querySelector(".btn-confirm").addEventListener("click", function() {
        overlay.remove();
        if (onConfirm) onConfirm();
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
      btnGenerate.disabled = true;

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

    function onBackendOnline() {
      state.backendOnline = true;
      btnGenerate.disabled = false;
      setBannerState("online", "Backend online", "Connected to " + API_BASE, false);
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
      btnGenerate.disabled = true;
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
      btnGenerate.disabled = true;
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
      btnGenerate.disabled = true;
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

    // ── "Preview Products" button — generate real Printify mockups from current canvas as-is ──
    if (btnPreview) {
      btnPreview.addEventListener("click", function() {
        if (!state.originalImage) {
          showInfo("No Image", "Click a wavelength tile to load the solar image first.");
          return;
        }
        if (!state.backendOnline) {
          showInfo("Backend Offline",
            "The backend is needed to upload the image and generate mockups. Please wait for it to come online."
          );
          return;
        }
        // Clear caches so we upload current canvas and create fresh mockups (no HQ required)
        state.mockups = {};
        state.mockupsRaw = {};
        state.mockupsFiltered = {};
        state.uploadedPrintifyId = null;
        state.uploadedPrintifyIdRaw = null;
        state.uploadedPrintifyIdFiltered = null;
        productSection.classList.remove("hidden");
        renderProducts();
        if ($("#mockupStatus")) $("#mockupStatus").innerHTML = "";
        showToast("Generating real mockups from current canvas…");
        autoGenerateMockups("raw");
      });
    }

    // ── "Make Products" button — fires HQ generation + mockups in parallel ───
    btnGenerate.addEventListener("click", function() {
      if (!state.originalImage) {
        showInfo("No Image", "Click a wavelength tile to load the solar image first.");
        return;
      }
      if (!state.backendOnline) {
        showInfo("Backend Offline",
          "The backend server is not responding. Please wait for it to come online, " +
          "or check the Render dashboard.<br><br>" +
          '<a href="https://dashboard.render.com" target="_blank" rel="noopener" ' +
          'style="color:var(--accent-cool);">Open Render Dashboard →</a>'
        );
        return;
      }

      var date = dateInput.value;
      if (!date) {
        showInfo("Missing Date", "Please select a date before generating.");
        return;
      }

      // Reset HQ state if restarting
      state.hqReady = false;
      state.hqImageUrl = null;
      state.hqTaskId = null;

      // Disable button while HQ is running, show status
      btnGenerate.disabled = true;
      btnGenerate.innerHTML = '<div class="spinner" style="border-top-color:#fff;display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> HQ generating…';

      setStatus('<i class="fas fa-rocket"></i> Starting HQ rendering + mockups in parallel…', true);
      setProgress(10);

      // ── Track A: Start mockups immediately from current canvas ──
      state.mockups = {};
      state.mockupsRaw = {};
      state.mockupsFiltered = {};
      state.uploadedPrintifyId = null;
      state.uploadedPrintifyIdRaw = null;
      state.uploadedPrintifyIdFiltered = null;
      productSection.classList.remove("hidden");
      renderProducts();
      // Generate raw mockups first
      setTimeout(function() {
        autoGenerateMockups("raw");
        // If filtered image is available, also generate filtered mockups
        if (state.rhefImage || state.hqFilterImage) {
          setTimeout(function() { autoGenerateMockups("filtered"); }, 500);
        }
      }, 300);

      // ── Track B: Start HQ generation in background ──────────────
      startHqGeneration(date, state.wavelength).then(function(hqUrl) {
        state.hqImageUrl = hqUrl;
        state.hqReady = true;
        updateSendToPrintifyButton();
        btnGenerate.disabled = false;
        btnGenerate.innerHTML = '<i class="fas fa-check-circle" style="color:#3ddc84;"></i> HQ Ready · Make Again';
        setStatus('<i class="fas fa-check-circle" style="color:#3ddc84;"></i> HQ image ready — buy buttons are live!');
        showToast("HQ print image ready!", "success");
        setTimeout(hideProgress, 1200);
      }).catch(function(err) {
        btnGenerate.disabled = false;
        btnGenerate.innerHTML = '<i class="fas fa-redo"></i> Retry HQ';
        setStatus('<i class="fas fa-exclamation-triangle" style="color:var(--accent-flare);"></i> HQ failed: ' + (err.message || err), false);
        showToast("HQ failed: " + (err.message || err), "error");
        hideProgress();
      });
    });

    /**
     * Start a background HQ generation task and poll until done.
     * Returns a Promise that resolves with the absolute HQ image URL.
     */
    function startHqGeneration(date, wavelength) {
      // Check client-side cache first
      var cacheKey = date + "_" + wavelength;
      var cached = hqCache[cacheKey];
      if (cached && cached.url) {
        state.hqImageUrl = cached.url;
        return Promise.resolve(cached.url);
      }

      return postJSON(API_BASE + "/api/generate", {
        date: date,
        wavelength: wavelength,
        mission: "SDO",
        detector: "AIA"
      }, 120000).then(function(res) {
        if (!res.task_id || !res.status_url) throw new Error("HQ task failed to start");
        state.hqTaskId = res.task_id;

        var statusUrl = API_BASE + res.status_url;
        setProgress(30);
        return pollStatus(statusUrl, function(data) {
          if (data.status === "started" || data.status === "processing") {
            setStatus('<i class="fas fa-spinner fa-spin"></i> HQ rendering in background… mockups generating below', true);
            setProgress(50);
          }
        });
      }).then(function(result) {
        if (result.status === "completed" && result.image_url) {
          var hqUrl = result.image_url.startsWith("/") ? API_BASE + result.image_url : result.image_url;
          hqCache[cacheKey] = { url: hqUrl, imageObj: null };
          setProgress(90);
          return hqUrl;
        }
        throw new Error(result.message || "HQ generation failed");
      });
    }

    /**
     * Start HQ filtered image generation (3000px, 300dpi).
     * Shows progress in filter status line, transitions to HQ on completion.
     */
    function startHqFilterGeneration(date, wavelength) {
      var cacheKey = date + "_" + wavelength + "_hq";
      var cached = hqCache[cacheKey];
      if (cached && cached.imageObj) {
        state.hqFilterImage = cached.imageObj;
        applyFilterInstant("hq");
        showToast("HQ filtered image ready!", "success");
        return Promise.resolve(cached.imageObj);
      }

      state.hqFetching = true;
      setProgress(10);
      updateFilterStatusLine("HQ generation in progress (may take ~60s)\u2026", "loading");

      return postJSON(API_BASE + "/api/generate", {
        date: date,
        wavelength: wavelength,
        mission: "SDO",
        detector: "AIA"
      }, 180000).then(function(res) {
        if (!res.task_id || !res.status_url) throw new Error("HQ task failed to start");
        var statusUrl = API_BASE + res.status_url;
        setProgress(30);
        return pollStatus(statusUrl, function(data) {
          if (data.status === "started" || data.status === "processing") {
            setProgress(50);
            updateFilterStatusLine("HQ rendering in progress\u2026", "loading");
          }
        });
      }).then(function(result) {
        if (result.status === "completed" && result.image_url) {
          var hqUrl = result.image_url.startsWith("/") ? API_BASE + result.image_url : result.image_url;
          setProgress(85);
          updateFilterStatusLine("Loading HQ image\u2026", "loading");
          return loadImage(hqUrl).then(function(img) {
            state.hqFilterImage = img;
            state.hqFetching = false;
            hqCache[cacheKey] = { url: hqUrl, imageObj: img };
            setProgress(100);
            hideProgress();
            updateFilterStatusLine("HQ filter ready!", "success");
            applyFilterInstant("hq");
            showToast("HQ filtered image ready!", "success");
            return img;
          });
        }
        throw new Error(result.message || "HQ generation failed");
      }).catch(function(err) {
        state.hqFetching = false;
        hideProgress();
        updateFilterStatusLine("HQ generation failed: " + err.message, "error");
        showToast("HQ failed: " + (err.message || err), "error");
        return Promise.reject(err);
      });
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
    function renderCanvas() {
      if (!state.originalImage) return;
      var img;
      if (state.editorFilter === "hq" && state.hqFilterImage) img = state.hqFilterImage;
      else if (state.editorFilter === "rhef" && state.rhefImage) img = state.rhefImage;
      else if (state.editorFilter === "raw" && state.rawBackendImage) img = state.rawBackendImage;
      else img = state.originalImage;
      var ctx = solarCanvas.getContext("2d");

      // Compute dimensions with rotation
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      var rotated = (state.rotation % 180 !== 0);
      var cw = rotated ? h : w;
      var ch = rotated ? w : h;

      solarCanvas.width = cw;
      solarCanvas.height = ch;

      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate((state.rotation * Math.PI) / 180);
      ctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();

      // Apply brightness/contrast/saturation via pixel manipulation
      var needsPixelWork = state.brightness !== 0 || state.contrast !== 0 ||
                           state.saturation !== 100 || state.inverted || state.vignette > 0;
      if (needsPixelWork) {
        var imageData = ctx.getImageData(0, 0, cw, ch);
        var d = imageData.data;
        var br = state.brightness;
        var co = state.contrast / 100;
        var factor = (259 * (co * 255 + 255)) / (255 * (259 - co * 255));
        var sat = state.saturation / 100;

        // Vignette params
        var applyVignette = state.vignette > 0;
        var cx = cw / 2;
        var cy = ch / 2;
        var maxR = Math.sqrt(cx * cx + cy * cy);
        // vignetteRadius: at 0 => no effect, at 100 => very tight circle
        // We map slider 0–100 to radius factor 1.0–0.1
        var radiusFactor = 1.0 - (state.vignette / 100) * 0.9;
        var vigR = maxR * radiusFactor;
        // vignetteWidth: 0 = hard crop (no feather), 100 = full smooth feather
        var vigWidthFactor = state.vignetteWidth / 100;

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

          // Vignette — fade to transparent / black / white / color outside radius
          if (applyVignette) {
            var px = (i / 4) % cw;
            var py = Math.floor((i / 4) / cw);
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
              } else if (fade === "color") {
                var hex = (state.vignetteFadeColor || "#000000").replace(/^#/, "");
                var fr = parseInt(hex.substr(0, 2), 16);
                var fg = parseInt(hex.substr(2, 2), 16);
                var fb = parseInt(hex.substr(4, 2), 16);
                r = r * (1 - t) + fr * t;
                g = g * (1 - t) + fg * t;
                b = b * (1 - t) + fb * t;
              }
            }
          }

          d[i] = Math.max(0, Math.min(255, r));
          d[i + 1] = Math.max(0, Math.min(255, g));
          d[i + 2] = Math.max(0, Math.min(255, b));
        }

        ctx.putImageData(imageData, 0, 0);
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
      if (typeof applyCropEdgeMask === "function") applyCropEdgeMask();
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
        state.vignette = 16;
        state.vignetteWidth = 0;
        state.vignetteFade = "transparent";
        state.vignetteFadeColor = "#000000";
        state.cropEdgeFeather = 0;
        state.textOverlay = null;
        state.textMode = false;
        if (typeof syncVignetteFadeUI === "function") syncVignetteFadeUI();
        $("#brightnessSlider").value = 0;
        $("#contrastSlider").value = 0;
        $("#saturationSlider").value = 100;
        $("#vignetteSlider").value = 100 - 16;
        $("#vigWidthSlider").value = 0;
        if ($("#cropEdgeSlider")) { $("#cropEdgeSlider").value = 0; $("#cropEdgeVal").textContent = "0"; }
        $("#brightnessVal").textContent = "0";
        $("#contrastVal").textContent = "0";
        $("#saturationVal").textContent = "100";
        $("#vignetteVal").textContent = "16";
        $("#vigWidthVal").textContent = "0";
        if (typeof applyCropEdgeMask === "function") applyCropEdgeMask();
        if ($("#cropSlider")) { $("#cropSlider").value = 100; $("#cropVal").textContent = "100%"; }
        state.cropZoom = 100;
        state.panX = 0;
        state.panY = 0;
        applyCanvasView();
        document.querySelector('[data-tool="invert"]').classList.remove("active");
        document.querySelector('[data-tool="pan"]').classList.remove("active");
        document.querySelector('[data-tool="text"]').classList.remove("active");
        $("#adjustmentsBtn").classList.remove("active");
        $("#textToolPanel").classList.add("hidden");
        $("#adjustmentsPanel").classList.add("hidden");
        exitCropMode();
        renderCanvas();
      } else if (tool === "crop") {
        document.querySelector('[data-tool="pan"]').classList.remove("active");
        if (adjustmentsPanelEl) { adjustmentsPanelEl.classList.add("hidden"); }
        if (adjustmentsBtnEl) adjustmentsBtnEl.classList.remove("active");
        enterCropMode();
      } else if (tool === "pan") {
        document.querySelector('[data-tool="crop"]').classList.remove("active");
        if (adjustmentsPanelEl) { adjustmentsPanelEl.classList.add("hidden"); }
        if (adjustmentsBtnEl) adjustmentsBtnEl.classList.remove("active");
        exitCropMode();
        btn.classList.add("active");
        solarCanvas.style.cursor = "grab";
      } else if (tool === "text") {
        if (adjustmentsPanelEl) { adjustmentsPanelEl.classList.add("hidden"); }
        if (adjustmentsBtnEl) adjustmentsBtnEl.classList.remove("active");
        enterTextMode();
      }
    });

    // ── Adjustments panel toggle ───────────────────────────────────
    var adjustmentsBtnEl = document.getElementById("adjustmentsBtn");
    var adjustmentsPanelEl = document.getElementById("adjustmentsPanel");
    if (adjustmentsBtnEl && adjustmentsPanelEl) {
      adjustmentsBtnEl.addEventListener("click", function() {
        document.querySelectorAll(".edit-toolbar .edit-btn").forEach(function(b) {
          if (b !== adjustmentsBtnEl) b.classList.remove("active");
        });
        adjustmentsPanelEl.classList.toggle("hidden");
        adjustmentsBtnEl.classList.toggle("active", !adjustmentsPanelEl.classList.contains("hidden"));
      });
    }

    // ── Sliders ──────────────────────────────────────────────────
    function setupSlider(sliderId, valId, stateKey, refreshMockups) {
      var slider = $("#" + sliderId);
      var valEl = $("#" + valId);
      slider.addEventListener("input", function() {
        state[stateKey] = parseInt(slider.value, 10);
        valEl.textContent = slider.value;
        renderCanvas();
        if (refreshMockups && typeof renderProducts === "function") renderProducts();
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
        renderCanvas();
        if (typeof renderProducts === "function") renderProducts();
      });
    }
    setupSlider("vigWidthSlider", "vigWidthVal", "vignetteWidth", true);

    // ── Vignette fade: filter-style toggle (transparent / black / white / color) ──
    function syncVignetteFadeUI() {
      var toggle = document.getElementById("vignetteFadeToggle");
      if (!toggle) return;
      var current = state.vignetteFade || "transparent";
      toggle.querySelectorAll(".filter-opt").forEach(function(opt) {
        var radio = opt.querySelector('input[name="vignetteFade"]');
        if (radio) {
          if (radio.value === current) radio.checked = true;
          opt.classList.toggle("active", radio.checked);
        }
      });
      var picker = $("#vignetteFadeColorPicker");
      if (picker) picker.value = state.vignetteFadeColor || "#000000";
    }
    var vignetteFadeToggle = document.getElementById("vignetteFadeToggle");
    if (vignetteFadeToggle) {
      vignetteFadeToggle.addEventListener("change", function(e) {
        if (e.target.name !== "vignetteFade") return;
        state.vignetteFade = e.target.value || "transparent";
        syncVignetteFadeUI();
        renderCanvas();
        if (typeof renderProducts === "function") renderProducts();
      });
    }
    var vignetteFadeColorPicker = $("#vignetteFadeColorPicker");
    if (vignetteFadeColorPicker) {
      vignetteFadeColorPicker.addEventListener("input", function() {
        state.vignetteFadeColor = vignetteFadeColorPicker.value;
        if (state.vignetteFade === "color") {
          renderCanvas();
          if (typeof renderProducts === "function") renderProducts();
        }
      });
      vignetteFadeColorPicker.addEventListener("change", function() {
        if (state.vignetteFade === "color") {
          renderCanvas();
          if (typeof renderProducts === "function") renderProducts();
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
        if (typeof renderProducts === "function") renderProducts();
      });
    }

    // ── Crop slider + pan: view transform (scale + translate) ──
    function applyCanvasView() {
      if (!solarCanvas) return;
      solarCanvas.style.transform = "translate(" + state.panX + "px," + state.panY + "px) scale(" + (state.cropZoom / 100) + ")";
    }
    var cropSlider = $("#cropSlider");
    var cropVal = $("#cropVal");
    if (cropSlider) {
      cropSlider.addEventListener("input", function() {
        var pct = parseInt(cropSlider.value, 10);
        state.cropZoom = pct;
        cropVal.textContent = pct + "%";
        applyCanvasView();
        // Refresh mockups to reflect new crop viewport
        if (typeof renderProducts === "function") renderProducts();
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
    var textDragging = false;
    var textDragOffsetX = 0;
    var textDragOffsetY = 0;

    function enterTextMode() {
      state.textMode = true;
      document.querySelector('[data-tool="text"]').classList.add("active");
      textToolPanel.classList.remove("hidden");

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

    // Live-update text overlay as the user types / changes controls
    function syncTextOverlay() {
      if (!state.textOverlay) return;
      state.textOverlay.text = textInput.value;
      state.textOverlay.size = parseInt(textSizeSlider.value, 10);
      state.textOverlay.font = textFontSelect.value;
      state.textOverlay.color = textColorPicker.value;
      state.textOverlay.strokeColor = textStrokePicker.value;
      state.textOverlay.strokeWidth = parseInt(textStrokeWidthSlider.value, 10);
      renderCanvas();
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

    // Apply text (burn into image permanently)
    $("#applyText").addEventListener("click", function() {
      if (!state.textOverlay || !state.textOverlay.text) {
        showInfo("No Text", "Enter some text to apply.");
        return;
      }
      // Render one final time (already done), then capture canvas as new originalImage
      renderCanvas();
      var newImg = new Image();
      newImg.onload = function() {
        state.originalImage = newImg;
        state.rotation = 0;
        state.flipH = false;
        state.flipV = false;
        state.textOverlay = null;
        state.textMode = false;
        textToolPanel.classList.add("hidden");
        document.querySelector('[data-tool="text"]').classList.remove("active");
        solarCanvas.classList.remove("text-dragging");
        renderCanvas();
        showToast("Text applied to image!");
      };
      newImg.src = solarCanvas.toDataURL("image/png");
    });

    // Cancel text overlay
    $("#cancelText").addEventListener("click", function() {
      exitTextMode();
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
        panStartPanX = state.panX;
        panStartPanY = state.panY;
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
      if (state.cropping) {
        startCropDrag(e);
      }
    }

    function onCanvasPointerMove(e) {
      var clientX = e.touches ? e.touches[0].clientX : e.clientX;
      var clientY = e.touches ? e.touches[0].clientY : e.clientY;
      if (panDragging) {
        e.preventDefault();
        state.panX = panStartPanX + (clientX - panStartClientX);
        state.panY = panStartPanY + (clientY - panStartClientY);
        applyCanvasView();
        if (typeof renderProducts === "function") renderProducts();
        return;
      }
      if (textDragging && state.textOverlay) {
        e.preventDefault();
        var coords = getCanvasCoords(e);
        state.textOverlay.x = coords.x - textDragOffsetX;
        state.textOverlay.y = coords.y - textDragOffsetY;
        renderCanvas();
        return;
      }
      if (cropDragging) {
        moveCropDrag(e);
      }
    }

    function onCanvasPointerUp() {
      if (panDragging) {
        panDragging = false;
        if (isPanToolActive()) solarCanvas.style.cursor = "grab";
        // Refresh mockups to reflect new pan position
        if (typeof renderProducts === "function") renderProducts();
        return;
      }
      if (textDragging) {
        textDragging = false;
        return;
      }
      endCropDrag();
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

    function updateProductCropButton() {
      var btn = document.getElementById("cropProductBtn");
      if (!btn) return;
      var product = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
      if (product && product.aspectRatio) {
        btn.classList.remove("hidden");
        btn.innerHTML = '<i class="fas fa-box" style="font-size:10px;"></i> ' +
          product.aspectRatio.w + ":" + product.aspectRatio.h + " " + product.name;
      } else {
        btn.classList.add("hidden");
      }
    }

    function syncCropRatioUI() {
      cropControls.querySelectorAll(".crop-ratio-btn").forEach(function(b) {
        b.classList.remove("active");
        var ratio = b.dataset.ratio;
        if (ratio === "product") {
          var product = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
          if (product && product.aspectRatio && state.cropRatio === (product.aspectRatio.w + ":" + product.aspectRatio.h))
            b.classList.add("active");
        } else if (ratio === state.cropRatio) {
          b.classList.add("active");
        }
      });
      var anyActive = cropControls.querySelector(".crop-ratio-btn.active");
      if (!anyActive) {
        var oneToOne = cropControls.querySelector('.crop-ratio-btn[data-ratio="1:1"]');
        if (oneToOne) oneToOne.classList.add("active");
      }
    }

    function enterCropMode() {
      state.cropping = true;
      cropControls.classList.remove("hidden");
      solarCanvas.style.cursor = "crosshair";
      state.cropStart = null;
      state.cropEnd = null;
      cropOverlay.classList.add("hidden");

      // Show product crop button and auto-select if a product is selected
      updateProductCropButton();
      if (state.selectedProduct) {
        var product = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
        if (product && product.aspectRatio) {
          state.cropRatio = product.aspectRatio.w + ":" + product.aspectRatio.h;
        }
      }
      syncCropRatioUI();
    }

    function exitCropMode() {
      state.cropping = false;
      cropControls.classList.add("hidden");
      cropOverlay.classList.add("hidden");
      solarCanvas.style.cursor = isPanToolActive() ? "grab" : "default";
      cropDragging = false;
    }

    cropControls.addEventListener("click", function(e) {
      var ratioBtn = e.target.closest(".crop-ratio-btn");
      if (ratioBtn) {
        cropControls.querySelectorAll(".crop-ratio-btn").forEach(function(b) { b.classList.remove("active"); });
        ratioBtn.classList.add("active");
        var ratio = ratioBtn.dataset.ratio;
        if (ratio === "product") {
          var product = PRODUCTS.find(function(p) { return p.id === state.selectedProduct; });
          state.cropRatio = (product && product.aspectRatio)
            ? product.aspectRatio.w + ":" + product.aspectRatio.h
            : "free";
        } else {
          state.cropRatio = ratio;
        }
        state.cropStart = null;
        state.cropEnd = null;
        cropOverlay.classList.add("hidden");
      }
    });

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
    }

    $("#applyCrop").addEventListener("click", function() {
      if (!state.cropStart || !state.cropEnd) {
        showInfo("No Selection", "Drag on the image to select a crop area first.");
        return;
      }

      var x1 = Math.min(state.cropStart.x, state.cropEnd.x);
      var y1 = Math.min(state.cropStart.y, state.cropEnd.y);
      var w = Math.abs(state.cropEnd.x - state.cropStart.x);
      var h = Math.abs(state.cropEnd.y - state.cropStart.y);

      if (state.cropRatio !== "free") {
        var parts = state.cropRatio.split(":");
        var ratio = parseFloat(parts[0]) / parseFloat(parts[1]);
        h = w / ratio;
      }

      if (w < 10 || h < 10) {
        showInfo("Too Small", "Please make a larger crop selection.");
        return;
      }

      // Crop from canvas
      var ctx = solarCanvas.getContext("2d");
      var cropped = ctx.getImageData(
        Math.max(0, Math.round(x1)),
        Math.max(0, Math.round(y1)),
        Math.min(Math.round(w), solarCanvas.width - Math.round(x1)),
        Math.min(Math.round(h), solarCanvas.height - Math.round(y1))
      );

      // Create new image from cropped data
      var tempCanvas = document.createElement("canvas");
      tempCanvas.width = cropped.width;
      tempCanvas.height = cropped.height;
      tempCanvas.getContext("2d").putImageData(cropped, 0, 0);

      var newImg = new Image();
      newImg.onload = function() {
        state.originalImage = newImg;

        // Also crop RHEF and HQ filter images if they exist
        var cropRect = {
          x: Math.max(0, Math.round(x1)),
          y: Math.max(0, Math.round(y1)),
          w: Math.min(Math.round(w), solarCanvas.width - Math.round(x1)),
          h: Math.min(Math.round(h), solarCanvas.height - Math.round(y1))
        };
        if (state.rhefImage) {
          _cropFilterImage(state.rhefImage, cropRect, function(croppedImg) {
            state.rhefImage = croppedImg;
          });
        }
        if (state.rawBackendImage) {
          _cropFilterImage(state.rawBackendImage, cropRect, function(croppedImg) {
            state.rawBackendImage = croppedImg;
          });
        }
        if (state.hqFilterImage) {
          _cropFilterImage(state.hqFilterImage, cropRect, function(croppedImg) {
            state.hqFilterImage = croppedImg;
          });
        }

        // Invalidate mockup caches since image changed
        state.mockupsRaw = {};
        state.mockupsFiltered = {};
        state.mockups = {};
        state.uploadedPrintifyIdRaw = null;
        state.uploadedPrintifyIdFiltered = null;
        state.uploadedPrintifyId = null;

        state.rotation = 0;
        state.flipH = false;
        state.flipV = false;
        renderCanvas();
        exitCropMode();
        showToast("Image cropped!");
      };
      newImg.src = tempCanvas.toDataURL("image/png");
    });

    /**
     * Crop a filter image using the same transforms as the main canvas.
     * Renders the source image with current rotation/flip/pixel adjustments,
     * extracts the same crop region, and calls back with the cropped Image.
     */
    function _cropFilterImage(sourceImg, cropRect, callback) {
      // Render source with the same transforms that were active when user drew the crop
      var sw = sourceImg.naturalWidth;
      var sh = sourceImg.naturalHeight;
      var rotated = (state.rotation % 180 !== 0);
      var cw = rotated ? sh : sw;
      var ch = rotated ? sw : sh;

      var tmpCanvas = document.createElement("canvas");
      tmpCanvas.width = cw;
      tmpCanvas.height = ch;
      var tctx = tmpCanvas.getContext("2d");

      tctx.save();
      tctx.translate(cw / 2, ch / 2);
      tctx.rotate((state.rotation * Math.PI) / 180);
      tctx.scale(state.flipH ? -1 : 1, state.flipV ? -1 : 1);
      tctx.drawImage(sourceImg, -sw / 2, -sh / 2, sw, sh);
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
              } else if (fade === "color") {
                var hex = (state.vignetteFadeColor || "#000000").replace(/^#/, "");
                var fr = parseInt(hex.substr(0, 2), 16);
                var fg = parseInt(hex.substr(2, 2), 16);
                var fb = parseInt(hex.substr(4, 2), 16);
                r = r * (1 - t) + fr * t;
                g = g * (1 - t) + fg * t;
                b = b * (1 - t) + fb * t;
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

    $("#cancelCrop").addEventListener("click", exitCropMode);

    // ── HQ cache (used by startHqGeneration called from Make Products) ─
    var hqCache = {}; // key: "date_wavelength" => { url, imageObj }

    // btnHQ is now hidden; HQ fires automatically when Make Products is clicked.
    if (btnHQ) btnHQ.classList.add("hidden");

    // ── Products ─────────────────────────────────────────────────
    // ── Product mockup drawing ──────────────────────────────────

    /**
     * Return the visible portion of solarCanvas given the current crop-zoom and pan.
     * When cropZoom=100 and pan=0 the full canvas is visible.
     * Returns { sx, sy, sw, sh } in canvas pixel coordinates.
     */
    function _getCropViewport() {
      var cw = solarCanvas ? solarCanvas.width  : 0;
      var ch = solarCanvas ? solarCanvas.height : 0;
      var z  = (state.cropZoom || 100) / 100;   // e.g. 1.5 for 150%
      // Visible canvas dimensions at this zoom level
      var visW = cw / z;
      var visH = ch / z;
      // pan is in screen-space pixels; convert to canvas pixels (opposite sign: dragging right reveals left)
      var panCx = -(state.panX || 0) / z;
      var panCy = -(state.panY || 0) / z;
      // Center of the viewport in canvas coordinates
      var cx = cw / 2 + panCx;
      var cy = ch / 2 + panCy;
      // Clamp so we never sample outside the canvas
      var sx = Math.max(0, Math.min(cw - visW, cx - visW / 2));
      var sy = Math.max(0, Math.min(ch - visH, cy - visH / 2));
      var sw = Math.min(visW, cw - sx);
      var sh = Math.min(visH, ch - sy);
      return { sx: sx, sy: sy, sw: sw, sh: sh };
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

    function drawProductMockup(mctx, productId, sw, sh) {
      var W = 160, H = 160;
      mctx.fillStyle = "#1a1a2e";
      mctx.fillRect(0, 0, W, H);

      // Helper: draw solarCanvas into a destination rect respecting the crop-zoom viewport
      // and then aspect-ratio fitting within that viewport.
      function drawCropped(dstX, dstY, dstW, dstH) {
        var vp = _getCropViewport();              // visible region of solarCanvas
        var c  = _cropSrcForDst(vp.sw, vp.sh, dstW, dstH); // aspect-ratio fit inside viewport
        // c.{sx,sy,sw,sh} are relative to the viewport — offset by vp.{sx,sy}
        mctx.drawImage(solarCanvas,
          vp.sx + c.sx, vp.sy + c.sy, c.sw, c.sh,
          dstX, dstY, dstW, dstH);
      }

      if (productId === "mug_15oz" || productId === "tumbler_20oz" || productId === "desk_mat") {
        // Wide 2:1 products — mug body / wide rectangle
        var bodyL = 30, bodyR = 120, bodyT = 35, bodyB = 130;
        if (productId === "desk_mat") {
          bodyL = 5; bodyR = 155; bodyT = 45; bodyB = 115;
        } else if (productId === "tumbler_20oz") {
          bodyL = 38; bodyR = 112; bodyT = 28; bodyB = 138;
        }
        mctx.save();
        mctx.beginPath();
        mctx.moveTo(bodyL, bodyT + 8);
        mctx.quadraticCurveTo(bodyL, bodyT, bodyL + 8, bodyT);
        mctx.lineTo(bodyR - 8, bodyT);
        mctx.quadraticCurveTo(bodyR, bodyT, bodyR, bodyT + 8);
        mctx.lineTo(bodyR + 2, bodyB - 10);
        mctx.quadraticCurveTo(bodyR, bodyB, bodyR - 10, bodyB);
        mctx.lineTo(bodyL + 10, bodyB);
        mctx.quadraticCurveTo(bodyL, bodyB, bodyL - 2, bodyB - 10);
        mctx.closePath();
        mctx.clip();
        drawCropped(bodyL, bodyT, bodyR - bodyL, bodyB - bodyT);
        mctx.restore();
        if (productId !== "desk_mat") {
          // Handle
          mctx.strokeStyle = "#aaa";
          mctx.lineWidth = 4;
          mctx.beginPath();
          mctx.moveTo(bodyR, bodyT + 15);
          mctx.quadraticCurveTo(bodyR + 28, bodyT + 15, bodyR + 28, (bodyT + bodyB) / 2);
          mctx.quadraticCurveTo(bodyR + 28, bodyB - 15, bodyR, bodyB - 15);
          mctx.stroke();
        }
        // Rim highlight
        mctx.strokeStyle = "rgba(255,255,255,0.3)";
        mctx.lineWidth = 2;
        mctx.beginPath();
        mctx.moveTo(bodyL + 2, bodyT);
        mctx.lineTo(bodyR - 2, bodyT);
        mctx.stroke();
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
        // Poster 11:14 — taller than wide
        var pL = 25, pT = 10, pW = 110, pH = 140;
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
        // Square wall art
        var wL = 15, wT = 15, wW = 130, wH = 130;
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
        // Round clock — 1:1 circle
        var cx = 80, cy = 80, r = 65;
        mctx.save();
        mctx.beginPath();
        mctx.arc(cx, cy, r, 0, Math.PI * 2);
        mctx.clip();
        drawCropped(cx - r, cy - r, r * 2, r * 2);
        mctx.restore();
        mctx.strokeStyle = "#666";
        mctx.lineWidth = 3;
        mctx.beginPath();
        mctx.arc(cx, cy, r, 0, Math.PI * 2);
        mctx.stroke();
        mctx.strokeStyle = "#fff";
        mctx.lineWidth = 2;
        mctx.beginPath();
        mctx.moveTo(cx, cy);
        mctx.lineTo(cx - 20, cy - 35);
        mctx.stroke();
        mctx.beginPath();
        mctx.moveTo(cx, cy);
        mctx.lineTo(cx + 30, cy - 10);
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
      } else {
        // Generic square fallback
        drawCropped(10, 10, 140, 140);
      }
    }

    // ── Variant info panel ───────────────────────────────────────
    var variantCache = {};  // keyed by "blueprintId_printProviderId"

    function showVariantPanel(product, card) {
      // Hide all other variant panels
      productGrid.querySelectorAll(".variant-panel").forEach(function(vp) {
        if (vp.dataset.productId !== product.id) vp.classList.add("hidden");
      });

      var panel = card.querySelector(".variant-panel");
      if (!panel) return;

      // Toggle if already visible
      if (!panel.classList.contains("hidden")) {
        panel.classList.add("hidden");
        return;
      }

      var cacheKey = product.blueprintId + "_" + product.printProviderId;

      if (variantCache[cacheKey]) {
        renderVariantPanel(panel, product, variantCache[cacheKey]);
        panel.classList.remove("hidden");
        return;
      }

      // Show loading
      panel.innerHTML = '<div class="variant-loading"><div class="spinner" style="width:16px;height:16px;"></div> Loading sizes &amp; colors…</div>';
      panel.classList.remove("hidden");

      fetchWithTimeout(
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
          variantCache[cacheKey] = variants;
          renderVariantPanel(panel, product, variants);
        })
        .catch(function() {
          panel.innerHTML = '<div class="variant-loading" style="color:var(--text-dim);">Could not load variants</div>';
        });
    }

    function renderVariantPanel(panel, product, variants) {
      if (!variants.length) {
        panel.innerHTML = '<div class="variant-loading" style="color:var(--text-dim);">No variant info available</div>';
        return;
      }

      // Extract unique sizes and colors
      var sizes = [];
      var colors = [];
      var sizeSet = {};
      var colorSet = {};

      variants.forEach(function(v) {
        var opts = v.options || {};
        var size = opts.size || "";
        var color = opts.color || "";
        if (size && !sizeSet[size]) { sizeSet[size] = true; sizes.push(size); }
        if (color && !colorSet[color]) { colorSet[color] = true; colors.push(color); }
      });

      var html = '<div class="variant-summary">';
      html += '<span class="variant-count">' + variants.length + ' variants</span>';

      if (sizes.length > 0) {
        html += '<div class="variant-group"><span class="variant-group-label">Sizes:</span> ';
        html += sizes.map(function(s) { return '<span class="variant-tag">' + s + '</span>'; }).join(" ");
        html += '</div>';
      }

      if (colors.length > 0) {
        // Show first 12 colors, then "+N more"
        var shown = colors.slice(0, 12);
        var extra = colors.length - shown.length;
        html += '<div class="variant-group"><span class="variant-group-label">Colors:</span> ';
        html += shown.map(function(c) { return '<span class="variant-tag variant-color">' + c + '</span>'; }).join(" ");
        if (extra > 0) html += ' <span class="variant-more">+' + extra + ' more</span>';
        html += '</div>';
      }

      html += '</div>';
      panel.innerHTML = html;
    }

    function renderProducts() {
      productGrid.innerHTML = "";
      PRODUCTS.forEach(function(p) {
        var card = document.createElement("div");
        var hasMockup = state.mockups[p.id] && state.mockups[p.id].images && state.mockups[p.id].images.length > 0;
        var statusDot = hasMockup
          ? '<span style="color:#3ddc84;font-size:10px;" title="Printify mockup ready">●</span> '
          : (state.originalImage ? '<span style="color:#ff9800;font-size:10px;" title="Generating…">◌</span> ' : '');

        // Buy requires a preview image + blueprint; HQ can still be generating
        var canBuy = !!state.originalImage && p.blueprintId && p.printProviderId;
        var hqBadge = state.hqReady
          ? ' <span style="font-size:9px;color:#3ddc84;vertical-align:middle;" title="HQ print image ready">★HQ</span>'
          : (state.hqTaskId ? ' <span style="font-size:9px;color:#ff9800;vertical-align:middle;" title="HQ rendering…">⟳HQ</span>' : '');
        var buyLabel = !state.originalImage
          ? '<i class="fas fa-lock"></i> Select wavelength first'
          : (!p.blueprintId ? '<i class="fas fa-spinner fa-spin"></i> Resolving…' : '<i class="fas fa-shopping-cart"></i> Buy · ' + p.price + hqBadge);

        card.className = "product-card";
        card.innerHTML =
          '<div class="product-preview"><span class="product-icon"><i class="fas ' + p.icon + '"></i></span></div>' +
          '<div class="product-info">' +
            '<div class="product-name">' + statusDot + p.name + "</div>" +
            '<div class="product-desc">' + p.desc + "</div>" +
            '<div class="product-price">' + p.price + "</div>" +
            '<div class="variant-panel hidden" data-product-id="' + p.id + '"></div>' +
            '<button class="product-buy-btn" data-product-id="' + p.id + '"' +
              (canBuy ? '' : ' disabled') + '>' + buyLabel + '</button>' +
          "</div>";

        // Show real Printify mockup if available, else draw canvas mockup
        if (hasMockup) {
          var bestImg = state.mockups[p.id].images.find(function(m) { return m.is_default; }) || state.mockups[p.id].images[0];
          var img = document.createElement("img");
          img.className = "mockup-img";
          img.src = bestImg.src;
          img.alt = p.name + " mockup";
          img.loading = "lazy";
          card.querySelector(".product-preview").innerHTML = "";
          card.querySelector(".product-preview").appendChild(img);
        } else if (state.originalImage && solarCanvas.width > 0) {
          var miniCanvas = document.createElement("canvas");
          miniCanvas.width = 160;
          miniCanvas.height = 160;
          var mctx = miniCanvas.getContext("2d");
          drawProductMockup(mctx, p.id, solarCanvas.width, solarCanvas.height);
          card.querySelector(".product-preview").innerHTML = "";
          card.querySelector(".product-preview").appendChild(miniCanvas);
        }

        // Highlight selected product for crop suggestion
        if (state.selectedProduct === p.id) card.classList.add("selected");

        card.addEventListener("click", function(e) {
          // Don't interfere with buy button
          if (e.target.closest(".product-buy-btn")) return;
          state.selectedProduct = p.id;
          productGrid.querySelectorAll(".product-card").forEach(function(c) { c.classList.remove("selected"); });
          card.classList.add("selected");
          updateProductCropButton();
          // Set crop aspect ratio to this product's ratio (or 1:1 if product has none)
          state.cropRatio = (p.aspectRatio ? (p.aspectRatio.w + ":" + p.aspectRatio.h) : "1:1");
          syncCropRatioUI();
          if (p.aspectRatio) {
            showToast("Crop tip: use " + p.aspectRatio.w + ":" + p.aspectRatio.h + " for " + p.name);
          }
          // Show variant info panel
          showVariantPanel(p, card);
        });

        productGrid.appendChild(card);
      });

      // Bind buy button clicks
      productGrid.querySelectorAll(".product-buy-btn").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          var productId = btn.dataset.productId;
          var product = PRODUCTS.find(function(p) { return p.id === productId; });
          if (product) startCheckout(product);
        });
      });
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

      state.selectedProduct = newId;
      closeCatalog();
      renderProducts();
      showToast("Added: " + bpName);
    }

    // ── Canvas-to-base64 helper for Printify uploads ──────────
    function getCanvasBase64() {
      // Export the current solar canvas as a JPEG base64 string
      // We resize to max 4096px (print quality) and use JPEG to keep payload small
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

      // Use PNG for best quality (solar images have fine details)
      var dataUrl = exportCanvas.toDataURL("image/png");
      // Strip the "data:image/png;base64," prefix — Printify wants raw base64
      return dataUrl.split(",")[1];
    }

    // ── Auto-generate Printify mockups after preview ───────────
    var mockupStatus = $("#mockupStatus");

    /**
     * Generate Printify mockups.
     * @param {string} variant - "raw" or "filtered". Determines which cache + upload ID to use.
     */
    function autoGenerateMockups(variant) {
      variant = variant || "raw";
      var isFiltered = (variant !== "raw");
      var targetCache = isFiltered ? state.mockupsFiltered : state.mockupsRaw;
      var uploadIdKey = isFiltered ? "uploadedPrintifyIdFiltered" : "uploadedPrintifyIdRaw";

      var ready = PRODUCTS.filter(function(p) { return p.blueprintId && p.printProviderId && p.variantId; });
      if (ready.length === 0 || !state.originalImage) return;

      var needsMockup = ready.filter(function(p) { return !targetCache[p.id]; });
      if (needsMockup.length === 0) {
        // Already fully mocked for this variant; just update display
        updateMockupDisplay();
        return;
      }

      // Reuse existing upload if available
      if (state[uploadIdKey]) {
        mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Generating ' + needsMockup.length + ' ' + variant + ' mockup(s)\u2026';
        runMockupQueue(needsMockup, targetCache, state[uploadIdKey], variant);
        return;
      }

      // For filtered mockups, temporarily render with the filtered image
      var prevFilter = state.editorFilter;
      if (isFiltered && state.editorFilter === "raw") {
        if (state.rhefImage) {
          state.editorFilter = "rhef";
          renderCanvas();
        } else if (state.hqFilterImage) {
          state.editorFilter = "hq";
          renderCanvas();
        }
      }

      var fname = "solar_" + (dateInput.value || "image") + "_" + state.wavelength + "_" + variant + ".png";
      var base64Data = getCanvasBase64();

      // Restore filter state if we changed it
      if (state.editorFilter !== prevFilter) {
        state.editorFilter = prevFilter;
        renderCanvas();
      }

      mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Uploading ' + variant + ' for mockups (' + Math.round(base64Data.length / 1024) + ' KB)\u2026';

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
        runMockupQueue(unmocked, targetCache, data.id, variant);
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
     */
    function runMockupQueue(queue, targetCache, printifyImageId, variant) {
      var total = queue.length;
      var done = 0;

      function createNext() {
        if (queue.length === 0) {
          mockupStatus.innerHTML = '<span style="color:#3ddc84;font-size:12px;"><i class="fas fa-check-circle"></i> All ' + total + ' ' + (variant || '') + ' mockup(s) ready</span>';
          updateMockupDisplay();
          return;
        }
        var product = queue.shift();
        done++;
        mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Mockup ' + done + '/' + total + ': ' + product.name + '\u2026';

        var payload = {
          title: "[MOCKUP] Solar Preview — " + product.name,
          description: "Auto-generated mockup preview",
          blueprint_id: product.blueprintId,
          print_provider_id: product.printProviderId,
          variants: [{ id: product.variantId, price: 100, is_enabled: true }],
          print_areas: [{
            variant_ids: [product.variantId],
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
      // Re-render product buy buttons when HQ state changes
      renderProducts();
      if (state.hqReady) {
        sendHint.textContent = "★ HQ print image ready — buy buttons are live!";
        sendHint.style.color = "var(--accent-cool)";
      } else if (state.hqTaskId) {
        sendHint.textContent = "HQ image is rendering in the background — you can buy now and it will be used automatically.";
        sendHint.style.color = "var(--accent-sun)";
      } else if (state.originalImage) {
        sendHint.textContent = "Click Make Products to start HQ rendering and generate mockups.";
        sendHint.style.color = "var(--text-dim)";
      } else {
        sendHint.textContent = "Select a date and click a wavelength to load your solar image.";
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
        ? "The full NASA/SDO HQ image is ready and will be used for printing. 🌟"
        : (state.hqTaskId
            ? "The HQ image is still rendering — checkout will wait for it automatically before uploading to Printify."
            : "The preview image will be used. Click <strong>Make Products</strong> first for full HQ quality.");

      showModal(
        "Buy " + product.name,
        "This will create your custom <strong>" + product.name + "</strong> with your solar image and list it on Shopify with <strong>all available sizes and colors</strong>.<br><br>" +
          hqNote + "<br><br>" +
          "You'll pick your exact size, color, and options on Shopify's secure checkout.",
        function() { doCheckout(product); },
        "Create on Shopify"
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
                'Choose your size, color, and options on Shopify, then complete your purchase.' +
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
          showToast("Product created! Redirecting to Shopify…");
          setTimeout(function() { window.open(shopifyUrl, "_blank"); }, 1500);
        });
      })
      .catch(function(err) {
        var msg = err.message || String(err);
        try { msg = JSON.parse(msg).detail || msg; } catch(_e) {}
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

    // ── Shopify / Printify Dashboard ──────────────────────────────
    $("#btnShopify").addEventListener("click", function() {
      window.open("https://" + SHOPIFY_STORE, "_blank");
    });

    $("#btnPrintifyDash").addEventListener("click", function() {
      window.open("https://printify.com/app/products", "_blank");
    });

    // ── Render products on load (hidden until image generated) ──
    renderProducts();

  })();