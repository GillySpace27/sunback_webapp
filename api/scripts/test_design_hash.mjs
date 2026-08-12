// Self-check for the design-identity hash used to dedupe catalog products.
// Mirrors _stableStringify / _cyrb53 / _designHash in api/solar-archive.js
// (that copy lives in a browser IIFE and can't be imported). If you change
// the hash there, change it here. The point of this test is the CONTRACT:
// the free-text overlay (PII) must NOT affect identity, while image-affecting
// inputs (wavelength, crop) MUST. Run: node api/scripts/test_design_hash.mjs
import assert from "node:assert";

function _stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(_stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map(function (k) {
    return JSON.stringify(k) + ":" + _stableStringify(v[k]);
  }).join(",") + "}";
}
function _cyrb53(str) {
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
const _designHash = (o) => _cyrb53(_stableStringify(o));

// A representative design identity, as doCheckout builds it (PII already
// stripped: params.textOverlay is null).
function design(over) {
  return Object.assign({
    wavelength: 171, date: "2020-03-15", filter: "hq", vibe: null,
    blueprint_id: 1234, print_provider_id: 5, variant_ids: [88, 42],
    position: "front",
    params: { cropZoom: 100, panX: 10, panY: 20, rotation: 0, textOverlay: null },
  }, over || {});
}

// 1. Personalization (PII) does not change identity.
const base = design();
const withName = design({ params: Object.assign({}, base.params, { textOverlay: null }) });
assert.strictEqual(_designHash(base), _designHash(withName), "textOverlay must not affect identity");

// 2. Wavelength changes identity.
assert.notStrictEqual(_designHash(base), _designHash(design({ wavelength: 193 })), "wavelength must change identity");

// 3. Crop changes identity.
const cropped = design({ params: Object.assign({}, base.params, { cropZoom: 140 }) });
assert.notStrictEqual(_designHash(base), _designHash(cropped), "cropZoom must change identity");

// 4. Key order / variant order independence (stable stringify + sorted ids).
const reordered = { position: "front", date: "2020-03-15", wavelength: 171, filter: "hq",
  vibe: null, blueprint_id: 1234, print_provider_id: 5, variant_ids: [42, 88],
  params: { textOverlay: null, panY: 20, panX: 10, rotation: 0, cropZoom: 100 } };
// variant_ids are sorted by the caller before hashing; mirror that here.
reordered.variant_ids = reordered.variant_ids.slice().sort();
base.variant_ids = base.variant_ids.slice().sort();
assert.strictEqual(_designHash(base), _designHash(reordered), "key/variant order must not affect identity");

console.log("design-hash self-check passed");
