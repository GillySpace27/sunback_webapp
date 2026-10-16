// Self-check for the Worker's shareIdentity (MH-18): which query strings may
// turn into a per-date og:image URL. HTMLRewriter itself needs the Workers
// runtime and is UNCHECKED here.
// Run: node api/scripts/test_share_meta.mjs
// SHARE_META_JS overrides the path (used to prove the test fails).
import assert from "node:assert";
import { copyFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.env.SHARE_META_JS || path.join(here, "..", "..", "infra", "worker", "src", "index.js");
const dst = path.join(mkdtempSync(path.join(os.tmpdir(), "esm-")), "index.mjs");
copyFileSync(src, dst);
const { shareIdentity } = await import(pathToFileURL(dst).href);

assert.deepStrictEqual(shareIdentity("?d=2026-10-01&t=12:00&wl=193"), { d: "2026-10-01", t: "12:00", wl: "193" });
assert.deepStrictEqual(shareIdentity("?d=2026-10-01"), { d: "2026-10-01", t: "12:00", wl: "193" }, "defaults");
assert.strictEqual(shareIdentity(""), null, "no date: leave the static card");
assert.strictEqual(shareIdentity("?d=2026-10-01\"><script>"), null, "no markup through d");
assert.strictEqual(shareIdentity("?d=2026-10-01&wl=1;drop"), null, "no junk through wl");
assert.strictEqual(shareIdentity("?d=2026-10-01&t=noon"), null);
console.log("test_share_meta: ok");
