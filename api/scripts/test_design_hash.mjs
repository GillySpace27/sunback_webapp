// Self-check for the design-identity hash (api/identity.js).
// The store does not currently send design_hash at checkout (git grep for
// _cyrb53 under api/ finds it only in this test; printify_routes.py defaults
// design_hash to ""), so product reuse by tag:design-<hash> is dormant. This
// test pins the CONTRACT for when it returns: the free-text overlay (PII) must
// NOT affect identity, while image-affecting inputs (wavelength, crop) MUST.
// Run: node api/scripts/test_design_hash.mjs
import assert from "node:assert";
import { copyFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// api/ has no package.json, so Node reads a bare .js as CommonJS. Import a
// temporary .mjs copy instead; that works on every Node version.
// IDENTITY_JS points the test at another copy (used to prove the test fails).
const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = process.env.IDENTITY_JS || path.join(here, "..", "identity.js");
const tmpPath = path.join(mkdtempSync(path.join(os.tmpdir(), "identity-")), "identity.mjs");
copyFileSync(srcPath, tmpPath);
const { stableStringify, cyrb53, designHash, designIdentity } = await import(pathToFileURL(tmpPath).href);
const _designHash = designHash;

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

// 5. The PII strip lives in designIdentity (MH-9). Negative control first: the
// raw hash DOES react to overlay text, so the equality below proves the strip.
// Built from `base` (whose variant_ids were sorted in place above), so only the overlay differs.
const personal = Object.assign({}, base, { params: Object.assign({}, base.params, { textOverlay: "Jane Example" }) });
assert.notStrictEqual(designHash(personal), designHash(base), "control: the raw hash must react to overlay text");
assert.strictEqual(designHash(designIdentity(personal)), designHash(designIdentity(base)),
  "overlay text leaked into the identity: designIdentity must force params.textOverlay to null");
assert.strictEqual(designIdentity(personal).params.textOverlay, null, "designIdentity must null params.textOverlay");
assert.strictEqual(personal.params.textOverlay, "Jane Example", "designIdentity must not mutate its input");

// 6. Known answers pin the hash function itself, so a refactor cannot change
// the identity of every design silently.
assert.strictEqual(stableStringify({ b: 1, a: [2, { d: 1, c: null }] }), '{"a":[2,{"c":null,"d":1}],"b":1}');
assert.strictEqual(cyrb53(""), "bdcb81aee8d83");
assert.strictEqual(designHash({
  wavelength: 171, date: "2020-03-15", filter: "hq", vibe: null,
  blueprint_id: 1234, print_provider_id: 5, variant_ids: [42, 88], position: "front",
  params: { cropZoom: 100, panX: 10, panY: 20, rotation: 0, textOverlay: null },
}), "b3470a0eaa0a0");

console.log("design-hash self-check passed");
