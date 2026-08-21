// Beat capture harness for /experience.
//
// Why this exists: the film only renders under requestAnimationFrame, and a
// browser suspends rAF in a hidden tab — so any capture surface that is not
// actually on screen returns black frames and the whole thing is unreviewable.
// A headless Chrome page is always "visible" to itself, so it paints.
//
// Uses the Chrome already installed on this machine (playwright-core ships no
// browser), and drives the DEV server rather than a built preview, because the
// dev server proxies /api — without it the Sun never gets its real SDO texture
// and every frame shows the procedural fallback instead of the actual product.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = process.env.CAPTURE_URL || "http://localhost:5173/";
const OUT = process.env.CAPTURE_OUT || "captures";

// Keep in sync with BEAT_STOPS in src/store.ts — the best-framed moment of each
// beat, not the geometric slice centres.
const BEATS = [
  ["01-threshold", 0.02], ["02-surface", 0.16], ["03-aperture", 0.235],
  ["04-crossing", 0.45],  ["05-sky", 0.585],    ["06-darkroom", 0.69],
  ["07-room", 0.82],      ["08-gift", 0.885],   ["09-gallery", 0.965],
];
const VIEWPORTS = (process.env.CAPTURE_VIEWPORTS || "desktop")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);
const SIZES = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    // Headless macOS Chrome has no usable GPU path, so force ANGLE onto
    // SwiftShader. Without these three the canvas is present but never paints
    // and every capture is a black rectangle.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

for (const vp of VIEWPORTS) {
  const size = SIZES[vp];
  if (!size) { console.error(`unknown viewport ${vp}`); continue; }
  const dir = path.join(OUT, vp);
  mkdirSync(dir, { recursive: true });

  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error(`  [pageerror] ${e.message}`));
  // NOT networkidle: Vite dev holds an HMR websocket open for the life of the
  // page, so networkidle never fires and the navigation times out. The explicit
  // canvas/loader waits below are the real readiness signal anyway.
  await page.goto(URL, { waitUntil: "load", timeout: 60_000 });

  // The loader covers the film until the lazy Three chunk mounts.
  await page.waitForSelector("canvas", { timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector(".loader"), null, { timeout: 60_000 })
    .catch(() => console.warn("  loader still up; capturing anyway"));
  // Let the first real frames land + the Sun texture resolve.
  await page.waitForTimeout(6000);

  for (const [name, frac] of BEATS) {
    await page.evaluate((f) => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.round(f * max));
    }, frac);
    // Lenis eases toward the target and the camera spline eases behind it;
    // both need to settle or the frame catches the film mid-transition.
    await page.waitForTimeout(2200);
    const file = path.join(dir, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`  ${vp}/${name}.png`);
  }
  await page.close();
}

await browser.close();
console.log("done");
