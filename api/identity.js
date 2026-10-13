/* ===============================================================
   Solar Archive: design identity helpers (MH-9)

   The PII-free fingerprint of a design, used to dedupe catalog products
   (printify_routes.py reuses a product carrying the tag design-<hash>).
   The store does NOT send design_hash at checkout today; whether it should
   again is a money-path decision for Gilly (SA-23). These helpers exist as an
   importable module so the contract test (api/scripts/test_design_hash.mjs)
   checks the real code instead of a hand copy. solar-archive.js does not
   import this file.

   Contract: free text typed by the buyer (params.textOverlay) is personal data
   and must never enter the identity; wavelength, date, crop and the product
   choice must. designIdentity() is the single place that strips the text.
   =============================================================== */

export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map(function (k) {
    return JSON.stringify(k) + ":" + stableStringify(v[k]);
  }).join(",") + "}";
}

export function cyrb53(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16);
}

export function designHash(o) {
  return cyrb53(stableStringify(o));
}

// A shallow copy of a design with the buyer's free text removed. Hash the
// result, never the raw design.
export function designIdentity(raw) {
  const out = Object.assign({}, raw);
  out.params = Object.assign({}, raw && raw.params, { textOverlay: null });
  return out;
}
