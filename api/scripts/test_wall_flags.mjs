// Self-check for the film's p= and space= flags (MH-18): which values the film
// accepts, and where space= lands. Imports the TypeScript sources directly
// (Node strips the types); productId.ts and the store's SPACES table are
// read as text so the test needs no bundler.
// Run: node api/scripts/test_wall_flags.mjs
// PRODUCT_ID_TS overrides the path (used to prove the test fails).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web3d", "src");
const { validProductId } = await import(
  pathToFileURL(process.env.PRODUCT_ID_TS || path.join(root, "lib", "productId.ts")).href);

assert.strictEqual(validProductId("poster_18x24"), "poster_18x24");
assert.strictEqual(validProductId(null), null);
assert.strictEqual(validProductId(""), null);
assert.strictEqual(validProductId("a b"), null);
assert.strictEqual(validProductId("x\"><script>"), null, "no markup");
assert.strictEqual(validProductId("A".repeat(10)), null, "lowercase ids only");
assert.strictEqual(validProductId("a".repeat(65)), null, "length capped");

// space=room must name a real space; the table is the source of truth.
const store = readFileSync(path.join(root, "store.ts"), "utf8");
const keys = [...store.matchAll(/\{ key: "(\w+)", start: ([\d.]+) \}/g)].map((m) => m[1]);
assert.ok(keys.includes("room") && keys.includes("gallery"), "room is a space: " + keys);
const handoff = readFileSync(path.join(root, "lib", "handoff.ts"), "utf8");
assert.ok(/else if \(validProductId\(opts\?\.p\)\) q\.set\("p"/.test(handoff), "p is sent only without cat and only if valid");
console.log("test_wall_flags: ok");
