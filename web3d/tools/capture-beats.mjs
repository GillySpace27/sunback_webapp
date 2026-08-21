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
  // Pin the identity if asked. Without this the capture uses whatever date the
  // store defaults to, which drifts with the data frontier — and a date past
  // the frontier has no imagery at all, so the Sun silently falls back to the
  // procedural plasma and the frame tests nothing. The dev build exposes the
  // store for exactly this kind of driving.
  const wantDate = process.env.CAPTURE_DATE;
  const wantChannel = process.env.CAPTURE_CHANNEL;
  if (wantDate || wantChannel) {
    await page.evaluate(
      ([d, c]) => {
        const st = window.__store && window.__store.getState();
        if (!st) return;
        if (d) st.setDate(d);
        if (c !== null && c !== undefined && c !== "") st.setChannel(Number(c));
      },
      [wantDate ?? null, wantChannel ?? null]
    );
  }

  // Let the first real frames land + the Sun texture resolve.
  await page.waitForTimeout(9000);

  // Report whether the REAL frame actually arrived. A capture taken on the
  // procedural fallback looks plausible and means nothing.
  const texStatus = await page.evaluate(() => {
    const st = window.__store && window.__store.getState();
    return st ? { status: st.texStatus, date: st.date, channel: st.channel } : null;
  });
  console.log(`  identity: ${JSON.stringify(texStatus)}`);

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
