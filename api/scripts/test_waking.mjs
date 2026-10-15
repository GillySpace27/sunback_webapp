// Self-check for api/waking.js (MH-12): which failures earn the one
// automatic retry after a cold start, and that it is exactly one.
// Run: node api/scripts/test_waking.mjs
// WAKING_JS overrides the path (used to prove the test fails).
import assert from "node:assert";
import { copyFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// api/ has no package.json: import a temporary .mjs copy, which works on every Node.
async function loadEsm(file) {
  const dst = path.join(mkdtempSync(path.join(os.tmpdir(), "esm-")), path.basename(file, ".js") + ".mjs");
  copyFileSync(file, dst);
  return import(pathToFileURL(dst).href);
}

const { gatewayError, isWakeFailure, retryOnceAfterWake } =
  await loadEsm(process.env.WAKING_JS || path.join(here, "..", "waking.js"));

// Gateway pages are wake failures; the app's own JSON answers are not.
for (const s of [502, 503, 504]) {
  assert.ok(isWakeFailure(gatewayError(s, "text/html; charset=utf-8")), `${s} html is a wake failure`);
  assert.ok(isWakeFailure(gatewayError(s, "")), `${s} with no body type is a wake failure`);
  assert.strictEqual(gatewayError(s, "application/json"), null, `${s} JSON is the app answering`);
}
for (const s of [200, 202, 400, 404, 500, 501, 505]) {
  assert.strictEqual(gatewayError(s, "text/html"), null, `${s} is never a gateway wake`);
}

// Network errors from each browser engine, and fetchWithTimeout's marked one.
for (const m of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) {
  assert.ok(isWakeFailure(new TypeError(m)), `TypeError "${m}" is a wake failure`);
}
const marked = new Error("We can't reach the archive right now.");
marked.wakeNetwork = true;
assert.ok(isWakeFailure(marked), "fetchWithTimeout's marked network error is a wake failure");

// Code bugs, timeouts and data errors are not.
assert.ok(!isWakeFailure(new TypeError("Cannot read properties of undefined (reading 'x')")), "code TypeError");
assert.ok(!isWakeFailure(new Error("Request timed out after 30s")), "timeout");
assert.ok(!isWakeFailure(new Error("No VSO data for this date")), "data error");
assert.ok(!isWakeFailure(null) && !isWakeFailure(undefined), "nothing");

// One retry, only after the server is awake, and only for wake failures.
function counter(results) {
  const c = { calls: 0 };
  c.attempt = () => {
    const r = results[Math.min(c.calls, results.length - 1)];
    c.calls++;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  };
  return c;
}
const awake = () => Promise.resolve();
const down = () => Promise.reject(new Error("still asleep"));

{
  const c = counter([new TypeError("Failed to fetch"), "ok"]);
  let retried = 0;
  assert.strictEqual(await retryOnceAfterWake(c.attempt, awake, () => retried++), "ok");
  assert.strictEqual(c.calls, 2, "wake failure: exactly one retry");
  assert.strictEqual(retried, 1, "onRetry called once");
}
{
  const g = gatewayError(503, "text/html");
  const c = counter([g, g, "never"]);
  await assert.rejects(retryOnceAfterWake(c.attempt, awake), (e) => e === g);
  assert.strictEqual(c.calls, 2, "two wake failures in a row: still only one retry");
}
{
  const data = new Error("No VSO data for this date");
  const c = counter([data, "never"]);
  await assert.rejects(retryOnceAfterWake(c.attempt, awake), (e) => e === data);
  assert.strictEqual(c.calls, 1, "a real answer is never retried");
}
{
  const first = new TypeError("Load failed");
  const c = counter([first, "never"]);
  await assert.rejects(retryOnceAfterWake(c.attempt, down), (e) => e === first);
  assert.strictEqual(c.calls, 1, "server stays down: no retry, the original error surfaces");
}
{
  const c = counter(["ok"]);
  assert.strictEqual(await retryOnceAfterWake(c.attempt, down), "ok");
  assert.strictEqual(c.calls, 1, "success on the first try needs no health wait");
}

console.log("waking: ok");
