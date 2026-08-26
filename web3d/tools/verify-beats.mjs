// One-off verifier for the beat rail, the ?at= deep link, and the detents.
//
// Exists because the in-app Browser pane reports visibilityState "hidden" and
// runs ZERO rAF frames, which suspends Lenis entirely — so nothing scrolls,
// progress never updates, and every scroll-dependent feature looks broken
// there whether or not it is. Headless Chrome considers itself visible, which
// is the same reason capture-beats.mjs and render-plate.mjs exist.
//
//   node web3d/tools/verify-beats.mjs https://dev.myheliograph.com
import { chromium } from "playwright-core";

const CHROME =
  process.env.CAPTURE_CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = (process.argv[2] || "https://dev.myheliograph.com").replace(/\/+$/, "");

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
// reducedMotion "no-preference" ON PURPOSE. Headless Chrome reports
// prefers-reduced-motion: reduce by default, and the detent is deliberately
// disabled for reduced-motion visitors — so without this the settle test
// measures the guard, not the feature, and silently "passes" by not running.
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "no-preference",
});
page.on("pageerror", (e) => console.error(`  [pageerror] ${e.message}`));

const read = () =>
  page.evaluate(() => {
    const limit = document.documentElement.scrollHeight - innerHeight;
    const act = document.querySelector(".beatrail__tick.is-active .beatrail__label");
    return {
      limit,
      pct: limit > 0 ? Math.round((100 * window.scrollY) / limit) : null,
      beat: act ? act.textContent : "none",
      done: document.querySelectorAll(".beatrail__tick.is-done").length,
      ticks: document.querySelectorAll(".beatrail__tick").length,
    };
  });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── 1. rAF actually runs here (guards against re-learning the lesson above)
await page.goto(`${BASE}/experience/?d=2017-09-06&t=12:00&sky=1&ch=2`, { waitUntil: "load", timeout: 90_000 });
await page.waitForTimeout(4000);
const frames = await page.evaluate(
  () => new Promise((res) => { let n = 0; const t = performance.now() + 500;
    const tick = () => { n++; performance.now() < t ? requestAnimationFrame(tick) : res(n); };
    requestAnimationFrame(tick); })
);
// Headless throttles rAF to roughly 8fps. That is slow but LIVE, which is
// the only thing this guard cares about: the Browser pane ran zero.
check("rAF runs (harness is a valid place to test scroll)", frames > 2, `${frames} frames/500ms`);

const base = await read();
check("beat rail renders 9 ticks", base.ticks === 9, `${base.ticks} ticks`);
check("page is scrollable", base.limit > 1000, `limit ${base.limit}`);

// ── 2. ?at= lands mid-film instead of at the top
await page.goto(`${BASE}/experience/?d=2017-09-06&t=12:00&sky=1&ch=2&at=4`, { waitUntil: "load", timeout: 90_000 });
await page.waitForTimeout(5000);
const landed = await read();
// BEAT_STOPS[4] = 0.585 → ~58%
check("?at=4 lands mid-film", landed.pct !== null && landed.pct > 45, `landed at ${landed.pct}%`);
check("?at=4 rail shows a later beat", landed.done >= 3, `${landed.done} beats behind, active "${landed.beat}"`);

// ── 3. detents: come to rest just off a beat and get pulled onto it
await page.goto(`${BASE}/experience/?d=2017-09-06&t=12:00&sky=1&ch=2`, { waitUntil: "load", timeout: 90_000 });
await page.waitForTimeout(4000);
// Wheel to somewhere a little past a stop, then stop moving. BEAT_STOPS[1]=0.16.
const { limit } = await read();
await page.mouse.move(720, 450);
await page.mouse.wheel(0, Math.round(0.148 * limit));   // ~1.2% short of the stop
const before = await page.evaluate(() => window.scrollY);
await page.waitForTimeout(1800);                         // QUIET(220ms) + settle
const after = await page.evaluate(() => window.scrollY);
const target = 0.16 * limit;
// Demand it actually SETTLE on the stop, not merely drift closer — Lenis
// finishing its own smooth scroll would satisfy "moved toward" on its own.
const settledOn = Math.abs(after - target) < 0.004 * limit;
check("detent settles a near-miss ONTO the beat", settledOn,
      `${Math.round(before)} → ${Math.round(after)} (stop ${Math.round(target)}, off by ${Math.round(Math.abs(after-target))}px)`);

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
