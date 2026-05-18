# Session continuity notes (post-compression breadcrumb)

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
