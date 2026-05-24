/* ===============================================================
   Solar Archive — feedback widget

   Step 5/N of the IIFE → ES-modules refactor. The feedback FABs
   (Request / Comment) + their modal lived as a closing IIFE at
   the bottom of solar-archive.js. The widget is genuinely self-
   contained — zero `state.X` reads, no module-level vars borrowed
   from the editor — so the extraction is straightforward: wrap
   the body in an exported setupFeedback(deps) and call it once
   from solar-archive.js after the deps it needs are defined.

   Deps injected (helpers that still live in solar-archive.js):
   - installModalFocusTrap: focus-trap install/release for a11y
   - addToSessionCatalog: persist user-requested products to
     localStorage and rebroadcast the catalog
   - makeProductFromRequest: shape a feedback request into a
     PRODUCTS-array entry
   - renderProducts: rebuild the grid after a request lands
   - showToast: global toast banner

   When any of those graduate to their own modules, the import
   path changes here but the deps contract stays the same.
   =============================================================== */

// Feedback widget — floating button + modal with two tabs:
//   1. Free-text comment  → POST /api/feedback
//   2. Product request    → search /api/printify/blueprints, pick
//      a blueprint + provider + variant, attach a note, submit.
//
// Auto-captures the page context (date, wavelength, filter, selected
// product, URL, user agent) so the operator can reproduce what the
// user was looking at when they submitted.
export function setupFeedback(deps) {
  var installModalFocusTrap = deps.installModalFocusTrap;
  var addToSessionCatalog   = deps.addToSessionCatalog;
  var makeProductFromRequest = deps.makeProductFromRequest;
  var renderProducts        = deps.renderProducts;
  var showToast             = deps.showToast;

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
}
