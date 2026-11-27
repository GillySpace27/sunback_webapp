// Window choice of the holiday banner block in solar-archive.js (T14).
// The block is the text between the HOLIDAY-BANNER markers, run against a
// stub DOM. Run: node api/scripts/test_holiday_banner.mjs
// HOLIDAY_JS overrides the path (used to prove the test fails).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(process.env.HOLIDAY_JS || path.join(here, "..", "solar-archive.js"), "utf8");
const m = src.match(/\/\/ HOLIDAY-BANNER-BEGIN[\s\S]*?\/\/ HOLIDAY-BANNER-END/);
assert.ok(m, "banner block markers not found");

function run(search, nowMs) {
  const el = { hidden: true, textContent: "" };
  const RealDate = Date;
  const fakeDate = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [nowMs])); }
  };
  new Function("document", "location", "Date", m[0])(
    { readyState: "complete", getElementById: () => el, addEventListener() {} },
    { search }, fakeDate);
  return el;
}
const T1 = "20% off everything through Friday, Dec 4. Order by then for Christmas delivery in the US.";
const T2 = "Too late for a print by Christmas? Give a gift card and let them choose their day.";
const o = (s) => run("?bannerNow=" + s, 0);
for (const [now, text] of [
  ["2026-11-26T23:59:59", null], ["2026-11-27T00:00:00", T1], ["2026-12-04T23:59:59", T1],
  ["2026-12-05T00:00:00", T2], ["2026-12-24T23:59:59", T2], ["2026-12-25T00:00:00", null],
]) {
  const el = o(now);
  assert.strictEqual(el.hidden, text === null, now);
  assert.strictEqual(el.textContent, text ?? "", now);
}
// Real clock path: 2026-12-04T23:30 MST = 2026-12-05T06:30Z (still window 1, Denver time).
assert.strictEqual(run("", Date.UTC(2026, 11, 5, 6, 30)).textContent, T1);
assert.strictEqual(run("", Date.UTC(2026, 11, 5, 7, 30)).textContent, T2);
// A malformed override is ignored, not trusted.
assert.strictEqual(run("?bannerNow=garbage", Date.UTC(2026, 11, 5, 7, 30)).textContent, T2);
console.log("test_holiday_banner: ok");
