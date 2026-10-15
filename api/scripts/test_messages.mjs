// Self-check for api/messages.js (MH-16): unknown codes keep today's text,
// and buyer text names no host, env var or attempt counter.
// Run: node api/scripts/test_messages.mjs
// MESSAGES_JS overrides the path (used to prove the test fails).
import assert from "node:assert";
import { copyFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
async function loadEsm(file) {
  const dst = path.join(mkdtempSync(path.join(os.tmpdir(), "esm-")), path.basename(file, ".js") + ".mjs");
  copyFileSync(file, dst);
  return import(pathToFileURL(dst).href);
}
const { BUYER_MESSAGES, GENERIC_BUYER_MESSAGE, buyerMessage } =
  await loadEsm(process.env.MESSAGES_JS || path.join(here, "..", "messages.js"));

assert.strictEqual(buyerMessage("origin_forbidden"), BUYER_MESSAGES.origin_forbidden);
assert.strictEqual(buyerMessage("no_such_code", "today's text"), "today's text", "unknown code keeps the caller's fallback");
assert.strictEqual(buyerMessage(null, "today's text"), "today's text", "no code keeps the caller's fallback");
assert.strictEqual(buyerMessage("toString"), GENERIC_BUYER_MESSAGE, "prototype keys are not codes");
assert.strictEqual(buyerMessage("no_such_code"), GENERIC_BUYER_MESSAGE);

for (const [code, text] of Object.entries(BUYER_MESSAGES)) {
  assert.ok(text && text.length < 200, `${code}: one short sentence or two`);
  assert.ok(!/—/.test(text), `${code}: no em dash`);
  assert.ok(!/https?:|\.com|\.dev|fly\.|localhost|[A-Z]{3,}_[A-Z]/.test(text), `${code}: no host or env var name`);
  assert.ok(!/attempt \d|\(\d+\/\d+\)/i.test(text), `${code}: no attempt counter`);
  assert.ok(!/\b(HQ|RHEF|MQ|Filtered)\b/.test(text), `${code}: buyer words are Original and Enhanced only`);
}
console.log("messages: ok");
