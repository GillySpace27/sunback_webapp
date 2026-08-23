// Screenshot a fixed set of pages at a fixed set of viewports.
//
// This exists to give the deploy panel's `regression` and `presentation`
// lenses something to actually look at. Both are worthless against source:
// regression needs the SAME pages from two tiers to diff, presentation needs
// a rendered page rather than CSS. Capturing both tiers with one script at
// identical viewports is what makes the comparison mean anything — a diff
// between a 1440px prod shot and a 1280px dev shot is noise.
//
//   node infra/scripts/capture_pages.mjs https://myheliograph.com out/prod
//   node infra/scripts/capture_pages.mjs https://dev.myheliograph.com out/dev
//
// Uses web3d's playwright-core + the system Chrome, exactly as
// web3d/tools/render-plate.mjs does. No new dependency.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import path from "node:path";

const CHROME =
  process.env.CAPTURE_CHROME_PATH ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BASE = process.argv[2];
const OUT = process.argv[3];
if (!BASE || !OUT) {
  console.error("usage: capture_pages.mjs <base-url> <out-dir>");
  process.exit(64);
}

// The pages a deploy can plausibly break. Keep this list SHORT and stable:
// it is a regression baseline, so churn in the list destroys the baseline's
// value. Add a page when a deploy has actually broken it.
const PAGES = [
  ["landing", "/"],
  ["editor", "/?d=2017-09-06&t=12%3A00&wl=171#editor"],
  ["experience", "/experience/"],
  ["privacy", "/privacy"],
];

const VIEWPORTS = [
  ["desktop", 1440, 900],
  ["mobile", 390, 844],
];

// The store paints its hero from network thumbs and the experience compiles
// shaders; both finish well after `load`. This is a settle delay, not a
// correctness wait — a capture that races them produces a half-painted
// baseline that reads as a regression on the NEXT run.
const SETTLE_MS = Number(process.env.CAPTURE_SETTLE_MS || 6000);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

let failures = 0;
for (const [vpName, width, height] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  for (const [name, route] of PAGES) {
    const url = BASE.replace(/\/+$/, "") + route;
    errors.length = 0;
    try {
      await page.goto(url, { waitUntil: "load", timeout: 60_000 });
      await page.waitForTimeout(SETTLE_MS);
      const file = path.join(OUT, `${name}_${vpName}.png`);
      await page.screenshot({ path: file, fullPage: false });
      const note = errors.length ? `  [${errors.length} page errors]` : "";
      console.log(`${file}${note}`);
      // Page errors are REPORTED, never fatal: a 404 on one thumbnail is a
      // finding for the panel to weigh, not a reason to abandon the capture
      // and leave the regression lens with nothing to diff.
      for (const e of errors.slice(0, 5)) console.log(`    ${e}`);
    } catch (e) {
      failures++;
      console.error(`FAILED ${url} — ${e.message}`);
    }
  }
  await page.close();
}

await browser.close();
// Exit non-zero only if a page could not be captured at all, so the caller
// can tell "the site is down" from "the site rendered with warnings".
process.exit(failures ? 1 : 0);
