// Self-check for api/day_scrub.js (MH-17): the day's ranked events as ticks
// on the 0..23 UTC scrubber.
// Run: node api/scripts/test_day_scrub.mjs
// DAY_SCRUB_JS overrides the path (used to prove the test fails).
import assert from "node:assert";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
async function loadEsm(file) {
  const dst = path.join(mkdtempSync(path.join(os.tmpdir(), "esm-")), path.basename(file, ".js") + ".mjs");
  copyFileSync(file, dst);
  return import(pathToFileURL(dst).href);
}
const { eventTicks, minutesOf, tickTitle } =
  await loadEsm(process.env.DAY_SCRUB_JS || path.join(here, "..", "day_scrub.js"));

assert.strictEqual(minutesOf("21:41"), 21 * 60 + 41);
assert.strictEqual(minutesOf("24:00"), null);
assert.strictEqual(minutesOf(""), null);

const ticks = eventTicks([
  { rank: 1, rank_label: "Top pick", time_utc: "21:41", event_type: "Flare", goes_class: "X3.1" },
  { rank: 2, rank_label: "Also notable", time_utc: "00:00", event_type: "Active region", ar_number: 2192 },
  { rank: 3, rank_label: "Also notable", time_utc: "23:30", event_type: "Eruption" },
  { rank: 1, rank_label: "Midday", time_utc: "12:00", event_type: "Midday", fallback: true },
  { rank: 4, time_utc: "late", event_type: "Flare" },
]);
assert.deepStrictEqual(ticks.map((t) => t.rank), [1, 2, 3], "fallbacks and unparseable times get no tick");
assert.strictEqual(ticks[0].hour, 21, "a tick snaps the scrubber to its hour");
assert.strictEqual(ticks[0].pct, 94.3, "21:41 sits at 21.68 of 23 hours along the track");
assert.strictEqual(ticks[1].pct, 0);
assert.strictEqual(ticks[2].pct, 100, "after 23:00 the tick stays on the track");
assert.strictEqual(ticks[0].title, "Top pick: Flare, GOES X3.1 class, 21:41 UTC (ranked event)");
assert.ok(tickTitle(ticks.length && { time_utc: "00:00", event_type: "Active region", ar_number: 2192 }).includes("NOAA AR 2192"));
assert.deepStrictEqual(eventTicks(undefined), []);

// The tick strip is wired into the existing scrubber, and its ticks are
// hidden from assistive tech (the event tiles above are the accessible list).
const js = readFileSync(path.join(here, "..", "solar-archive.js"), "utf8");
assert.ok(/id="hekTimeScrubTicks" aria-hidden="true"/.test(js), "the scrubber has a tick strip");
assert.ok(/eventTicks\(_hekCurrentEvents\)/.test(js), "ticks come from the events the tiles show");

console.log("test_day_scrub: ok");
