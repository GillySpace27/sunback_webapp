// Self-check for the hero's two front doors (MH-13).
// Run: node api/scripts/test_hero_doors.mjs
// HERO_HTML and HERO_JS override the paths (used to prove the test fails).
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const api = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(process.env.HERO_HTML || path.join(api, "index.html"), "utf8");
const js = readFileSync(process.env.HERO_JS || path.join(api, "solar-archive.js"), "utf8");

const hero = /<header class="hero"[\s\S]*?<\/header>/.exec(html);
assert.ok(hero, "index.html has the hero header");
const h = hero[0];

// Both doors are plain links (zero-JS) whose targets exist on the page.
const doors = [...h.matchAll(/<a href="#([A-Za-z][\w-]*)" class="hero-door[^"]*" data-door="(\w+)"/g)];
assert.deepStrictEqual(doors.map((m) => m[2]), ["date", "product"], "date door first, then product");
for (const [, target, door] of doors) {
  assert.ok(new RegExp(`id="${target}"`).test(html), `the ${door} door's target #${target} exists`);
  assert.ok(!h.includes("onclick"), "no inline handlers on the doors");
}

// Nothing the hero held before is gone, and the doors sit above the
// price anchor and the NASA/SDO credit.
const order = ["<h1", "hero-tagline", "hero-doors", "Pick any date since May 2010", "hero-anchor", "hero-credit", "betaBanner"];
let last = -1;
for (const mark of order) {
  const at = h.indexOf(mark);
  assert.ok(at > last, `hero keeps "${mark}" in order`);
  last = at;
}
assert.ok(h.includes("Courtesy of NASA/SDO"), "NASA/SDO credit stays in the hero");

// The GA4 door event fires only after cookie consent.
const block = /function initHeroDoors\(\)[\s\S]*?\}\)\(\);/.exec(js);
assert.ok(block, "solar-archive.js wires the hero doors");
const ev = block[0].indexOf('"hero_door_chosen"');
const gate = block[0].lastIndexOf('_cookieConsentState() === "accept"', ev);
assert.ok(ev > 0 && gate > 0 && gate < ev, "hero_door_chosen is sent only behind the consent check");
assert.ok(!/\.value\s*=/.test(block[0]), "the date door never fills the date field");

console.log("test_hero_doors: ok");
