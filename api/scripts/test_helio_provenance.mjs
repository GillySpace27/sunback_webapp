// Self-check for helioProvenance in api/observation_card.js (SU-18 store
// portion): the field set of spec/provenance.md version 1.
// Run: node api/scripts/test_helio_provenance.mjs
// OBS_CARD_JS overrides the path (used to prove the test fails).
import assert from "node:assert";
import { copyFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.env.OBS_CARD_JS || path.join(here, "..", "observation_card.js");
const dst = path.join(mkdtempSync(path.join(os.tmpdir(), "esm-")), "observation_card.mjs");
copyFileSync(src, dst);
const { helioProvenance } = await import(pathToFileURL(dst).href);

const p = helioProvenance({ wavelength: 171, dateStr: "2026-10-02", timeStr: "18:30", editorFilter: "rhef" });
for (const k of ["product", "version", "instrument", "observed", "credit"]) assert.strictEqual(typeof p[k], "string", k);
assert.strictEqual(p.product, "my-heliogram");
assert.strictEqual(p.instrument, "SDO/AIA 171");
assert.match(p.observed, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
assert.strictEqual(p.observed, "2026-10-02T18:30:00Z");
assert.strictEqual(p.credit, "Imagery courtesy of NASA/SDO and the AIA science team.");
assert.strictEqual(p.rhef, null, "no stamp line available: null, never invented");
assert.strictEqual(p.citation, null);
assert.ok(p.disclaimer.includes("not a calibrated radiance"), "RHEF tier carries the disclaimer");
assert.ok(!("disclaimer" in helioProvenance({ wavelength: 171, dateStr: "2026-10-02", editorFilter: "raw" })));
assert.strictEqual(helioProvenance({ wavelength: 171, dateStr: "2026-10-02", rhefStamp: "RHEF x" }).rhef, "RHEF x");
const bare = helioProvenance({});
assert.strictEqual(bare.instrument, "unknown");
assert.strictEqual(bare.observed, null);
for (const v of Object.values(p)) assert.ok(v === null || typeof v === "string");
console.log("test_helio_provenance: ok");
