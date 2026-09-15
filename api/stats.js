/* ===============================================================
   Solar Archive — product popularity stats (durable, server-side)

   Step 6/N of the IIFE → ES-modules refactor. Two counters per
   product land from /api/stats: buys (finalized via checkout /
   download) and clicks (committed into the editor). The grid sorts
   by buys, then by non-converting clicks; each card shows a faint
   "buys | (clicks − buys)" badge — operator-only — so the second
   number reads as "engaged but didn\'t buy". Stored on the
   persistent disk so it survives deploys.

   The viewer-side machinery lives here:
   - recordStatEvent(productId, kind)   — fire-and-forget POST
   - addStatsBadge(parentEl, prod)      — paint the operator-only badge
   - productsByPopularity()             — buys-then-clicks sort
   - loadProductStats()                 — bootstrap fetch (called once via initStats)
   - initStats(deps)                    — wire up runtime deps + bootstrap

   Deps injected:
   - API_BASE        — solar-archive.js's API_BASE constant
   - BETA_MODE       — beta-build flag (badge visible in beta)
   - showToast       — global toast banner (operator-mode notice)
   - renderProducts  — re-paints the gallery after stats land
   =============================================================== */

import { PRODUCTS } from "./products.js";

const _deps = {
  API_BASE: "",
  BETA_MODE: false,
  showToast: () => {},
  renderProducts: () => {},
};

    // ── Product popularity stats (durable, server-side) ─────────────
    // Two counters per product from /api/stats: buys (finalized via
    // checkout / download) and clicks (committed into the editor). The
    // grid sorts by buys, then by non-converting clicks; each card shows
    // a faint "buys | (clicks − buys)" badge so the second number reads
    // as "engaged but didn't buy". Stored on the persistent disk so it
    // survives deploys.
    // NOTE: _deps.renderProducts() is invoked early (during init, before this
    // assignment line runs), so every reader below must tolerate
    // productStats being undefined — otherwise the first render throws a
    // TypeError and aborts the whole script.
    var productStats = {};
    // True only once the server has actually sent real per-product counts
    // (operator IP or admin key — see api/stats_routes.py). A normal
    // visitor never gets those, only the rank order below, so the sort
    // falls back to it and the badge just doesn't render rather than
    // showing a fabricated number (QA sweep, 2026-09-14: raw counts were
    // visible to any visitor's network tab).
    var _haveFullStats = false;
    // Popularity RANK only (buys desc, then non-converting clicks desc),
    // sent to every visitor so the grid can still sort itself.
    var productOrder = null;
    // Merged-product stat canonicalization: a colour-sibling child id
    // (e.g. the black mug) maps onto the visible card's id (the white
    // mug) so both colours' clicks/buys aggregate under one honest
    // badge. Built from PRODUCTS colorOptions.
    var _statIdMap = (function() {
      var m = {};
      PRODUCTS.forEach(function(p) {
        if (p.colorOptions) {
          p.colorOptions.forEach(function(c) {
            if (c.productId && c.productId !== p.id) m[c.productId] = p.id;
          });
        }
      });
      return m;
    })();
    function _canonicalStatId(pid) { return _statIdMap[pid] || pid; }
    // Whether THIS viewer's IP is on the server exclusion list (from
    // /api/stats). Set async; defaults false.
    var _viewerIpExcluded = false;
    // The popularity badge is an internal/operator tool, not customer-
    // facing social proof (early zero/low counts read as "unpopular",
    // and exposing non-converting clicks hurts conversion). Show it only
    // to the operator (opt-out flag OR excluded IP) or while BETA_MODE is
    // on. The popularity SORT stays on for everyone — it surfaces popular
    // items without exposing numbers.
    function _canSeeStatsBadge() {
      return (_deps.BETA_MODE) ||
             _statsOptedOut() || _viewerIpExcluded;
    }
    function _statShown(pid) {
      var s = (productStats && productStats[pid]) || {};
      var buys = s.buys || 0, clicks = s.clicks || 0;
      return { buys: buys, other: Math.max(0, clicks - buys) };
    }
    function _productsByPopularity() {
      if (_haveFullStats) {
        return PRODUCTS.slice().sort(function(a, b) {
          var sa = _statShown(a.id), sb = _statShown(b.id);
          if (sb.buys !== sa.buys) return sb.buys - sa.buys;     // buys desc
          if (sb.other !== sa.other) return sb.other - sa.other; // then clicks desc
          return PRODUCTS.indexOf(a) - PRODUCTS.indexOf(b);      // stable original order
        });
      }
      // No real counts (normal visitor) — sort by the server-sent rank
      // order instead; unranked ids (nothing recorded yet) fall to the end.
      if (productOrder && productOrder.length) {
        var rank = {};
        productOrder.forEach(function(pid, i) {
          var cid = _canonicalStatId(pid);
          if (!(cid in rank)) rank[cid] = i;
        });
        return PRODUCTS.slice().sort(function(a, b) {
          var ra = rank.hasOwnProperty(a.id) ? rank[a.id] : productOrder.length;
          var rb = rank.hasOwnProperty(b.id) ? rank[b.id] : productOrder.length;
          if (ra !== rb) return ra - rb;
          return PRODUCTS.indexOf(a) - PRODUCTS.indexOf(b);
        });
      }
      return PRODUCTS.slice();
    }
    function _addStatsBadge(parentEl, prod) {
      if (!_canSeeStatsBadge() || !_haveFullStats) return;  // operator/beta only, real counts only
      if (!parentEl || parentEl.querySelector(".product-stats-badge")) return;
      var s = _statShown(prod.id);
      var badge = document.createElement("span");
      badge.className = "product-stats-badge";
      badge.textContent = s.buys + " | " + s.other;
      badge.title = "buys | clicks";
      // a11y / mobile (no hover for `title`): expose the same info via
      // aria-label so VoiceOver reads "3 buys, 12 clicks" instead of
      // "3 vertical bar 12".
      badge.setAttribute("aria-label", s.buys + " buys, " + s.other + " clicks");
      parentEl.appendChild(badge);
    }
    // Operator opt-out: a browser/device flagged via ?operator=1 never
    // fires stat events, so the operator's own clicks don't skew the
    // counts. localStorage is keyed by origin, so setting it on the
    // standalone site also applies inside the same-origin Shopify
    // iframe. ?operator=0 turns counting back on.
    function _statsOptedOut() {
      try { return localStorage.getItem("sa_stats_optout") === "1"; }
      catch (_e) { return false; }
    }
    (function _applyOperatorFlag() {
      try {
        var m = /[?&]operator=([01])/.exec(window.location.search);
        if (!m) return;
        if (m[1] === "1") {
          localStorage.setItem("sa_stats_optout", "1");
          if (_deps.showToast) _deps.showToast("Operator mode: your activity won't count toward product stats.", "success");
        } else {
          localStorage.removeItem("sa_stats_optout");
          if (_deps.showToast) _deps.showToast("Operator mode off: your activity counts again.");
        }
      } catch (_e) {}
    })();
    function recordStatEvent(productId, kind) {
      if (!productId) return;
      if (_statsOptedOut()) return;  // operator device — don't count
      if (!productStats) productStats = {};
      // Canonicalize merged-product children (e.g. black mug → white-mug
      // card id) so both colours aggregate under one badge.
      var canonId = _canonicalStatId(productId);
      // Optimistic local bump so the next grid render reflects it even
      // before the server round-trips.
      var s = productStats[canonId] || { buys: 0, clicks: 0 };
      if (kind === "buy") s.buys = (s.buys || 0) + 1;
      else s.clicks = (s.clicks || 0) + 1;
      productStats[canonId] = s;
      try {
        fetch(_deps.API_BASE + "/api/stats/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product_id: canonId, kind: kind }),
          keepalive: true  // a "buy" fires right before navigation — keepalive still sends it
        }).catch(function() {});
      } catch (_e) {}
    }
    function loadProductStats() {
      fetch(_deps.API_BASE + "/api/stats")
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d && d.stats) { productStats = d.stats; _haveFullStats = true; }
          if (d && Array.isArray(d.order)) productOrder = d.order;
          if (d && typeof d.viewer_excluded !== "undefined") _viewerIpExcluded = !!d.viewer_excluded;
          if (_deps.renderProducts) _deps.renderProducts();
        })
        .catch(function() {});
    }

export function initStats(deps) {
  Object.assign(_deps, deps);
  // Bootstrap: fetch the stats once on init. The fetch handler also
  // re-renders products if the dep is wired, so any badge / popularity
  // sort lands without a separate re-render call from solar-archive.js.
  loadProductStats();
}

export {
  recordStatEvent,
  _addStatsBadge as addStatsBadge,
  _productsByPopularity as productsByPopularity,
  loadProductStats,
};
