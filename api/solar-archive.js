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
  // blueprint_id = product type, print_provider_id = fulfiller,
  // variantId = specific size/color combo, position = print area placement
  // Product templates — blueprintId/printProviderId/variantId will be auto-resolved
  // from the live Printify catalog. The "search" field helps match blueprints by name.
  var PRODUCTS = [
    {
      id: "tote_bag",
      name: "Tote Bag",
      desc: "Sturdy cotton canvas tote, all-over print",
      icon: "fa-shopping-bag",
      price: "From $16.99",
      checkoutPrice: 1699,
      search: ["tote", "bag"],
      blueprintId: null,
      printProviderId: null,
      variantId: null,
      position: "front"
    },
    {
      id: "mug_15oz",
      name: "Coffee Mug — 15oz",
      desc: "Large white ceramic mug, full-wrap print",
      icon: "fa-mug-hot",
      price: "From $14.99",
      checkoutPrice: 1499,
      search: ["mug", "15oz"],
      blueprintId: null,
      printProviderId: null,
      variantId: null,
      position: "front"
    },
    {
      id: "tshirt_unisex",
      name: "Unisex T-Shirt",
      desc: "Bella+Canvas 3001 jersey tee, DTG print",
      icon: "fa-tshirt",
      price: "From $24.99",
      checkoutPrice: 2499,
      search: ["unisex", "jersey", "tee", "3001"],
      blueprintId: null,
      printProviderId: null,
      variantId: null,
      position: "front"
    },
    {
      id: "poster_12x18",
      name: 'Poster — 12×18"',
      desc: "Premium matte, museum-quality print",
      icon: "fa-image",
      price: "From $9.99",
      checkoutPrice: 999,
      search: ["poster", "enhanced matte"],
      blueprintId: null,
      printProviderId: null,
      variantId: null,
      position: "front"
    },
    {
      id: "candle",
      name: "Scented Candle",
      desc: "Soy wax candle with custom label",
      icon: "fa-fire",
      price: "From $18.99",
      checkoutPrice: 1899,
      search: ["candle", "soy"],
      blueprintId: null,
      printProviderId: null,
      variantId: null,
      position: "front"
    },
    {
      id: "phone_case",
      name: "Phone Case",
      desc: "Tough snap case, glossy finish",
      icon: "fa-mobile-alt",
      price: "From $19.99",
      checkoutPrice: 1999,
      search: ["phone case", "tough", "snap"],
      blueprintId: null,
      printProviderId: null,
      variantId: null,
      position: "front"
    }
  ];

  // ── Auto-resolve Printify IDs from live catalog ────────────
  var catalogResolved = false;
  function resolveCatalogIds() {
    fetchWithTimeout(API_BASE + "/api/printify/blueprints", { method: "GET" }, 45000)
    .then(function(r) { return r.ok ? r.json() : Promise.reject("Catalog fetch failed"); })
    .then(function(blueprints) {
      // For each product, find a matching blueprint by searching title
      PRODUCTS.forEach(function(prod) {
        if (prod.blueprintId) return; // already resolved
        var terms = prod.search || [];
        var match = null;
        var bestScore = 0;
        blueprints.forEach(function(bp) {
          var title = (bp.title || "").toLowerCase();
          var score = 0;
          terms.forEach(function(term) {
            if (title.indexOf(term.toLowerCase()) !== -1) score++;
          });
          if (score > bestScore) { bestScore = score; match = bp; }
        });
        if (match && bestScore > 0) {
          prod.blueprintId = match.id;
          prod._blueprintTitle = match.title;
        }
      });

      // Now resolve providers and variants for matched blueprints
      var resolveQueue = PRODUCTS.filter(function(p) { return p.blueprintId && !p.variantId; });
      var COMMON_PROVIDERS = [16, 29, 99, 1, 6, 28, 27, 55, 58, 44, 3];

      function resolveNext() {
        if (resolveQueue.length === 0) {
          catalogResolved = true;
          renderProducts();
          console.log("[catalog] Auto-resolved product IDs: " +
            JSON.stringify(PRODUCTS.map(function(p) {
              return { id: p.id, bp: p.blueprintId, prov: p.printProviderId, var: p.variantId };
            })));
          return;
        }
        var prod = resolveQueue.shift();

        // Try fetching providers for this blueprint
        fetchWithTimeout(
          API_BASE + "/api/printify/blueprints/" + prod.blueprintId + "/providers/" + COMMON_PROVIDERS[0] + "/variants",
          { method: "GET" }, 30000
        )
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (data && data.variants && data.variants.length > 0) {
            prod.printProviderId = COMMON_PROVIDERS[0];
            prod.variantId = data.variants[0].id;
            resolveNext();
            return;
          }
          // Try other providers sequentially
          return tryProviders(prod, COMMON_PROVIDERS.slice(1));
        })
        .then(function() { resolveNext(); })
        .catch(function() { resolveNext(); });
      }

      function tryProviders(prod, providers) {
        if (providers.length === 0 || prod.variantId) return Promise.resolve();
        var pid = providers[0];
        return fetchWithTimeout(
          API_BASE + "/api/printify/blueprints/" + prod.blueprintId + "/providers/" + pid + "/variants",
          { method: "GET" }, 15000
        )
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (data && data.variants && data.variants.length > 0) {
            prod.printProviderId = pid;
            prod.variantId = data.variants[0].id;
            return;
          }
          return tryProviders(prod, providers.slice(1));
        })
        .catch(function() {
          return tryProviders(prod, providers.slice(1));
        });
      }

      resolveNext();
    })
    .catch(function(err) {
      console.log("[catalog] Could not auto-resolve IDs: " + err);
    });
  }

  // Kick off catalog resolution when page loads (non-blocking)
  setTimeout(resolveCatalogIds, 2000);

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

        // Vignette — fade to black outside radius
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
            r *= (1 - t);
            g *= (1 - t);
            b *= (1 - t);
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
      ctx.font = "bold " + tov.size + "px " + tov.font;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (tov.strokeWidth > 0) {
        ctx.strokeStyle = tov.strokeColor;
        ctx.lineWidth = tov.strokeWidth * 2;
        ctx.lineJoin = "round";
        ctx.strokeText(tov.text, tov.x, tov.y);
      }
      ctx.fillStyle = tov.color;
      ctx.fillText(tov.text, tov.x, tov.y);
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
        strokeWidth: parseInt(textStrokeWidthSlider.value, 10)
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
  textFontSelect.addEventListener("change", syncTextOverlay);
  textColorPicker.addEventListener("input", syncTextOverlay);
  textStrokePicker.addEventListener("input", syncTextOverlay);
  textStrokeWidthSlider.addEventListener("input", function() {
    textStrokeVal.textContent = textStrokeWidthSlider.value;
    syncTextOverlay();
  });

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
    var ctx = solarCanvas.getContext("2d");
    ctx.save();
    ctx.font = "bold " + tov.size + "px " + tov.font;
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

  function enterCropMode() {
    state.cropping = true;
    cropControls.classList.remove("hidden");
    solarCanvas.style.cursor = "crosshair";
    state.cropStart = null;
    state.cropEnd = null;
    cropOverlay.classList.add("hidden");
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
      state.cropRatio = ratioBtn.dataset.ratio;
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
    } else if (productId === "poster_12x18") {
      // Poster with shadow and border
      var pL = 25, pT = 10, pW = 110, pH = 140;
      mctx.fillStyle = "rgba(0,0,0,0.4)";
      mctx.fillRect(pL + 4, pT + 4, pW, pH);
      mctx.fillStyle = "#fff";
      mctx.fillRect(pL, pT, pW, pH);
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, pL + 5, pT + 5, pW - 10, pH - 10);
    } else if (productId === "tote_bag") {
      // Tote bag silhouette with image on front
      mctx.fillStyle = "#d4c9a8";
      mctx.beginPath();
      mctx.moveTo(30, 40);
      mctx.lineTo(25, 145);
      mctx.lineTo(135, 145);
      mctx.lineTo(130, 40);
      mctx.closePath();
      mctx.fill();
      // Handles
      mctx.strokeStyle = "#b0a080";
      mctx.lineWidth = 4;
      mctx.lineCap = "round";
      mctx.beginPath();
      mctx.moveTo(50, 40);
      mctx.quadraticCurveTo(50, 12, 65, 12);
      mctx.quadraticCurveTo(80, 12, 80, 40);
      mctx.stroke();
      mctx.beginPath();
      mctx.moveTo(80, 40);
      mctx.quadraticCurveTo(80, 12, 95, 12);
      mctx.quadraticCurveTo(110, 12, 110, 40);
      mctx.stroke();
      // Solar image on bag front
      mctx.save();
      mctx.beginPath();
      mctx.rect(40, 50, 80, 80);
      mctx.clip();
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, 40, 50, 80, 80);
      mctx.restore();
    } else if (productId === "candle") {
      // Candle jar with label
      var jL = 42, jT = 25, jW = 76, jH = 115, jr = 8;
      // Jar body
      mctx.fillStyle = "#f5f0e8";
      mctx.beginPath();
      mctx.moveTo(jL + jr, jT);
      mctx.lineTo(jL + jW - jr, jT);
      mctx.quadraticCurveTo(jL + jW, jT, jL + jW, jT + jr);
      mctx.lineTo(jL + jW, jT + jH - jr);
      mctx.quadraticCurveTo(jL + jW, jT + jH, jL + jW - jr, jT + jH);
      mctx.lineTo(jL + jr, jT + jH);
      mctx.quadraticCurveTo(jL, jT + jH, jL, jT + jH - jr);
      mctx.lineTo(jL, jT + jr);
      mctx.quadraticCurveTo(jL, jT, jL + jr, jT);
      mctx.closePath();
      mctx.fill();
      // Lid
      mctx.fillStyle = "#8b7355";
      mctx.fillRect(jL - 2, jT - 8, jW + 4, 12);
      // Flame
      mctx.fillStyle = "#f7a825";
      mctx.beginPath();
      mctx.moveTo(80, jT - 8);
      mctx.quadraticCurveTo(74, jT - 22, 80, jT - 28);
      mctx.quadraticCurveTo(86, jT - 22, 80, jT - 8);
      mctx.fill();
      mctx.fillStyle = "#ff5e3a";
      mctx.beginPath();
      mctx.moveTo(80, jT - 8);
      mctx.quadraticCurveTo(77, jT - 16, 80, jT - 20);
      mctx.quadraticCurveTo(83, jT - 16, 80, jT - 8);
      mctx.fill();
      // Solar image as label
      mctx.save();
      mctx.beginPath();
      mctx.rect(jL + 6, jT + 20, jW - 12, jH - 35);
      mctx.clip();
      mctx.drawImage(solarCanvas, 0, 0, sw, sh, jL + 6, jT + 20, jW - 12, jH - 35);
      mctx.restore();
      // Label border
      mctx.strokeStyle = "rgba(0,0,0,0.15)";
      mctx.lineWidth = 1;
      mctx.strokeRect(jL + 6, jT + 20, jW - 12, jH - 35);
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

  function renderProducts() {
    productGrid.innerHTML = "";
    PRODUCTS.forEach(function(p) {
      var card = document.createElement("div");
      var hasMockup = state.mockups[p.id] && state.mockups[p.id].images && state.mockups[p.id].images.length > 0;
      var statusDot = hasMockup
        ? '<span style="color:#3ddc84;font-size:10px;" title="Printify mockup ready">●</span> '
        : (state.originalImage ? '<span style="color:#ff9800;font-size:10px;" title="Generating…">◌</span> ' : '');

      // Determine if this product can be purchased (needs resolved IDs + HQ image)
      var canBuy = state.hqReady && p.blueprintId && p.printProviderId && p.variantId;
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
    var newId = "catalog_" + bpId + "_" + providerId + "_" + variantId;

    // Check if already in PRODUCTS
    var existing = PRODUCTS.find(function(p) { return p.id === newId; });
    if (!existing) {
      PRODUCTS.push({
        id: newId,
        name: bpName,
        desc: "Provider #" + providerId + " · Variant #" + variantId,
        icon: "fa-box",
        price: "Catalog",
        blueprintId: bpId,
        printProviderId: providerId,
        variantId: variantId,
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
    if (!product.blueprintId || !product.printProviderId || !product.variantId) {
      showInfo("Product Not Ready", "This product's print details are still being resolved. Please wait a moment and try again.");
      return;
    }

    var priceStr = "$" + (product.checkoutPrice / 100).toFixed(2);

    showModal(
      "Buy " + product.name,
      "This will create your custom <strong>" + product.name + "</strong> with your solar image and list it on our Shopify store at <strong>" + priceStr + "</strong>.<br><br>" +
        "You'll be redirected to Shopify to complete your purchase with secure checkout.<br><br>" +
        "Make sure you're happy with your image edits before proceeding!",
      function() { doCheckout(product); },
      "Create & Buy — " + priceStr
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
        '<i class="fas fa-circle" style="font-size:6px;"></i> <span>Creating product on Printify</span>' +
      '</div>' +
      '<div class="checkout-step" id="ckStep3">' +
        '<i class="fas fa-circle" style="font-size:6px;"></i> <span>Publishing to Shopify</span>' +
      '</div>' +
      '<div class="checkout-step" id="ckStep4">' +
        '<i class="fas fa-circle" style="font-size:6px;"></i> <span>Waiting for Shopify product link</span>' +
      '</div>';

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
        variant_id: product.variantId,
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
      markCheckoutStep("ckStep1", "done", "Image uploaded");
      markCheckoutStep("ckStep2", "done", "Product created on Printify");
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
            'Click below to complete your purchase with secure Shopify checkout.' +
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
        if (prod && state.hqReady && prod.blueprintId && prod.printProviderId && prod.variantId) {
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
