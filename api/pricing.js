/* ===============================================================
   Solar Archive: price ladder (MH-9)

   Proportional-markup ladder (2026-08-08 repricing). MUST stay in lockstep
   with _ladder_prices in api/printify_routes.py: the charged price is
   recomputed server-side with the same rule, and charged must equal
   displayed. Both sides are tested against the same vectors in
   api/scripts/fixtures/ladder_vectors.json (test_ladder.py, test_ladder.mjs).

     mult    = max(1, anchor / minCost)
     flat    = max(0, anchor - minCost)
     raw     = max(round(cost * mult), cost + flat)
     price   = raw rounded UP to the next .99
     ladder  = distinct cost tiers ascending, forced >= $1.00 apart

   Memoised per key + anchor for the page lifetime (the pricing cache itself
   only changes with a page-lifetime fetch). Imported by solar-archive.js as
   _ceil99 and _ladderFor so every call site keeps its name.
   =============================================================== */

var _ladderCache = {};

export function ceil99(cents) {
  var p = Math.floor(cents / 100) * 100 + 99;
  return p >= cents ? p : p + 100;
}

export function ladderFor(key, bucket, anchor) {
  var ck = key + "|" + anchor;
  if (_ladderCache[ck]) return _ladderCache[ck];
  var costs = [];
  for (var k in bucket) {
    if (bucket[k] && bucket[k].cost != null && costs.indexOf(bucket[k].cost) === -1) {
      costs.push(bucket[k].cost);
    }
  }
  costs.sort(function(a, b) { return a - b; });
  var out = {};
  if (!costs.length) { _ladderCache[ck] = out; return out; }
  var minCost = costs[0];
  var flat = Math.max(0, anchor - minCost);
  var mult = (anchor > 0 && minCost > 0) ? Math.max(1, anchor / minCost) : 1;
  var prev = null;
  for (var i = 0; i < costs.length; i++) {
    var c = costs[i];
    var raw = Math.max(Math.round(c * mult), c + flat);
    var p = ceil99(raw);
    if (prev !== null && i > 0 && p < prev + 100) p = prev + 100;
    out[c] = p;
    prev = p;
  }
  _ladderCache[ck] = out;
  return out;
}
