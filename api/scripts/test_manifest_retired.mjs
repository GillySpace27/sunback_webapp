// Self-check: the store drops retired keys from the default mockup manifest
// before handing it to the grid (MH-9). Run: node api/scripts/test_manifest_retired.mjs
//
// The volume file default_mockups.json is never rewritten; only the parsed copy
// the store keeps in memory loses the key. The fetch IIFE is cut out of
// api/solar-archive.js and run against stubs, so no browser or network is used.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(process.env.STORE_JS || path.join(here, "..", "solar-archive.js"), "utf8");

const m = src.match(/var _RETIRED_MANIFEST_KEYS = (\[[^\]]*\]);/);
assert.ok(m, "var _RETIRED_MANIFEST_KEYS not found in api/solar-archive.js");
const retired = JSON.parse(m[1]);
assert.ok(retired.includes("phone_case"), "phone_case must be a retired key");

const start = src.indexOf("(function _fetchDefaultMockupManifest() {");
assert.ok(start >= 0, "_fetchDefaultMockupManifest not found");
const end = src.indexOf("})();", start) + "})();".length;
const iife = src.slice(start, end);

let received = null;
const fetchStub = () => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({
    phone_case: { url: "/asset/default/mockups/phone_case.png" },
    canvas_stretched: { url: "/asset/default/mockups/canvas_stretched.png" },
    "171": { raw: { poster_matte: { thumb_url: "/asset/default/mockups/171/raw/poster_matte.thumb.webp" } } },
  }),
});
const run = new Function("fetch", "setDefaultMockupManifest", "renderProducts", "state",
  "updateBuyButtonState", "_applyBetaModeUI", "_RETIRED_MANIFEST_KEYS", iife);
run(fetchStub, (j) => { received = j; }, () => {}, { selectedProduct: null }, () => {}, () => {}, retired);
await new Promise((r) => setTimeout(r, 0));

assert.ok(received, "setDefaultMockupManifest was never called");
assert.ok(!("phone_case" in received), "a retired key reached setDefaultMockupManifest");
assert.ok("canvas_stretched" in received && "171" in received, "live keys must pass through untouched");
console.log("manifest retired-keys self-check passed");
