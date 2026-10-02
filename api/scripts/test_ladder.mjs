// Self-check for api/pricing.js against the shared vectors (MH-9).
// Run: node api/scripts/test_ladder.mjs
//
// api/scripts/test_ladder.py feeds the SAME vectors to _ladder_prices in
// api/printify_routes.py, so the Python rule and its JS twin cannot drift
// apart unnoticed (charged price must equal displayed price).
// PRICING_JS and LADDER_VECTORS override the paths (used to prove the test fails).
import assert from "node:assert";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// api/ has no package.json: import a temporary .mjs copy, which works on every Node.
async function loadEsm(file) {
  const dst = path.join(mkdtempSync(path.join(os.tmpdir(), "esm-")), path.basename(file, ".js") + ".mjs");
  copyFileSync(file, dst);
  return import(pathToFileURL(dst).href);
}

const { ceil99, ladderFor } = await loadEsm(process.env.PRICING_JS || path.join(here, "..", "pricing.js"));
const vectors = JSON.parse(readFileSync(
  process.env.LADDER_VECTORS || path.join(here, "fixtures", "ladder_vectors.json"), "utf8"));
assert.ok(Array.isArray(vectors) && vectors.length >= 3, "ladder_vectors.json must hold at least three vectors");

for (const v of vectors) {
  const bucket = {};
  v.costs.forEach((c, i) => { bucket[i] = { cost: c }; });
  const got = ladderFor("vector:" + v.name, bucket, v.anchor);
  const gotStr = {};
  for (const k of Object.keys(got)) gotStr[k] = got[k];
  assert.deepStrictEqual(gotStr, v.expected, `vector ${v.name}: got ${JSON.stringify(gotStr)}, want ${JSON.stringify(v.expected)}`);
}

// ceil99 rounds UP to the next .99 and never below its input.
assert.strictEqual(ceil99(0), 99);
assert.strictEqual(ceil99(1), 99);
assert.strictEqual(ceil99(100), 199);
assert.strictEqual(ceil99(199), 199);
assert.strictEqual(ceil99(200), 299);

// Memoised per key and anchor: same arguments, same object; another anchor, another ladder.
const b = { 0: { cost: 142 }, 1: { cost: 158 } };
assert.strictEqual(ladderFor("memo", b, 299), ladderFor("memo", b, 299), "same key+anchor must return the memoised object");
assert.notDeepStrictEqual(ladderFor("memo", b, 299), ladderFor("memo", b, 999), "another anchor must give another ladder");

// Lockstep with the store's own copy. Until api/solar-archive.js imports
// api/pricing.js (MH-9 Task 4, held by the FREEZE row), it carries an inline
// _ceil99/_ladderFor. Cut that copy out, run it, and require identical output to
// pricing.js on the shared vectors and on a sweep of costs and anchors, so the
// two cannot drift. When the inline copy is gone the store imports the module
// and there is nothing to compare.
const store = readFileSync(process.env.STORE_JS || path.join(here, "..", "solar-archive.js"), "utf8");
const from = store.indexOf("var _ladderCache = {};");
const to = store.indexOf("function priceForVariantDisplay(");
let compared = "store imports pricing.js (nothing to compare)";
if (from >= 0 && to > from) {
  const inline = new Function(store.slice(from, to) + "\nreturn { _ceil99: _ceil99, _ladderFor: _ladderFor };")();
  let n = 0;
  for (const v of vectors) {
    const bucket = {};
    v.costs.forEach((c, i) => { bucket[i] = { cost: c }; });
    assert.deepStrictEqual(inline._ladderFor("lockstep:" + v.name, bucket, v.anchor),
      ladderFor("lockstep2:" + v.name, bucket, v.anchor), `store copy differs from api/pricing.js on vector ${v.name}`);
    n++;
  }
  for (let anchor = 0; anchor <= 2500; anchor += 111) {
    for (let base = 1; base <= 3000; base += 97) {
      const bucket = { a: { cost: base }, b: { cost: base + 40 }, c: { cost: base + 41 }, d: { cost: base * 2 } };
      assert.deepStrictEqual(inline._ladderFor("sw", bucket, anchor), ladderFor("sw2", bucket, anchor),
        `store copy differs from api/pricing.js at base ${base}, anchor ${anchor}`);
      n++;
    }
  }
  for (const c of [0, 1, 98, 99, 100, 101, 199, 200, 12345]) {
    assert.strictEqual(inline._ceil99(c), ceil99(c), `_ceil99(${c}) differs`);
  }
  compared = `store inline copy matches api/pricing.js on ${n} ladders`;
}
console.log(compared);
console.log("ladder (js) self-check passed: " + vectors.length + " vectors");
