// Print-master renderer for the Dimensional SKU.
//
// Renders the SAME shaders the film uses (?plate=1 mounts PlateScene, which
// mounts the film's own <Sun/>), so the object sold is the object shown. That
// identity is the entire argument for this SKU — the moment the plate is
// rendered by a second code path it stops being a soft proof.
//
// Square master by design: api/main.py::_crop_to_aspect centre-crops per
// product, so one master serves every aspect from 2:3 poster to 7:3 mug wrap.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import path from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.PLATE_URL || "http://localhost:5173/";
const OUT = process.env.PLATE_OUT || "plates";
const SIZE = Number(process.env.PLATE_SIZE || 2048);
const DATE = process.env.PLATE_DATE || "2017-09-06";
const CHANNEL = process.env.PLATE_CHANNEL || "5";
const LOOK = process.env.PLATE_LOOK || "raw";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

await page.goto(`${BASE}?plate=1&bare=1&look=${LOOK}&ch=${CHANNEL}&d=${DATE}`, { waitUntil: "load", timeout: 90_000 });
await page.waitForSelector("canvas", { timeout: 90_000 });

await page.evaluate(([d, c]) => {
  const st = window.__store && window.__store.getState();
  if (!st) return;
  st.setDate(d);
  st.setChannel(Number(c));
}, [DATE, CHANNEL]);

// SwiftShader at 2048 is slow, and the RHEF frame is a real FITS fetch plus a
// filter pass on the backend (~20-25s cold), so wait for the look to actually
// resolve rather than guessing a timeout.
await page
  .waitForFunction(() => window.__store?.getState()?.texStatus === "ready", null, { timeout: 120_000 })
  .catch(() => console.warn("texStatus never reached ready"));
await page.waitForTimeout(2_500);
if (LOOK === "rhef") {
  await page
    .waitForFunction(() => window.__store?.getState()?.rhefStatus === "ready", null, { timeout: 180_000 })
    .catch(() => console.warn("rhefStatus never reached ready"));
  await page.waitForTimeout(4_000); // let the crossfade land
}

const st = await page.evaluate(() => {
  const s = window.__store && window.__store.getState();
  return s ? { status: s.texStatus, rhef: s.rhefStatus, look: s.look, date: s.date, channel: s.channel } : null;
});
console.log("identity:", JSON.stringify(st));
if (LOOK === "rhef" && (!st || st.rhef !== "ready")) {
  // The first version of this guard only checked the base texture, so a run
  // whose RHEF frame failed wrote a raw plate under an "_rhef_" filename — a
  // mislabelled master, which is worse than no master.
  console.error(`REFUSING to write plate: look=rhef but rhefStatus=${st && st.rhef}`);
  await browser.close();
  process.exit(2);
}
if (!st || st.status !== "ready") {
  // Refuse to emit a plate rendered on the procedural fallback. It looks
  // entirely plausible and is not the customer's Sun.
  console.error("REFUSING to write plate: texture never reached 'ready'");
  await browser.close();
  process.exit(2);
}

const file = path.join(OUT, `plate_${st.date}_ch${CHANNEL}_${LOOK}_${SIZE}.png`);
await page.screenshot({ path: file, omitBackground: false });
console.log("wrote", file);
await browser.close();
