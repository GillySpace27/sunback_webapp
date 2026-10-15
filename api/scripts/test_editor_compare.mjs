// Self-check for the editor's drag comparison (MH-11): api/editor_compare.js
// and the markup and CSS it relies on.
// Run: node api/scripts/test_editor_compare.mjs
// EDITOR_COMPARE_JS and EDITOR_COMPARE_CSS override the paths (used to prove
// the test fails).
import assert from "node:assert";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const api = path.join(here, "..");

// api/ has no package.json: import a temporary .mjs copy, which works on every Node.
async function loadEsm(file) {
  const dst = path.join(mkdtempSync(path.join(os.tmpdir(), "esm-")), path.basename(file, ".js") + ".mjs");
  copyFileSync(file, dst);
  return import(pathToFileURL(dst).href);
}

const { lookFilters, newestDayThumbUrl, compareLabels, shortDate } =
  await loadEsm(process.env.EDITOR_COMPARE_JS || path.join(api, "editor_compare.js"));

// Enhanced is the full-resolution render when it exists, else the preview
// render, and never the Original tier standing in for it.
const ready = (set) => (f) => set.includes(f);
assert.deepStrictEqual(lookFilters(ready(["raw", "rhef", "hq_rhef"])), { original: "raw", enhanced: "hq_rhef" });
assert.deepStrictEqual(lookFilters(ready(["raw", "rhef"])), { original: "raw", enhanced: "rhef" });
assert.deepStrictEqual(lookFilters(ready(["raw"])), { original: "raw", enhanced: null });

// The newest day comes from /api/data_frontier and nothing else.
assert.strictEqual(
  newestDayThumbUrl("", { latest: "2026-10-12" }, 193),
  "/api/helioviewer_thumb?date=2026-10-12T12%3A00%3A00Z&wavelength=193&image_scale=12&size=512");
assert.strictEqual(newestDayThumbUrl("", null, 193), null, "no frontier, no newest-day request");
assert.strictEqual(newestDayThumbUrl("", { latest: "" }, 193), null);
assert.strictEqual(newestDayThumbUrl("", { latest: "today" }, 193), null);
assert.strictEqual(newestDayThumbUrl("", { latest: "2026-10-12" }, undefined), null);

// Buyer words are Original and Enhanced; the date mode labels both halves by date.
assert.deepStrictEqual(compareLabels("look", "2014-10-24", null),
  { left: "Original", right: "Enhanced", leftWord: "original", rightWord: "enhanced" });
const byDate = compareLabels("newest", "2014-10-24", { latest: "2026-10-12" });
assert.strictEqual(byDate.left, "Oct 24, 2014");
assert.strictEqual(byDate.right, "Oct 12, 2026");
assert.strictEqual(compareLabels("newest", "", null).left, "Your day");
assert.strictEqual(shortDate("2010-05-15"), "May 15, 2010");

// The markup reuses the shared widget's classes, and no CSS filter (the
// #vibeRawGamma display gamma included) touches either half: the Original
// half must be the pixels that print.
const html = readFileSync(path.join(api, "index.html"), "utf8");
const block = /<div class="compare-slider editor-compare hidden" id="editorCompareSlider"[\s\S]*?<\/div>\s*<\/div>/.exec(html);
assert.ok(block, "index.html has #editorCompareSlider built from the compare-slider markup");
for (const cls of ["compare-under", "compare-over", "compare-handle", "compare-label-left", "compare-label-right"]) {
  assert.ok(block[0].includes(cls), `#editorCompareSlider has .${cls}`);
}
assert.ok(!/filter\s*[:=]/.test(block[0]), "no inline filter on the editor comparison");
const css = readFileSync(process.env.EDITOR_COMPARE_CSS || path.join(api, "solar-archive.css"), "utf8");
for (const rule of css.match(/[^{}]*(editorCompare|editor-compare)[^{}]*\{[^}]*\}/g) || []) {
  assert.ok(!/(^|[^-])filter\s*:/.test(rule.split("{")[1]), `no CSS filter on the editor comparison: ${rule.trim().split("{")[0]}`);
}
assert.ok(/editor-compare/.test(css), "solar-archive.css styles .editor-compare");

console.log("test_editor_compare: ok");
