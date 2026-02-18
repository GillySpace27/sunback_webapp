/* ===============================================================
   Solar Archive — Poe Canvas App
   =============================================================== */
(function () {
  "use strict";

  // ── Config ───────────────────────────────────────────────────
  // Derive API base from current origin so the same page works in local dev,
  // staging, and production without CORS complexity.
  var API_BASE = window.location.origin;
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
    selectedProduct: null,
    hqReady: false,
    lastImageUrl: "",
    backendOnline: false,
    vignette: 16,
    vignetteWidth: 0,
    textMode: false,
    textOverlay: null,  // { text, x, y, size, font, color, strokeColor, strokeWidth }
    mockups: {},         // { productId: { images: [{src, position, is_default}], printifyProductId } }
    uploadedPrintifyId: null  // reusable image ID from Printify upload
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

  // ── Wavelength selection ─────────────────────────────────────
  wlGrid.addEventListener("click", function(e) {
    var card = e.target.closest(".wl-card");
    if (!card) return;
    wlGrid.querySelectorAll(".wl-card").forEach(function(c) { c.classList.remove("selected"); });
    card.classList.add("selected");
    state.wavelength = parseInt(card.dataset.wl, 10);
  });

  // ── Wavelength thumbnail previews via Helioviewer (proxied + client RHE) ──
  var HELIO_SOURCE_IDS = { 94: 8, 131: 9, 171: 10, 193: 11, 211: 12, 304: 13, 335: 14, 1600: 15, 1700: 16 };
  var lastThumbDate = "";
  var thumbCache = {};  // { "wl": { raw: <canvas>, rhef: <canvas> } }
  var thumbFilter = "raw";  // "raw" or "rhef"

  /**
   * Client-side Radial Histogram Equalization.
   * For each 1-pixel-wide annulus centred on (cx,cy), sort pixel
   * luminances, replace each with its normalised rank, then write
   * back. This flattens the radial intensity fall-off and reveals
   * coronal structure.
   */
  function applyRHE(canvas) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var imageData = ctx.getImageData(0, 0, w, h);
    var d = imageData.data;
    var cx = w / 2, cy = h / 2;
    var maxR = Math.ceil(Math.sqrt(cx * cx + cy * cy));

    // Build annulus buckets: for each integer radius, collect {index, luminance}
    var annuli = new Array(maxR + 1);
    for (var r = 0; r <= maxR; r++) annuli[r] = [];

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        var dist = Math.round(Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)));
        if (dist > maxR) dist = maxR;
        annuli[dist].push({ idx: i, lum: lum });
      }
    }

    for (var r = 0; r <= maxR; r++) {
      var ring = annuli[r];
      if (ring.length < 2) continue;
      ring.sort(function(a, b) { return a.lum - b.lum; });
      for (var j = 0; j < ring.length; j++) {
        var rank = j / (ring.length - 1);
        var idx = ring[j].idx;
        var origLum = ring[j].lum;
        if (origLum > 0.5) {
          var scale = (rank * 255) / origLum;
          d[idx]     = Math.min(255, d[idx] * scale);
          d[idx + 1] = Math.min(255, d[idx + 1] * scale);
          d[idx + 2] = Math.min(255, d[idx + 2] * scale);
        } else {
          var v = rank * 255;
          d[idx] = v; d[idx + 1] = v; d[idx + 2] = v;
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }

  /** Clone a canvas element */
  function cloneCanvas(src) {
    var c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    c.getContext("2d").drawImage(src, 0, 0);
    return c;
  }

  /** Show the cached canvas (raw or rhef) for each thumbnail */
  function showThumbFilter() {
    document.querySelectorAll(".wl-thumb").forEach(function(div) {
      var wl = div.dataset.wl;
      var entry = thumbCache[wl];
      if (!entry) return;
      var src = (thumbFilter === "rhef" && entry.rhef) ? entry.rhef : entry.raw;
      if (!src) return;
      div.innerHTML = "";
      div.appendChild(cloneCanvas(src));
      div.classList.add("loaded");
    });
  }

  function loadWavelengthThumbnails() {
    var dateVal = dateInput.value;
    if (!dateVal || dateVal === lastThumbDate) return;
    lastThumbDate = dateVal;
    thumbCache = {};  // clear cache for new date

    var isoDate = dateVal + "T12:00:00Z";
    var thumbDivs = document.querySelectorAll(".wl-thumb");

    thumbDivs.forEach(function(div) {
      var wl = parseInt(div.dataset.wl, 10);
      if (!HELIO_SOURCE_IDS[wl]) return;

      div.innerHTML = '<div class="wl-thumb-spinner"></div>';
      div.classList.remove("loaded");

      // Use backend proxy (adds CORS headers for canvas pixel access)
      var url = API_BASE + "/api/helioviewer_thumb?date=" +
        encodeURIComponent(isoDate) + "&wavelength=" + wl +
        "&image_scale=12&size=256";

      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function() {
        // Build raw canvas
        var rawC = document.createElement("canvas");
        rawC.width = img.naturalWidth;
        rawC.height = img.naturalHeight;
        rawC.getContext("2d").drawImage(img, 0, 0);

        // Build RHEF canvas
        var rhefC = cloneCanvas(rawC);
        try { applyRHE(rhefC); } catch (e) { /* keep raw copy on failure */ }

        // Cache both
        thumbCache[wl] = { raw: rawC, rhef: rhefC };

        // Display whichever is selected
        var src = (thumbFilter === "rhef") ? rhefC : rawC;
        div.innerHTML = "";
        div.appendChild(cloneCanvas(src));
        div.classList.add("loaded");
      };
      img.onerror = function() {
        // Fall back to direct Helioviewer (no CORS, no RHE)
        var fallback = new Image();
        fallback.onload = function() {
          var rawC = document.createElement("canvas");
          rawC.width = fallback.naturalWidth || 256;
          rawC.height = fallback.naturalHeight || 256;
          rawC.getContext("2d").drawImage(fallback, 0, 0);
          thumbCache[wl] = { raw: rawC, rhef: null };
          div.innerHTML = "";
          div.appendChild(cloneCanvas(rawC));
          div.classList.add("loaded");
        };
        fallback.onerror = function() { div.innerHTML = ""; };
        fallback.src = "https://api.helioviewer.org/v2/takeScreenshot/?" +
          "date=" + encodeURIComponent(isoDate) +
          "&imageScale=12&layers=[SDO,AIA,AIA," + wl + ",1,100]" +
          "&x0=0&y0=0&width=256&height=256&display=true&watermark=false";
      };
      img.src = url;
    });
  }

  // Filter toggle: Raw ↔ RHEF (instant swap from cache)
  document.getElementById("filterToggle").addEventListener("change", function(e) {
    if (e.target.name === "thumbFilter") {
      thumbFilter = e.target.value;
      showThumbFilter();
    }
  });

  // Load thumbnails on date change and on initial page load
  dateInput.addEventListener("change", loadWavelengthThumbnails);
  setTimeout(loadWavelengthThumbnails, 500);

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

    // Phase 1: no-cors ping to check if the server is alive at all
    var abortCtrl = new AbortController();
    var timeout = setTimeout(function() { abortCtrl.abort(); }, HEALTH_TIMEOUT_MS);

    fetch(API_BASE + "/docs", { method: "GET", mode: "no-cors", signal: abortCtrl.signal })
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

    return fetch(API_BASE + "/docs", { method: "GET", signal: abortCtrl2.signal })
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

  // Run health check on load
  checkBackendHealth();

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

  // ── Generate Preview ─────────────────────────────────────────
  btnGenerate.addEventListener("click", function() {
    var date = dateInput.value;
    if (!date) {
      showInfo("Missing Date", "Please select a date before generating.");
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

    btnGenerate.disabled = true;
    setProgress(5);
    setStatus("Connecting to backend...", true);

    // Preview generation can take 30–60s if NASA's VSO is slow
    setProgress(10);
    setStatus("Requesting solar image from NASA/SDO via backend... (this may take 30–60s)", true);

    postJSON(API_BASE + "/api/generate_preview", {
      date: date,
      wavelength: state.wavelength,
      mission: "SDO"
    }, FETCH_TIMEOUT_MS).then(function(res) {
      setProgress(60);
      var previewUrl = res.preview_url || res.png_url;
      if (!previewUrl) throw new Error("No preview URL returned");

      // Resolve URL
      var fullUrl;
      if (previewUrl.startsWith("/")) {
        fullUrl = API_BASE + previewUrl;
      } else {
        fullUrl = previewUrl;
      }

      state.lastImageUrl = fullUrl;
      setStatus("Loading image...", true);
      setProgress(80);

      return loadImage(fullUrl);
    }).then(function(img) {
      state.originalImage = img;
      state.rotation = 0;
      state.flipH = false;
      state.flipV = false;
      state.inverted = false;
      state.brightness = 0;
      state.contrast = 0;
      state.saturation = 100;
      state.vignette = 16;
      state.vignetteWidth = 0;
      state.textOverlay = null;
      state.textMode = false;
      state.mockups = {};
      state.uploadedPrintifyId = null;
      state.hqReady = false;
      if (typeof updateSendToPrintifyButton === "function") updateSendToPrintifyButton();
      $("#brightnessSlider").value = 0;
      $("#contrastSlider").value = 0;
      $("#saturationSlider").value = 100;
      $("#vignetteSlider").value = 16;
      $("#vigWidthSlider").value = 0;
      $("#brightnessVal").textContent = "0";
      $("#contrastVal").textContent = "0";
      $("#saturationVal").textContent = "100";
      $("#vignetteVal").textContent = "16";
      $("#vigWidthVal").textContent = "0";
      if ($("#textToolPanel")) $("#textToolPanel").classList.add("hidden");
      var textToolBtn = document.querySelector('[data-tool="text"]');
      if (textToolBtn) textToolBtn.classList.remove("active");
      if (solarCanvas) solarCanvas.classList.remove("text-dragging");
      if ($("#mockupStatus")) $("#mockupStatus").innerHTML = "";

      renderCanvas();
      setProgress(100);
      setStatus('<i class="fas fa-check-circle" style="color:#3ddc84;"></i> Preview ready!');
      showToast("Solar image loaded!");

      editSection.classList.remove("hidden");
      imageStage.classList.remove("empty");
      btnHQ.classList.remove("hidden");
      productSection.classList.remove("hidden");
      renderProducts();

      // Auto-generate real Printify mockups in the background
      state.mockups = {};
      state.uploadedPrintifyId = null;
      setTimeout(autoGenerateMockups, 500);

      setTimeout(hideProgress, 1000);
    }).catch(function(err) {
      setProgress(0);
      hideProgress();

      // Decide which error UI to show
      var msg = err.message || String(err);
      if (msg.indexOf("Cannot reach backend") !== -1 || msg.indexOf("timed out") !== -1) {
        setStatus(
          '<i class="fas fa-exclamation-triangle" style="color:var(--accent-flare);"></i> ' +
          '<strong>Backend unreachable.</strong> ' + msg + '<br>' +
          '<button class="edit-btn" style="margin-top:8px;" onclick="document.getElementById(\'btnGenerate\').click();">' +
          '<i class="fas fa-redo"></i> Retry</button>',
          false
        );
        // Recheck health
        state.backendOnline = false;
        healthRetries = 0;
        checkBackendHealth();
      } else {
        setStatus(
          '<i class="fas fa-exclamation-triangle" style="color:var(--accent-flare);"></i> ' +
          'Error: ' + msg,
          false
        );
      }
      showToast("Failed: " + msg, "error");
    }).finally(function() {
      btnGenerate.disabled = false;
    });
  });

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
    var img = state.originalImage;
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

        // Vignette — fade to transparent outside radius
        if (applyVignette) {
          var px = (i / 4) % cw;
          var py = Math.floor((i / 4) / cw);
          var dx = px - cx;
          var dy = py - cy;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > vigR) {
            // vignetteWidth: 0 = hard crop, 100 = full smooth feather
            var maxFade = maxR - vigR;
            var fadeLen = maxFade * vigWidthFactor;
            var t = fadeLen > 0.5 ? Math.min((dist - vigR) / fadeLen, 1.0) : 1.0;
            // Smooth cubic falloff (smoothstep)
            t = t * t * (3 - 2 * t);
            d[i + 3] = d[i + 3] * (1 - t);  // fade alpha, not RGB
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
      state.textOverlay = null;
      state.textMode = false;
      $("#brightnessSlider").value = 0;
      $("#contrastSlider").value = 0;
      $("#saturationSlider").value = 100;
      $("#vignetteSlider").value = 16;
      $("#vigWidthSlider").value = 0;
      $("#brightnessVal").textContent = "0";
      $("#contrastVal").textContent = "0";
      $("#saturationVal").textContent = "100";
      $("#vignetteVal").textContent = "16";
      $("#vigWidthVal").textContent = "0";
      document.querySelector('[data-tool="invert"]').classList.remove("active");
      document.querySelector('[data-tool="text"]').classList.remove("active");
      $("#textToolPanel").classList.add("hidden");
      exitCropMode();
      renderCanvas();
    } else if (tool === "crop") {
      enterCropMode();
    } else if (tool === "text") {
      enterTextMode();
    }
  });

  // ── Sliders ──────────────────────────────────────────────────
  function setupSlider(sliderId, valId, stateKey) {
    var slider = $("#" + sliderId);
    var valEl = $("#" + valId);
    slider.addEventListener("input", function() {
      state[stateKey] = parseInt(slider.value, 10);
      valEl.textContent = slider.value;
      renderCanvas();
    });
  }

  setupSlider("brightnessSlider", "brightnessVal", "brightness");
  setupSlider("contrastSlider", "contrastVal", "contrast");
  setupSlider("saturationSlider", "saturationVal", "saturation");
  setupSlider("vignetteSlider", "vignetteVal", "vignette");
  setupSlider("vigWidthSlider", "vigWidthVal", "vignetteWidth");

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

  function onCanvasPointerDown(e) {
    // Handle text dragging first (takes priority)
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
    // Fall through to crop drag
    if (state.cropping) {
      startCropDrag(e);
    }
  }

  function onCanvasPointerMove(e) {
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
    if (textDragging) {
      textDragging = false;
      return;
    }
    endCropDrag();
  }

  // Unified canvas pointer handlers (text drag + crop drag)
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
        cropControls.querySelectorAll(".crop-ratio-btn").forEach(function(b) { b.classList.remove("active"); });
        var productBtn = document.getElementById("cropProductBtn");
        if (productBtn) productBtn.classList.add("active");
      }
    }
  }

  function exitCropMode() {
    state.cropping = false;
    cropControls.classList.add("hidden");
    cropOverlay.classList.add("hidden");
    solarCanvas.style.cursor = "default";
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
      state.rotation = 0;
      state.flipH = false;
      state.flipV = false;
      renderCanvas();
      exitCropMode();
      showToast("Image cropped!");
    };
    newImg.src = tempCanvas.toDataURL("image/png");
  });

  $("#cancelCrop").addEventListener("click", exitCropMode);

  // ── HQ Generation (with client-side cache) ──────────────────
  var hqCache = {}; // key: "date_wavelength" => { url, imageObj }

  function getHqCacheKey() {
    return dateInput.value + "_" + state.wavelength;
  }

  btnHQ.addEventListener("click", function() {
    var date = dateInput.value;
    if (!date) return;

    // Check client-side cache first
    var cacheKey = getHqCacheKey();
    var cached = hqCache[cacheKey];
    if (cached) {
      state.lastImageUrl = cached.url;
      state.hqReady = true;
      updateSendToPrintifyButton();
      if (cached.imageObj) {
        state.originalImage = cached.imageObj;
        renderCanvas();
      }
      showToast("HQ image loaded from cache!");
      btnHQ.innerHTML = '<i class="fas fa-check"></i> HQ Ready (cached)';
      setTimeout(function() {
        btnHQ.innerHTML = '<i class="fas fa-star"></i> Generate HQ Print-Ready Image';
      }, 2000);
      return;
    }

    btnHQ.disabled = true;
    btnHQ.innerHTML = '<div class="spinner" style="border-top-color:#fff;"></div> Generating HQ...';

    postJSON(API_BASE + "/api/generate", {
      date: date,
      wavelength: state.wavelength,
      mission: "SDO",
      detector: "AIA"
    }, 120000).then(function(res) {
      if (!res.task_id || !res.status_url) throw new Error("HQ task failed to start");

      var statusUrl = API_BASE + res.status_url;
      return pollStatus(statusUrl, function(data) {
        if (data.status === "started" || data.status === "processing") {
          btnHQ.innerHTML = '<div class="spinner" style="border-top-color:#fff;"></div> Processing...';
        }
      });
    }).then(function(result) {
      if (result.status === "completed" && result.image_url) {
        var hqUrl = result.image_url.startsWith("/") ? API_BASE + result.image_url : result.image_url;
        state.lastImageUrl = hqUrl;
        state.hqReady = true;
        updateSendToPrintifyButton();

        // Cache the URL immediately
        hqCache[cacheKey] = { url: hqUrl, imageObj: null };

        showToast("HQ image ready! Print quality enabled.");

        return loadImage(hqUrl).then(function(img) {
          state.originalImage = img;
          // Cache the image object too
          hqCache[cacheKey].imageObj = img;
          renderCanvas();
        }).catch(function() {
          // Image loaded but couldn't be drawn with CORS — still store the URL
        });
      } else if (result.status === "failed") {
        throw new Error(result.message || "HQ generation failed");
      }
    }).catch(function(err) {
      showToast("HQ error: " + err.message, "error");
    }).finally(function() {
      btnHQ.disabled = false;
      btnHQ.innerHTML = '<i class="fas fa-star"></i> Generate HQ Print-Ready Image';
    });
  });

  // ── Products ─────────────────────────────────────────────────
  // ── Product mockup drawing ──────────────────────────────────
  function drawProductMockup(mctx, productId, sw, sh) {
    var W = 160, H = 160;
    mctx.fillStyle = "#1a1a2e";
    mctx.fillRect(0, 0, W, H);

    if (productId === "mug_15oz") {
      // Draw a mug body with image wrapped around it
      var bodyL = 30, bodyR = 120, bodyT = 35, bodyB = 130;
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
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, bodyL, bodyT, bodyR - bodyL, bodyB - bodyT);
      mctx.restore();
      // Handle
      mctx.strokeStyle = "#aaa";
      mctx.lineWidth = 4;
      mctx.beginPath();
      mctx.moveTo(bodyR, 50);
      mctx.quadraticCurveTo(bodyR + 28, 50, bodyR + 28, 80);
      mctx.quadraticCurveTo(bodyR + 28, 115, bodyR, 115);
      mctx.stroke();
      // Rim highlight
      mctx.strokeStyle = "rgba(255,255,255,0.3)";
      mctx.lineWidth = 2;
      mctx.beginPath();
      mctx.moveTo(bodyL + 2, bodyT);
      mctx.lineTo(bodyR - 2, bodyT);
      mctx.stroke();
    } else if (productId === "tshirt_unisex") {
      // T-shirt silhouette with image on chest
      mctx.fillStyle = "#e8e8e8";
      mctx.beginPath();
      // Neckline + shoulders
      mctx.moveTo(60, 18);
      mctx.quadraticCurveTo(80, 28, 100, 18);
      mctx.lineTo(130, 30);
      mctx.lineTo(155, 55); // right sleeve
      mctx.lineTo(130, 60);
      mctx.lineTo(128, 145);
      mctx.lineTo(32, 145);
      mctx.lineTo(30, 60);
      mctx.lineTo(5, 55); // left sleeve
      mctx.lineTo(30, 30);
      mctx.closePath();
      mctx.fill();
      // Solar image on chest area
      mctx.save();
      mctx.beginPath();
      mctx.rect(45, 42, 70, 70);
      mctx.clip();
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, 45, 42, 70, 70);
      mctx.restore();
    } else if (productId === "poster_matte" || productId === "framed_poster") {
      // Poster with shadow and border
      var pL = 25, pT = 10, pW = 110, pH = 140;
      mctx.fillStyle = "rgba(0,0,0,0.4)";
      mctx.fillRect(pL + 4, pT + 4, pW, pH);
      mctx.fillStyle = "#fff";
      mctx.fillRect(pL, pT, pW, pH);
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, pL + 5, pT + 5, pW - 10, pH - 10);
      if (productId === "framed_poster") {
        mctx.strokeStyle = "#333";
        mctx.lineWidth = 4;
        mctx.strokeRect(pL, pT, pW, pH);
      }
    } else if (productId === "canvas_stretched" || productId === "metal_sign" || productId === "acrylic_print") {
      // Wall art — image with subtle shadow
      var wL = 15, wT = 15, wW = 130, wH = 130;
      mctx.fillStyle = "rgba(0,0,0,0.35)";
      mctx.fillRect(wL + 5, wT + 5, wW, wH);
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, wL, wT, wW, wH);
      if (productId === "canvas_stretched") {
        mctx.strokeStyle = "#444";
        mctx.lineWidth = 3;
        mctx.strokeRect(wL, wT, wW, wH);
      } else if (productId === "acrylic_print") {
        // Glossy highlight
        var grad = mctx.createLinearGradient(wL, wT, wL + wW, wT + wH);
        grad.addColorStop(0, "rgba(255,255,255,0.18)");
        grad.addColorStop(0.5, "rgba(255,255,255,0)");
        grad.addColorStop(1, "rgba(255,255,255,0.08)");
        mctx.fillStyle = grad;
        mctx.fillRect(wL, wT, wW, wH);
      }
    } else if (productId === "wall_clock") {
      // Round clock face with solar image
      var cx = 80, cy = 80, r = 65;
      mctx.save();
      mctx.beginPath();
      mctx.arc(cx, cy, r, 0, Math.PI * 2);
      mctx.clip();
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, cx - r, cy - r, r * 2, r * 2);
      mctx.restore();
      mctx.strokeStyle = "#666";
      mctx.lineWidth = 3;
      mctx.beginPath();
      mctx.arc(cx, cy, r, 0, Math.PI * 2);
      mctx.stroke();
      // Clock hands
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
    } else if (productId === "throw_pillow") {
      // Square pillow with image
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
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, pilL, pilT, pilW, pilH);
      mctx.restore();
    } else if (productId === "puzzle_1000") {
      // Puzzle grid overlay on image
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, 10, 10, 140, 140);
      mctx.strokeStyle = "rgba(255,255,255,0.25)";
      mctx.lineWidth = 1;
      for (var px = 10; px <= 150; px += 28) {
        mctx.beginPath(); mctx.moveTo(px, 10); mctx.lineTo(px, 150); mctx.stroke();
      }
      for (var py = 10; py <= 150; py += 28) {
        mctx.beginPath(); mctx.moveTo(10, py); mctx.lineTo(150, py); mctx.stroke();
      }
    } else if (productId === "phone_case") {
      // Phone case shape with image
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
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, phL, phT, phW, phH);
      mctx.restore();
      // Phone bezel outline
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
      // Camera hole
      mctx.fillStyle = "#222";
      mctx.beginPath();
      mctx.arc(phL + phW - 16, phT + 18, 6, 0, Math.PI * 2);
      mctx.fill();
    } else {
      // Generic: just draw the image
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, 10, 10, 140, 140);
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

      // Determine if this product can be purchased (needs blueprint + provider + HQ image)
      var canBuy = state.hqReady && p.blueprintId && p.printProviderId;
      var buyLabel = !state.hqReady
        ? '<i class="fas fa-lock"></i> Generate HQ first'
        : (!p.blueprintId ? '<i class="fas fa-spinner fa-spin"></i> Resolving…' : '<i class="fas fa-shopping-cart"></i> Buy · ' + p.price);

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

  function autoGenerateMockups() {
    // Only run if we have an image and resolved product IDs
    var ready = PRODUCTS.filter(function(p) { return p.blueprintId && p.printProviderId && p.variantId; });
    if (ready.length === 0 || !state.originalImage) return;

    // Skip products already mocked
    var needsMockup = ready.filter(function(p) { return !state.mockups[p.id]; });
    if (needsMockup.length === 0) return;

    // Step 1: Upload preview image (or reuse existing upload)
    if (state.uploadedPrintifyId) {
      mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Generating ' + needsMockup.length + ' mockup(s)…';
      runMockupQueue(needsMockup);
      return;
    }

    var fname = "solar_" + (dateInput.value || "image") + "_" + state.wavelength + "_preview.png";
    var base64Data = getCanvasBase64();
    mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Uploading for mockups (' + Math.round(base64Data.length / 1024) + ' KB)…';

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
      state.uploadedPrintifyId = data.id;
      var unmocked = PRODUCTS.filter(function(p) {
        return p.blueprintId && p.printProviderId && p.variantId && !state.mockups[p.id];
      });
      runMockupQueue(unmocked);
    })
    .catch(function(err) {
      mockupStatus.innerHTML = '<span style="color:var(--accent-sun);font-size:12px;"><i class="fas fa-exclamation-triangle"></i> Mockups unavailable: ' + err.message + '</span>';
    });
  }

  function runMockupQueue(queue) {
    var total = queue.length;
    var done = 0;

    function createNext() {
      if (queue.length === 0) {
        mockupStatus.innerHTML = '<span style="color:#3ddc84;font-size:12px;"><i class="fas fa-check-circle"></i> All ' + total + ' mockup(s) ready</span>';
        return;
      }
      var product = queue.shift();
      done++;
      mockupStatus.innerHTML = '<div class="spinner" style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:6px;border-width:2px;"></div> Mockup ' + done + '/' + total + ': ' + product.name + '…';

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
            images: [{ id: state.uploadedPrintifyId, x: 0.5, y: 0.5, scale: 1, angle: 0 }]
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
      sendHint.textContent = "HQ image ready — click Buy on any product to purchase.";
      sendHint.style.color = "var(--accent-cool)";
    } else {
      sendHint.textContent = "Generate the HQ print-ready image first (Step 2), then Buy buttons will activate.";
      sendHint.style.color = "var(--text-dim)";
    }
  }

  function startCheckout(product) {
    if (!state.hqReady) {
      showInfo("HQ Image Required", "Please generate the HQ print-ready image first using the button in Step 2, then come back here to buy.");
      return;
    }
    if (!product.blueprintId || !product.printProviderId) {
      showInfo("Product Not Ready", "This product's print details are still being resolved. Please wait a moment and try again.");
      return;
    }

    showModal(
      "Buy " + product.name,
      "This will create your custom <strong>" + product.name + "</strong> with your solar image and list it on Shopify with <strong>all available sizes and colors</strong>.<br><br>" +
        "You'll pick your exact size, color, and options on Shopify's secure checkout.<br><br>" +
        "Make sure you're happy with your image edits before proceeding!",
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

    // Build the solar image title
    var dateStr = dateInput.value || "custom";
    var wlStr = state.wavelength + "Å";
    var title = "Solar " + wlStr + " — " + dateStr + " · " + product.name;
    var fname = "solar_" + dateStr + "_" + state.wavelength + "_hq.png";
    var base64Data = getCanvasBase64();

    // Update step 1 to show upload size
    var sizeKB = Math.round(base64Data.length / 1024);
    var step1 = document.getElementById("ckStep1");
    if (step1) step1.querySelector("span").textContent = "Uploading solar image (" + sizeKB + " KB)…";

    fetchWithTimeout(API_BASE + "/api/printify/checkout", {
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

      // Mark steps 1-3 as done
      var vcMsg = data.variant_count ? " (" + data.variant_count + " variants)" : "";
      markCheckoutStep("ckStep1", "done", "Image uploaded");
      markCheckoutStep("ckStep2", "done", "Product created" + vcMsg);
      markCheckoutStep("ckStep3", "done", "Published to Shopify");
      markCheckoutStep("ckStep4", "active", "Waiting for Shopify product link…");

      // Now poll for the Shopify URL
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

      // Auto-open Shopify in a new tab after a short delay
      setTimeout(function() { window.open(shopifyUrl, "_blank"); }, 1500);
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
        if (prod && state.hqReady && prod.blueprintId && prod.printProviderId) {
          btn.disabled = false;
        }
      });
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
