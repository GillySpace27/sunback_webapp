// Self-check for MH-13's product-first vibe cards: the wiring that draws each
// card's Sun on the chosen product. Source-text check (the drawing itself needs
// a browser, and is UNCHECKED here).
// Run: node api/scripts/test_vibe_product.mjs
// VIBE_JS and VIBE_CSS override the paths (used to prove the test fails).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const api = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const js = readFileSync(process.env.VIBE_JS || path.join(api, "solar-archive.js"), "utf8");
const css = readFileSync(process.env.VIBE_CSS || path.join(api, "solar-archive.css"), "utf8");

const fn = /function _vibeOnProduct\(card\) \{[\s\S]*?\n    \}\n/.exec(js);
assert.ok(fn, "_vibeOnProduct exists");
const body = fn[0];
assert.ok(/state\.selectedProduct/.test(body) && /state\.originalImage\) return/.test(body),
  "only with a product chosen and no Sun installed (fallbackSrc is read only then)");
assert.ok(/drawProductMockup\([\s\S]*fallbackSrc: img/.test(body), "the card's image goes in through fallbackSrc");
assert.ok(!/img\.parentNode\.removeChild|well\.innerHTML/.test(body), "the plain thumb is kept for the tier wipes");

const calls = js.match(/_vibeOnProduct\(card\);/g) || [];
assert.strictEqual(calls.length, 2, "both the cached and the loaded thumb paths call it");
assert.ok(/\.vibe-thumb\.on-product > img \{ display: none; \}/.test(css), "the plain thumb is only hidden, once painted");
console.log("test_vibe_product: ok");
