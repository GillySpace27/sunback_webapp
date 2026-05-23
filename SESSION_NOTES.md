# Session continuity notes (post-compression breadcrumb)

## ▶ NEXT SESSION — EXECUTE THIS (plan locked 2026-05-22)

### Status (2026-05-22 evening)

- **Phase A — DONE + live.** Default HQ-RHEF (AR 2192 / 193) cached on
  `/var/data` via `POST /api/admin/warm_default` (X-Admin-Key gated).
  `do_generate_sync` self-restores from /var/data + writes through.
  Frontend probes `/asset/hq_SDO_193_20141024.png` on landing and
  primes `hqCache` + `state.hqReady`.
- **Phase B — DONE + live.** 25 real Printify mockups pre-rendered for
  the default image, cached at `/var/data/default_cache/mockups/*.png`
  with `/asset/default/default_mockups.json` as the manifest. Server
  cleans draft Printify products in a `finally` + a startup
  orphan-purge for `[MOCKUP-WARM]` titles. Frontend renderProducts
  swaps in the cached `<img>` per tile while `state.isDefaultActive`
  is true (flips false on user date/wavelength change).
- **Mount-order trap (logged for future):** Starlette evaluates mounts
  in registration order, first match wins. Specific mounts (e.g.
  `/asset/default`, `/asset/preview`) must register BEFORE the
  catch-all `/asset` or they're shadowed and silently return 404 from
  the wrong tree.

### NEXT — HEK best-time-of-day backend

The lone remaining big rock. Decisions still locked from earlier:
- Backend route that queries the Heliophysics Event Knowledgebase via
  SunPy's HEK module for a given date; returns the time of the most
  striking event so the frontend can auto-fill the time-of-day input.
- Ranking: **CMEs / prominences ABOVE flares** (flares oversaturate
  in 193). Then largest active region. Quiet-day → noon fallback.
- Report the chosen event on the wavelength pane with tooltips
  (event type, GOES class if any, peak time UTC).
- Per-date caching (HEK queries take a few seconds).

The earlier full plan for HEK is below (the A → B → HEK section).
Skip the A/B detail; both shipped.

---

### Earlier plan (kept for reference) — A and B shipped 2026-05-22

Default moment is fixed: **AR 2192, 2014-10-24, 193 Å** (chosen over
the 2017-09-06 X9.3, which oversaturates). Landing already defaults to
this date + auto-loads the 193 JPG preview (commit shipped 2026-05-22).

### Phase A — cache the default HQ RHEF (quick win) — SHIPPED
Goal: a user who keeps the default date gets full HQ instantly, no
1–3 min wait.
1. **Persistent path**: HQ/preview images currently save to `OUTPUT_DIR`
   which defaults to `/tmp` (EPHEMERAL — wiped every deploy). Add a
   persistent location on the disk, e.g. `DEFAULT_CACHE_DIR =
   FEEDBACK_DATA_DIR-style /var/data/default_cache` (reuse the same env
   pattern as `feedback_routes._data_dir()`), and a static mount/route
   to serve it.
2. **Warm-up**: admin-gated route `POST /api/admin/warm_default`
   (reuse `FEEDBACK_ADMIN_KEY` + `X-Admin-Key`, constant-time check).
   If the default HQ PNG isn't on disk, run the existing HQ-RHEF
   pipeline for 2014-10-24 / 193, write the PNG to the persistent dir.
   Idempotent (skip if present). Returns status JSON. I trigger it once
   post-deploy; it persists across future deploys (disk).
3. **Frontend**: on landing, if the cached default HQ exists, load it
   into the editor/canvas (so product mockups + editor use HQ from the
   start) instead of / after the JPG preview. Probe a known URL (e.g.
   `/asset/default/hq_193_20141024.png`) — 200 → use it; 404 → fall
   back to the current JPG-preview path.

### Phase B — pre-rendered REAL Printify mockups for the default — SHIPPED
Goal: product tiles show photorealistic ACTUAL-product mockups on
landing instead of the JS canvas approximations. (Reverts to canvas
mockups once the user picks their own date — pre-renders are
default-image only.)
1. Upload the default HQ to Printify once (reuse the upload path in
   `printify_routes.upload_image`'s underlying call, NOT the gated HTTP
   route — call the Printify API directly server-side to bypass the
   origin/rate-limit/BETA_MODE gates, which are for public callers).
2. For each product in `PRODUCTS` (~24): create a **draft** product
   with the default image on one representative variant (the product's
   default `variantId`). Printify returns mockup `images` on create.
3. Download the primary mockup image for each → write to the persistent
   dir (`/var/data/default_cache/mockups/<product_id>.png`). Record a
   manifest `default_mockups.json` mapping product_id → cached path/URL.
4. **Delete the draft products** from Printify after caching (Gilly
   OK'd destructive deletes here): `DELETE /v1/shops/{shop}/products/
   {id}.json`. Keep nothing lingering.
5. Fold into the same `POST /api/admin/warm_default` route (Phase A + B
   in one warm-up). Idempotent: skip products already cached.
6. **Frontend**: in `renderProducts` (the L8088 mockup-canvas block),
   when showing the DEFAULT image and a cached real mockup exists for
   the product, render an `<img>` of the cached mockup instead of the
   canvas draw. Once the user loads their own image, use the existing
   canvas path. Gate on a "still showing default" flag.

GOTCHAS / RISKS:
- The HQ pipeline + 24 Printify product-creates is heavy + slow → make
  the warm endpoint stream progress or run async + report; don't block
  a single request for minutes. Consider a task-id + poll like the HQ
  flow already uses.
- Printify rate limits on 24 rapid creates+deletes — add small spacing.
- Don't route the warm-up through the public gated `/api/printify/*`
  endpoints (BETA_MODE refuses them). Call the Printify API directly
  from the server-side warm routine.
- Representative variant per product: use `product.variantId`; verify
  it maps to a valid blueprint/provider variant for mockup gen.

### Then — HEK "best time of day" (already queued, see vault solar-archive.md)
Backend endpoint querying SunPy HEK for a date; rank **CMEs /
prominences ABOVE flares** (flares oversaturate in 193); report the
chosen event on the wavelength pane w/ tooltips; quiet-day → noon.

---

**Date snapshot:** 2026-05-17. Latest commit `0a1daf4` ships the
wavelength-tile divs→buttons conversion (Cole P0 motor-AT). Round 2
security + safe batch + wavelength tiles all live on Render.
`TODOS.md` is the durable source of truth for what's done and what
remains, grouped by persona and per-item commit hash.

## Round 2 sweep — fully shipped as of 2026-05-17

- `3cb8304` — Security P0 CRITICAL (Printify billing abuse) + canvas_image XSS
- `fddcafd` — Security P0 HIGH + P1 (DOM XSS, postMessage origin, admin-key timing, reply_to, Slack mrkdwn)
- `6a163af` — Quick wins (preconnect, catalog aria, SSL_VERIFY doc)
- `669d8eb` — Safe batch (date debounce, iframe-height dedup, focus-visible, reduced-motion, footer trim)
- `0a1daf4` — Wavelength tiles divs→buttons + aria-labels

In-flight as of this note: 4 background-agent worktrees doing Sam
aria-live, landmarks+skip-link, Hank slider hit-area, Patricia JSON-LD
provenance. To be merged into main as they finish.

## Editor lazy-load — planned, not started

Priya's P1 perf win. User approved the plan and wants me to start in
this session. Inventory + split:

- KEEP in `solar-archive.js` (~100KB): hero, wavelength tiles,
  feedback FAB, backend banner, birthday CTA, postMessage,
  showInfo, escapeHtml, CITATIONS.
- MOVE to `solar-archive-editor.js` (~400KB): all sliders, renderCanvas,
  crop/pan/zoom/text/clock-numbers tools, RHEF/HQ filter pipeline,
  Printify product cards + checkout, mockup queue.

Shared state via `window.SolarArchive = {state, API_BASE, $, showInfo,
escapeHtml, ...}`. Editor exposes itself as `window.SolarArchive.editor.*`.

Load trigger: first product-card click. Prefetch trigger: first
wavelength tile click (so editor warms while FITS fetch runs).

See the lazy-load plan section in the conversation transcript at
this session's start for the full plan.

## Major UX refactor — planned, approved, not started

**Goal**: in the Shopify-iframe embed, keep the editor canvas
visible at the top of the user's viewport while they manipulate
sliders below. Today the canvas scrolls off-screen as soon as the
user reaches the toolbar, because every `position: sticky` rule is
intentionally killed in embedded mode (sticky anchors to the
iframe's content height, not the parent's visible viewport — so it
never engages). Desktop standalone and mobile standalone already
work via sticky; only the embed is broken.

**Approach Gilly approved (2026-05-18)**: extend the existing
postMessage viewport protocol to carry `visibleTopInIframe` (today
only `visibleBottomInIframe` is sent, used by the feedback FAB).
Use it to set `.image-stage` to `position: absolute; top: <Y>`
inside the iframe so it floats with the parent's visible region.
A placeholder div in the document flow holds the spot so the
toolbar/sliders don't jump up.

**Code change inventory**:

1. **Frontend** (`api/solar-archive.js`):
   - Extend the `window.addEventListener("message", ...)` block at
     `~L213` (the one that handles `viewport` type for the FAB) to
     also read `e.data.visibleTopInIframe` when present.
   - On each viewport message in embedded mode, position
     `.image-stage` absolutely at the new top. Update a sibling
     `.image-stage-placeholder` div's height to match the canvas
     height so the layout doesn't reflow.
   - Throttle to rAF so dragging the parent scrollbar doesn't fire
     hundreds of style mutations per second.

2. **Frontend** (`api/index.html`):
   - Add `<div class="image-stage-placeholder" aria-hidden="true">`
     immediately before or after `<div class="image-stage">` to
     hold the layout space when the stage goes absolute.

3. **Frontend** (`api/solar-archive.css`):
   - Drop the `html.embedded .editor-with-preview .image-stage
     { position: static; ... }` override (lines ~3032-3037 in
     `solar-archive.css`).
   - Add `html.embedded .image-stage.floating { position:
     absolute; left: 0; right: 0; max-height: 40vh; }` plus
     placeholder sizing.

4. **Parent Shopify theme** (the listener lives in the user's
   Shopify theme; documented in earlier session notes as already
   installed for the FAB):
   - The current listener sends:
     ```js
     iframe.contentWindow.postMessage({
       source: "solar-archive-parent",
       type: "viewport",
       visibleBottomInIframe: <px>
     }, iframeOrigin);
     ```
   - Add a `visibleTopInIframe: <px>` field next to it. Calculation
     is `Math.max(0, -iframe.getBoundingClientRect().top)`.

**Risks to be ready for**:
- Two postMessage payloads in flight (FAB + canvas) — make sure
  rAF throttling keeps both responsive. The origin allowlist
  (`PARENT_ORIGIN_ALLOWLIST` shipped in `fddcafd`) already gates
  who can send these.
- Canvas size on tiny phones: 40vh might be too much. May need a
  `--canvas-floating-max-h` CSS var that scales down on narrow.
- `prefers-reduced-motion`: the floating position update is a
  layout shift; under reduced-motion, snap rather than animate
  (which we don't animate anyway, but document the intent).
- The standalone-mobile sticky path (lines ~2987-3001) should be
  unaffected — only `html.embedded` rules change.

**Smoke-test checklist after the change**:
1. Standalone desktop: canvas + product preview pin at top while
   sliders scroll. (No regression — already worked.)
2. Standalone mobile (<740px): canvas pins at top:0, preview at
   top:30vh, sliders scroll. (No regression — already worked.)
3. Embedded iframe in Shopify: scroll the parent page — canvas
   stays glued to the top of the visible region of the iframe;
   sliders below scroll normally; canvas updates in real-time as
   the user scrubs a slider. (THIS is the new behaviour.)
4. Feedback FAB: still anchors to the visible bottom of the iframe.
   (No regression — the FAB also rides the same listener.)
5. Slider INP under drag: still under 200ms; `scheduleCanvasRender`
   already coalesces.

**Estimated effort**: ~3 hours frontend + ~15 min Shopify theme
edit + ~30 min smoke testing in the embed. Reversible (single
commit, can `git revert`).

### STATUS 2026-05-18: frontend shipped, BLOCKED on Shopify theme

The frontend half is **done and on main** (commit after f72615c).
It is **dormant and safe** — it only activates once the parent
sends `visibleTopInIframe`, so standalone + current embed behave
exactly as before (verified: IIFE runs, no console errors, float
path never registers outside embedded mode).

What shipped:
- `solar-archive.js`: extended the embedded `message` listener to
  read `visibleTopInIframe`; new `_updateFloatingCanvas()` (rAF-
  coalesced) absolutely-positions `#imageStage` along the visible
  region, clamped to the editor bounds; lazy `image-stage-placeholder`
  holds the canvas grid slot; `is-floating` class hook. Updated the
  documented parent snippet to include `visibleTopInIframe`.
- `solar-archive.css`: `html.embedded .editor-with-preview` is now
  `position: relative` (positioning context); placeholder gets
  `grid-area: canvas`; `.image-stage.is-floating` caps at 42vh with
  a lift shadow.

**ACTION REQUIRED FROM GILLY (the blocker):** add one line to the
viewport postMessage in the Shopify theme — the same `<script>` that
already sends `visibleBottomInIframe` for the FAB. Add:

```js
var visibleTopInIframe = Math.max(0, -rect.top);
```

and include `visibleTopInIframe: visibleTopInIframe` in the
`postMessage({...})` payload. Full updated snippet is in the comment
block at the top of solar-archive.js (search "visibleTopInIframe").

**Then test in the real Shopify embed** (cannot be tested locally —
the float path only registers in an iframe with the parent listener):
1. Open a product editor in the embedded storefront.
2. Scroll the parent page down through the sliders → the canvas
   should ride the top of the visible region, sliders scroll under it.
3. Scrub a slider → canvas updates live while staying in view.
4. Scroll back up → canvas returns to natural position (unfloats).
5. Confirm the FAB still anchors to the visible bottom (no regression).
6. Confirm the canvas never floats above the editor top or overlaps
   the action bar at the bottom.

If the clamp math needs tuning (e.g. the 8px margin or 42vh cap),
those are the two knobs in `_updateFloatingCanvas` / the
`.is-floating` CSS rule.

### GOTCHA (2026-05-20): the parent theme has TWO message handlers

The Shopify theme's Solar-Archive integration needs BOTH, and they are
easy to conflate:
1. **Resize RECEIVER** — `addEventListener("message")` reading
   `{source:"solar-archive", type:"resize", height}` FROM the iframe
   and setting `iframe.style.height`. Without it the iframe is frozen
   at its CSS `min-height` (900px) with `scrolling="no"` → content
   clips, no scroll.
2. **Viewport SENDER** — `_saSendViewport()` posting
   `{source:"solar-archive-parent", type:"viewport", ...}` TO the
   iframe for the FAB + floating canvas.

When handing Gilly the floating-canvas snippet I said "replaces the
existing script," and his block did DOUBLE DUTY — so the receiver got
dropped and the embed truncated. Fix: a single combined block with
BOTH handlers (resize receiver + viewport sender), posted to the real
origin not `"*"`. The corrected block is in the chat transcript for
this session; if re-deriving, the iframe→parent resize message shape
is `{source:"solar-archive", type:"resize", height:<px>}` (sent by
`_postIframeHeight` in solar-archive.js). Always give the COMBINED
block, never sender-only.

## Feedback persistence (DONE 2026-05-21)

Render's filesystem is ephemeral → `feedback.jsonl` + `approved_catalog.json`
were wiped on every deploy (count had dropped to 1; all earlier
alpha-tester feedback survived only in Gilly's Outlook inbox).

Fix shipped + live:
- Code (`dc5590c`): both files resolve under `FEEDBACK_DATA_DIR` via a
  `_data_dir()` helper (mkdir -p + fallback to webapp root if unwritable).
- Infra: Gilly attached a **1 GB Render disk at `/var/data`** (~$0.25/mo,
  on top of the $44 instance). Then `FEEDBACK_DATA_DIR=/var/data` env var
  set via the Render MCP → redeploy.
- Verified: after deploy, `/api/feedback/count` read **0** (fresh disk,
  confirming the path switched), a tagged test POST wrote `idx:0` → count
  **1**. Cross-deploy survival is structurally guaranteed by Render disk
  semantics (not yet demonstrated with a second redeploy — offered).
- NOTE: one tagged test row ("[TEST — persistence check by Claude]") is
  in the live feedback now; harmless, Gilly can disregard.
- Caveat: disk-attached services lose zero-downtime deploys → ~30-60s of
  502 on each deploy now (acceptable for beta).
- Admin read endpoint (`GET /api/feedback`) is still disabled — no
  `FEEDBACK_ADMIN_KEY` set on Render. Set it if you want to query
  feedback via the API instead of email.

Old feedback emails: Gilly uses **Outlook** (not Apple Mail). Computer-use
access requests for Mail/Chrome/Gmail were denied/timed out; Outlook
request timed out twice (access flow seemed stuck). Recovering old emails
is parked — paste-on-demand or skip.

## What just happened (right before this note)

Round 1 alpha-tester sweep ran 8 persona agents against the live
site, captured ~45 asks, and converted the P0/P1 layer into shipped
fixes across commits `bc4ec06` → `a4e0cd6`. Persona names + emails
are namespaced so feedback emails carry `context.alpha_test: true`
and `context.persona: <slug>`.

Round 1 personas:

| Slug | Name | Lens |
|---|---|---|
| `astro_phd` | Marcus Chen | Sophisticated science user, FITS rigor |
| `senior_novice` | Edna Hopkins | Luddite grandma, wants a simple flow |
| `genz_creator` | Riley Park | Mobile / social / aesthetic, viral hooks |
| `solar_physicist_pi` | Patricia Vasquez | Critical domain expert, attribution rigor |
| `qa_engineer` | Tom Hartwell | Edge cases, race conditions, money risk |
| `copy_editor` | Brenda Walsh | House style, parallel structure, spelling |
| `a11y_consultant` | Sam Rosenberg | WCAG audit, ARIA, contrast |
| `startup_founder` | Jordan Watanabe | Product expansion, gifting wedge, CAC |

## Round 2 (in flight as of this note)

Two halves running in parallel:

**Returning eight (re-evaluating after the round-1 fixes shipped):**
Each persona is given their original verbatim feedback + a summary of
what changed in the P0+P1 sweep, then asked to re-test the live site,
grade satisfaction (which items they consider closed vs still open),
and flag any new things they notice. Decision was to **show them
their previous report** rather than blind-test — the goal is graded
follow-through, not unbiased re-impressions. (A blind A/B round is a
separate future option.)

**Six new lenses:**

| Slug | Name | Lens |
|---|---|---|
| `security_researcher` | Mira Sokolov | XSS / CSRF / IDOR / upload abuse / data exfiltration |
| `brand_designer` | Lex Marchetti | Visual hierarchy, typography, motion, brand cohesion |
| `ergonomics_expert` | Hank Yamashita | Long-session fatigue, click load, eye strain, RSI |
| `dei_consultant` | Dr. Asha Mensah | Inclusive UX, neurodivergent / socioeconomic / age inclusion |
| `motor_at_user` | Cole Ramirez | Real assistive tech (VoiceOver, switch, voice control) |
| `perf_engineer` | Priya Iyer | Core Web Vitals, bundle size, memory, mobile networks |

All 14 agents POST to `https://solar-archive.onrender.com/api/feedback`
with `context.alpha_test: true` and `context.persona: <slug>`. They
each return a `(verbatim feedback, one-line summary)` to me when done.

## When agents complete (post-compression instructions)

1. They report back via the Agent tool's task-notification system. The
   task summary contains the persona's verbatim feedback.
2. **Integrate into `TODOS.md`**, NOT a new file. Two patterns:
   - **Returning persona:** under their existing section, append a
     `### Round 2 follow-up (2026-05-15)` block with their grade,
     anything they consider still open, and any new asks.
   - **New persona:** add a new top-level persona section to TODOS.md
     in the same shape as the existing eight.
3. Group new asks into P0/P1/P2/P3 with the same priority rationale
   used in round 1.
4. Don't "second round.md" — the user explicitly asked for one file.

## Ground truth

- **TODOS.md:** durable list of asks, statuses, and decisions.
- **`feedback.jsonl`** (gitignored, in repo root): raw agent
  submissions, in case you need to reread persona feedback verbatim.
- **Recent commits** (a few back from `a4e0cd6`): full diff of what
  shipped between round 1 and round 2.
- The user's Shopify embed needs the postMessage resize listener
  installed alongside the iframe — already documented in earlier
  commits + reproduced in `TODOS.md`.

## Common gotchas after compression

- The user's email is `gillygumption@gmail.com` (operator inbox).
- The Render web service is `solar-archive.onrender.com`.
- Render is on the Standard plan ($25/mo) — no cold-start.
- BETA_MODE is on; "Create on Shopify" is replaced with
  "Download your design" until further notice.
- Helioviewer parent-side resize listener is in the user's Shopify
  theme — do not duplicate.
- The user has been very deliberate about preserving the round-1
  persona feedback in TODOS.md — don't strip it on integration.
