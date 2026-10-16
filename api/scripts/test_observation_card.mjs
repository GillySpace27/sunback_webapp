// Self-check for api/observation_card.js (MH-19).
// Run: node api/scripts/test_observation_card.mjs
// OBS_CARD_JS overrides the path (used to prove the test fails).
import assert from "node:assert";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.env.OBS_CARD_JS || path.join(here, "..", "observation_card.js");
const dst = path.join(mkdtempSync(path.join(os.tmpdir(), "esm-")), "observation_card.mjs");
copyFileSync(src, dst);
const { WAVELENGTH_GLOSSES, observationRows, canvasLabel, processingText, certificateHref } =
  await import(pathToFileURL(dst).href);

// Glosses must match the film's channel table word for word.
const ts = readFileSync(path.join(here, "..", "..", "web3d", "src", "data", "wavelengths.ts"), "utf8");
const seen = [...ts.matchAll(/angstrom: (\d+),.*?sees: "([^"]+)"/g)].map((m) => [Number(m[1]), m[2]]);
assert.strictEqual(seen.length, 8, "eight AIA channels in wavelengths.ts");
for (const [wl, sees] of seen) assert.strictEqual(WAVELENGTH_GLOSSES[wl], sees, "gloss " + wl);

const rows = Object.fromEntries(observationRows({ wavelength: 193, date: "2026-10-01", time: "12:00", look: "rhef" }));
assert.ok(rows.Wavelength.startsWith("193 Å: Corona"));
assert.ok(rows.Requested.includes("2026-10-01 12:00 UT") && rows.Requested.includes("nearest"), "time is labelled as requested");
assert.ok(rows.Processing.includes("Gilly & Cranmer 2025") && rows.Processing.includes("not a calibrated radiance"));
assert.ok(!processingText("raw").includes("RHEF"), "Original never claims RHEF");

const seen2 = Object.fromEntries(observationRows({ wavelength: 193, date: "2026-10-01", time: "12:00", observed: "2026-10-01T12:00:07Z" }));
assert.strictEqual(seen2.Observed, "2026-10-01 12:00:07 UT");
assert.ok(!("Requested" in seen2), "FITS time replaces the requested time");
assert.ok("Requested" in Object.fromEntries(observationRows({ date: "2026-10-01", observed: "<script>" })), "a non-ISO time is ignored");

const bare = Object.fromEntries(observationRows({}));
assert.ok(!("Wavelength" in bare) && !("Requested" in bare), "unknown facts are omitted, not guessed");

assert.strictEqual(canvasLabel({ wavelength: 304, date: "2026-10-01", look: "raw" }),
  "Solar image, from 2026-10-01, 304 Angstrom, chromosphere and prominences, Original");
for (const s of [...Object.values(WAVELENGTH_GLOSSES), canvasLabel({ date: "x" })]) assert.ok(!s.includes(String.fromCharCode(0x2014)));
assert.strictEqual(certificateHref({ wavelength: 193, date: "2026-10-01", time: "12:00" }), "/api/certificate?d=2026-10-01&wl=193&t=12%3A00");
assert.strictEqual(certificateHref({ wavelength: 193 }), "", "no date: no link");
assert.ok(certificateHref({ wavelength: 193, date: "2026-10-01", observed: "2026-10-01T12:00:07Z" }).includes("&obs=2026-10-01T12%3A00%3A07Z"));
console.log("test_observation_card: ok");
