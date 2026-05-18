# Solar Archive — Open TODOs

Last refreshed: **2026-05-15** (post round-2 alpha-tester sweep).

Persistence file for the alpha-tester feedback rounds. Items are
grouped by persona; check completed items off, drop new items at
the bottom of each section. Round-2 follow-ups live in a labelled
sub-block under each returning persona. Priority hints (P0–P3)
carried over from the original triage; round-2 P-bumps noted inline.

---

## 🚨 Security alert — round 2 (2026-05-15)

A round-2 security audit (Mira Sokolov, see the new persona section
below) surfaced four **P0** findings.

**Shipped in this round (commit pending below):**
- ✅ **P0 CRITICAL — Unauth Printify billing-abuse vector closed.**
  New `api/security.py` module enforces three gates on
  `/api/printify/{upload, product, checkout, publish}`:
  (1) Origin allowlist check (rejects browsers framing from
  non-Solar-Archive origins); (2) per-IP sliding-window rate-limit
  (8/min for upload+product+publish, 3 per 5 min for checkout —
  the only one that actually publishes); (3) **server-side
  BETA_MODE refusal** (the client button swap is no longer the
  only thing standing between an attacker and the operator's
  wholesale+ship bill — the endpoint itself returns 403 while
  beta is on). CORS in `main.py` tightened from `allow_origins=["*"]`
  to the same allowlist, configurable in production via the
  `ALLOWED_ORIGINS` env var.
- ✅ **P0 HIGH — `canvas_image` XSS in operator email closed.**
  `feedback_routes._sanitize` now strict-validates the base64 payload
  after the `data:image/png;base64,` prefix against a whitelist regex
  (`[A-Za-z0-9+/]+={0,2}`), so a `">` / `<script>` payload sneaking
  through breaks the regex and the canvas_image is dropped before it
  reaches the email `<img src>`.
- ✅ **/api/feedback rate-limit added** (5 per 60s per IP) — closes the
  Resend-quota-blowout + jsonl-disk-fill subpath of Mira's P0 HIGH.

**Also shipped 2026-05-17 (this commit):**
- ✅ **P0 HIGH — DOM XSS via `showInfo()` and `mockupStatus.innerHTML`**
  closed. New `escapeHtml()` helper in `solar-archive.js`; `showInfo()`
  refactored to **text-by-default** (`textContent`) with explicit
  `{html: true}` opt-in — only the two developer-authored modals
  (Data credits, Run-a-local-server) pass the opt-in. Every
  `mockupStatus.innerHTML` callsite that interpolates dynamic data
  (`err.message`, `product.name`, `variant`) now wraps the value in
  `escapeHtml()`. Browser-verified: Data credits still renders the
  citation HTML correctly; XSS payloads injected into a text-mode
  `<p>` produce the inert escaped string `&lt;script&gt;…`.
- ✅ **P0 HIGH — `postMessage` listener trusts any origin** closed.
  Added `PARENT_ORIGIN_ALLOWLIST` and an `e.origin` check at the
  top of the embedded-viewport listener; messages from any other
  origin are dropped before they can touch the FAB DOM.
- ✅ **P1 HIGH — Admin-key timing-observable compare** closed.
  `_check_admin_key` now uses `hmac.compare_digest`. (URL-transport
  of the admin key remains — see "Still open" below.)
- ✅ **P1 MEDIUM — Email `reply_to` spoofing** closed.
  `_valid_email()` validates against `pydantic.EmailStr`; invalid
  addresses are dropped (Resend then omits `Reply-To`). Added
  `pydantic[email]` to requirements.
- ✅ **P1 MEDIUM — Slack mrkdwn injection** closed.
  New `_slack_safe()` strips `<>|&*_`` from all user-controlled
  fields (body, title, name, email, context keys + values) before
  they reach the Slack mrkdwn payload — `<!channel>` pings,
  `[evil](http://phish)` links, and bold/italic abuse all neutralised.

**Still open (separate chunks):**
- ⏳ **P1 — Admin-key one-shot signed tokens.** `hmac.compare_digest`
  closes the timing oracle, but the admin key still travels in the
  Slack approve/reject URL query string → access logs, browser
  history, Referer leakage. Replace with one-shot HMAC-signed tokens
  per Slack notification.
- ⏳ **P3 INFO — `PRINTIFY_SSL_VERIFY` off by default outside Render.**
  Documented in `printify_routes.py`; doc-only follow-up.

---

## Reference: research notes

### Attribution policy

NASA SDO rules-of-the-road (canonical, applies to all SDO data):
> *Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams.*

Source: <https://sdo.gsfc.nasa.gov/data/rules.php>

**Helioviewer attribution is scoped to "you used our service."** The
JPG tier in the editor uses `takeScreenshot` from Helioviewer, so
prints derived from JPG would need a Helioviewer credit. **Raw / RHEF /
HQ RHEF** tiers come from VSO → SunPy → our pipeline and bypass
Helioviewer entirely — those prints only need the SDO rules-of-the-
road line. Decision: gate physical-product output behind the FITS
tiers so the attribution stack stays small. The Helioviewer credit
stays in the **site footer** (where it correctly covers JPG preview /
wavelength-tile usage).

**Round-2 amendment (Patricia):** The current footer credits "AIA,
EVE, and HMI science teams" but we don't actually surface EVE or
HMI imagery yet — reads as cargo-cult to a reviewer. Trim down to
"AIA science team" until those instruments actually feed a product.
Also: the JPG-tier print itself needs a "Imagery via Helioviewer
Project" stamp on the printed product, not just behind the modal.

### Citations (recorded in `api/solar-archive.js` → `CITATIONS`)

- `SDO_ACK` — NASA SDO rules-of-the-road acknowledgement.
- `AIA_PAPER` — *Lemen, J. R., et al. 2012, Sol. Phys., 275, 17.*
- `RHEF_PAPER` — *Gilly, C., et al. 2025, Sol. Phys., 300, 174.*
  ADS bibcode `2025SoPh..300..174G`.
  <https://ui.adsabs.harvard.edu/abs/2025SoPh..300..174G/abstract>
- `HELIOVIEWER_ACK` — Required only when Helioviewer service was used.

---

## Marcus Chen — astrophysics PhD candidate

- [ ] **P3** FITS download with full WCS header (`WAVELNTH`, `T_OBS`,
      `CDELT1/2`, `CRPIX`, `CROTA2`, `EXPTIME`, aia_prep level)
- [ ] **P3** Arcsec-precise pointing + Helioprojective (HPC) overlay
      on the crop UI (currently pixels-only)
- [ ] **P3** Cadence picker for AIA 12-second native cadence
- [ ] **P3** Batch export — pull a full flare sequence in one shot
- [ ] **P3** HMI continuum + magnetogram channels
- [ ] **P3** STEREO/EUVI coverage
- [ ] **P2** RHEF calibration-provenance fields per tier
      (kernel, radial bin width, aia_prep version) surfaced in UI
- [ ] **P2** DOI-style citation string baked into each exported frame
- [ ] **P2** Explicit color profile of exported PNG
      (sRGB? assigned LUT?) — note in tier descriptions

### Round 2 follow-up (2026-05-15)

**Satisfaction:** Cautiously encouraged — citation infrastructure
+ bandpass-vs-wavelength naming landed cleanly. Apologies for the
year slip in his round-1 note (RHEF paper is 2025, not 2023). The
four science-blockers above remain in the same priority order
(FITS > HPC > cadence > HMI/STEREO).

Two new asks now that the credit stack is visible:

- [ ] **P2** **Per-frame provenance** — the footer is a static
      acknowledgement, but real provenance needs the specific
      `aia_prep` version + RHEF kernel/radial-bin parameters baked
      into each downloaded frame, not site-wide. (Folds into the
      existing P2 "calibration-provenance fields" item — promote
      to per-download metadata, not just UI surface.)
- [ ] **P2** **Color-space declaration on exported PNG** — embed an
      sRGB ICC profile in the upload + state the LUT by name in a
      sidecar text file. Without it, "reproducibility across
      displays is a coin flip."

## Edna Hopkins — senior novice

- [x] **P1** Birthday-CTA shortcut *(closer to her "pick a date and we
      mail it")* — shipped in `bc4ec06`
- [ ] **P1** Plain-language tooltips / first-time hints for Å, RHEF,
      "HQ RHEF locked" — a tooltip dictionary or first-run overlay
- [ ] **P1** Clarify the "BETA" badge so it doesn't read as
      "might be unsafe to buy from"
- [ ] **P2** Simple-mode toggle — hide tabs/sliders, show pick-date →
      preview → buy in three taps
- [ ] **P2** Curated short list of products by default with a
      "show all" expander (the 25-item grid overwhelms her)

### Round 2 follow-up (2026-05-15)

**Satisfaction:** Warmer about the new birthday hero card ("found
a sun right away which made me smile"), but still blocked on three
fronts: BETA-mode prevents ordering ("the whole reason i came
back"), jargon (RHEF, Å) still unexplained, no trust signal about
credit-card safety.

- [ ] **P1** **Email-capture: "notify me when the store opens."**
      Edna's specific ask — small form on the BETA banner, sends
      an automated email when BETA_MODE flips off. Cheap to ship
      and converts every blocked round-1 visitor into a return
      customer.
- [ ] **P2** Trust-and-safety messaging about credit-card
      protection on the BETA banner / checkout page (when ordering
      enables) — Edna explicitly mentioned not knowing if her card
      number would be safe.

## Riley Park — Gen Z creator

- [x] **P1** Birthday Sun landing CTA — shipped in `bc4ec06`
- [ ] **P2** One-tap IG Story / TikTok share with date baked in as a
      sticker overlay (Web Share API)
- [ ] **P2** Aesthetic font / preset packs — y2k chrome, dark
      academia, handwritten, 70s gradient (orange/brown/cream)
- [ ] **P2** Surface phone-case product more prominently on the
      landing page (she missed it on first browse)
- [ ] **P2** Sticker variations beyond just the kiss-cut
- [ ] **P3** Friendship-bracelet duo / matching-suns product type
- [ ] **P3** 5-second animated GIF export of pulsing sun, ready for
      TikTok audio sync

### Round 2 follow-up (2026-05-15)

**Satisfaction:** Warming up — birthday CTA "literally a vibe and i
already typed in my bday like three times for the dopamine." But
"so close, not yet viral" without share + GIF + font packs.

- [ ] **P2** **Share-this-moment button on the RESULT page** — not
      buried in the editor but the moment the sun renders, "ppl
      post BEFORE they get distracted." Specific to the immediate
      post-render UX, complementary to the existing P2 share item.
- [ ] **P2** **"Shop your sun" carousel after the mockup renders** —
      surface the existing phone-case + sticker products that Riley
      missed on first browse. Right after the immediate-post-render
      share moment.

## Dr. Patricia Vasquez — solar physicist

- [x] **P1** Proper attribution string surfaced. Footer credit
      updated to the SDO rules-of-the-road line ("Courtesy of
      NASA/SDO and the AIA, EVE, and HMI science teams."). New
      "Data credits" footer link opens a modal with the full
      attribution stack — SDO ack, AIA instrument paper (Lemen
      2012), RHEF method paper (Gilly 2025), and Helioviewer
      Project credit scoped to JPG-tier previews.
- [x] **P1** AIA Lemen 2012 surfaced in the Raw tier tooltip
      and in the Data credits modal.
- [x] **P1** RHEF method paper (Gilly et al. 2025, Sol. Phys.
      300, 174) surfaced in the RHEF / HQ RHEF tier tooltips
      and the Data credits modal.
- [x] **P1** Wavelength vs filter/bandpass — the user-facing
      "wavelength" label stays for common-parlance accessibility,
      but the section title now has a clarifying tooltip
      explaining the bandpass relationship (e.g. AIA 171 is a
      ~3 Å EUV passband dominated by Fe IX). The Raw tier
      tooltip also calls it the AIA filter explicitly.

### Round 2 follow-up (2026-05-15)

**Satisfaction:** Substantially satisfied — citation scaffolding
landed cleanly. Two rigor gaps remain plus one forward-looking
suggestion.

- [ ] **P1** **JPG-tier print needs a visible "Imagery via
      Helioviewer Project" stamp on the printed product itself**,
      not just behind the Data Credits modal. Helioviewer's TOS
      asks for the acknowledgement on every product made from
      their imagery — at present the JPG-tier ack lives only in
      the modal, so a printed JPG-tier poster ships without
      visible Helioviewer credit. (FITS tiers can keep just the
      Lemen/Gilly stamp.)
- [ ] **P1** **Trim EVE / HMI from the footer line** until those
      instruments actually feed a product. Crediting science teams
      whose data you don't use reads as cargo-culted boilerplate
      to a reviewer. The `SDO_ACK` constant can carry the longer
      form once those channels actually surface.
- [ ] **P2** **Machine-readable provenance block** — emit JSON-LD
      or a sidecar `.txt` provenance file alongside each downloaded
      print, listing Frame/Date/Wavelength/Source/Pipeline. Lets
      educators and museums verify lineage without hunting through
      the site; "the sort of thing NASA EPO reviewers reward."

## Tom Hartwell — QA engineer

- [x] **P0** Mockup double-click guard — shipped in `bc4ec06`
- [x] **P0** Server-side date clamp (pre-2010-05-15 + future dates) —
      shipped in `bc4ec06`
- [x] **P0** `max_length` on feedback fields — shipped in `bc4ec06`
- [x] **P1** Variant-picker + feedback modal focus traps — new
      `installModalFocusTrap()` helper cycles Tab/Shift+Tab within
      the modal's focusable children, handles Escape, and restores
      focus to the previously-active element on close. Wired into
      both modals.
- [ ] **P1** Refresh-mid-RHEF orphans the request silently —
      resume-or-clean-shutdown handling. *(Deferred — invasive,
      needs server-side state-recovery design.)*
- [x] **P1** Slow-network timeout during RHE poll — each poll
      attempt now has a 15s `AbortController` timeout.
- [x] **P1** Midnight-UTC at the international dateline — server-
      side `_validate_solar_date()` now also takes a `time_str` and
      rejects datetimes more than 60s in the future.
- [x] **P1** Two-tab `localStorage` last-write-wins — *investigated;
      no fix needed.* Editor state is in-memory only.
- [ ] **P1** Browser-back during checkout flow returns to a stale
      editor (partial fix earlier; verify it covers the
      variant-cleared path). *(Re-verify in a clean session.)*
- [x] **P2** Products with `variantId === null` — defensive
      null-check in `runMockupQueue` skips the entry with a polite
      mockupStatus error and continues the queue.

### Round 2 follow-up (2026-05-15)

**Satisfaction:** "Solid Round 1 closeout — six of eight landed
cleanly; the two new defects are real but small, and the deferred
resume work is correctly scoped as a server-design item rather
than papered over." Three new defects in the new code itself:

- [ ] **P1** **Focus-trap escape on zero-focusables modal.**
      `_focusableInsideModal` early-returns when `length===0` — a
      modal opened in a transient "loading…" state with no buttons
      yet leaves Tab unhandled, focus escapes back to the page
      behind. Fix: trap the modal container itself with
      `tabindex="-1"` as a fallback so Tab still cycles.
- [ ] **P1** **Double-click guard watchdog race.** `_unbusy()` is
      wired on every visible error path, but the `_mockupWatchdog`
      (150s) only un-busies if `myToken === _mockupCallToken`. If
      a stale token wins the race the button stays
      `dataset.busy="1"` forever — user has to reload. Fix: clear
      busy unconditionally in the watchdog, then check token for
      the toast.
- [ ] **P1** **RHE poll timeout copy/math mismatch.** 60 attempts ×
      (up to 15s wire + 1.5s gap) = up to ~16 min wall-clock on a
      degraded link, but the reject still claims `"timed out after
      2 minutes"`. Either cap by elapsed wall-clock (`Date.now()`
      delta) or fix the copy — testers on Slow 3G will file this
      as a hang.
- [ ] **P1** Browser-back-during-checkout: Tom hasn't seen a
      re-verification result. Document the repro used to clear
      `selectedVariantByProduct` so it's reproducible end-to-end.

## Brenda Walsh — copy editor

- [x] **P1** US/UK spelling normalised (`colour` → `color`) — `bc4ec06`
- [x] **P1** `Flip Aspect` → `Flip aspect`, `Download Your Design` →
      `Download your design` — `bc4ec06`
- [x] **P1** Comma splice in comment placeholder — `bc4ec06`
- [x] **P1** "fine-tune crop, color, or add a caption" → "adjust the
      crop, tweak the color, or add a caption" (parallel structure)
      — `bc4ec06`
- [x] **P1** Tooltip terminal-punctuation pass — multi-clause
      tooltips with em-dash explanations now end with periods to
      match the multi-sentence Quality tier tooltips.
- [x] **P2** Section-title capitalisation — sentence case everywhere.
- [x] **P2** "1 R☉" / "1 R_sun" — settled on `R☉` everywhere.

### Round 2 follow-up (2026-05-15)

**Satisfaction:** Round-1 issues resolved cleanly. Two new flags:

- [ ] **P2** **Row labels still Title Case while siblings are
      sentence case** — `Crop Edge` / `Vig. Edge` / `Vig. Radius`
      vs `Crop` / `Background` / `Color`. Bring into line. Also
      spell out `Vig.` — opaque to first-time users.
- [ ] **P2** **Wavelength tile typography is inconsistent in two
      ways:**
      - **Units:** `6.3MK` / `10MK` / `0.8MK` (no space, capital
        MK) sit beside `5000K` (no decimal, bare K). Standardise
        with thin-space: `6.3 MK` / `5 MK` / `0.8 MK` / `5000 K`
        — or settle on one unit throughout (`0.005 MK` for the
        photosphere row).
      - **Descriptors:** alternate between noun phrases ("Hot
        flaring plasma", "Active regions") and slash-separated
        lists ("Flares / transition", "Corona / flares"). Pick
        one register so the tile grid scans as a table rather
        than a collage.

## Sam Rosenberg — accessibility consultant

- [x] **P1** Editor tab bar is now a proper ARIA `tablist` with
      arrow/Home/End keyboard nav — `bc4ec06`
- [x] **P0** Icon-only buttons get `aria-label`; decorative `<i>`
      icons get `aria-hidden="true"` — `bc4ec06`
- [x] **P0** `--text-dim` contrast bumped to AA across both modes
      — `bc4ec06`
- [x] **P1** Extended the polite `aria-live` region to mockup-
      generation status and filter-progress messages.
- [x] **P1** Focus traps in both modals — see Tom's QA section.
- [x] **P2** Accent-color contrast audit — `--accent-corona-text`
      added as a brightened variant for text usages.

### Round 2 follow-up (2026-05-15)

**Satisfaction:** Pleased — all three round-1 blockers genuinely
fixed. Five new gaps, each WCAG-cited; suggested next priority
listed first.

- [ ] **P1** **WCAG 2.4.7 Focus Visible (next priority per Sam)** —
      `:focus` rules use `outline:none` on inputs/selects without
      a clear `focus-visible` replacement on the dark theme. Ship
      a high-contrast focus-visible ring (e.g. `2px solid
      var(--accent-corona-text) + 2px offset`) across all
      interactive controls. Cheap to land and unblocks keyboard
      users on the dark theme.
- [ ] **P1** **WCAG 4.1.3** — no `role="alert"` /
      `aria-live="assertive"` channel for error states (failed
      download, generation failure). Polite alone risks missed
      messages. Add an assertive companion for errors.
- [ ] **P2** **WCAG 1.3.1 / 2.4.1** — no `<main>` / `<nav>` /
      `<footer>` landmarks. Add a "skip to content" link + the
      landmark structure so AT users can navigate by region.
- [ ] **P2** **WCAG 2.3.3** (AAA but increasingly expected) —
      `@media (prefers-reduced-motion: reduce)` is missing. Wipe
      transitions + `.fa-spin` keyframes will trigger vestibular
      issues.
- [ ] **P2** **WCAG 2.5.8** (new in 2.2) — icon-only `.edit-btn`
      buttons lack an explicit min 24×24 CSS target.

## Jordan Watanabe — startup founder

- [x] **P1** Birthday Sun gifting CTA above the fold — `bc4ec06`
- [ ] **P2** "Two Suns" anniversary diptych product type at the
      ~$120 canvas price point
- [ ] **P2** B2B angle — wholesale-friendly entry for science
      teachers, planetariums, museum gift shops, hospital maternity
      wards
- [ ] **P3** "Your Year in Solar Weather" Spotify-Wrapped-style
      December drop (free shareable image → paid print upsell)
- [ ] **P3** $19/mo Monthly Sun print club for subscribers
- [ ] **P3** Curated fine-art collection of the 50 most photogenic
      CME days (authority + SEO + press hook)
- [ ] **P3** Referral mechanism ("gift a sun, get a sun")
- [ ] **P2** FAQ + meta tags don't say "birthday gift" anywhere —
      organic-search loss; needs SEO copy refresh

### Round 2 follow-up (2026-05-15)

**Satisfaction:** Cautiously encouraged — copy direction is right
but the wedge is still buried mid-page. "Make the button literally
say 'Gift a Sun for a Birthday →' and pre-fill the field with a
memorable date so people see the magic before they type a single
character."

- [ ] **P1** **Move Birthday CTA above the fold** — currently lives
      in the upper-MIDDLE of the page, not the first paint.
- [ ] **P1** **Button copy: "Gift a Sun for a Birthday →"** instead
      of the current "See your sun →". Makes the gifting frame
      explicit, not implied.
- [ ] **P1** **Pre-fill the date input with a memorable date** so
      first-paint shows a sun (e.g. today's date one year ago, or
      a notable date like the 2017 eclipse) — magic-before-typing.
- [ ] **P2** **Sticky "You picked May 14, 2010 ✨" chip** following
      the user down the page so the canonical-date handoff is
      visually unbroken.
- [ ] **P2** **"Gift Note + Schedule Send" flow** — buyer picks
      recipient's birthday + writes a note, system **emails a
      teaser preview on the recipient's actual birthday morning**
      with the print shipping. "Unboxing-before-the-unboxing,
      share-bait, second acquisition channel."

Re-pitch priority order on existing P2/P3 items:

1. **FAQ + meta-tag with "birthday gift" SEO** — 10-min ship,
   biggest leverage on organic search (existing P2 item, **bump
   to P1**).
2. Two Suns diptych as the $120 upsell after first date pick.
3. B2B wholesale page (one form, "for museums + maternity wards").

---

## Mira Sokolov — security researcher *(round 2, NEW)*

Round-2 security audit, seven findings + one info note. **#1 must
ship before BETA_MODE flips off.** Pulled to the top of this file
as a security alert.

- [x] **P0 CRITICAL** **Unauth Printify proxies = billing abuse.**
      `/api/printify/{upload, product, checkout, product/{id}/publish}`
      forward to `api.printify.com` with the operator's
      `PRINTIFY_API_KEY`. No auth, no CSRF, no rate-limit, CORS
      `*`. Repro: any browser POSTs `/api/printify/checkout` with
      a valid blueprint+provider+variant_ids and a base64 PNG →
      real product **CREATED + PUBLISHED** to Shopify, operator
      eats wholesale + ship. `BETA_MODE` only flips the client
      button; the server endpoint is wide open. Mitigate:
      per-session signed token, same-origin + CSRF, server-side
      `BETA_MODE` refusal on `/checkout`, per-IP throttle.
      **Shipped 2026-05-15:** new `api/security.py` enforces Origin
      allowlist + per-IP rate-limit + server-side BETA_MODE refusal
      on all four mutating endpoints. CORS tightened from `*`.
      `ALLOWED_ORIGINS` env var allows production override.
- [x] **P0 HIGH** **DOM XSS via `showInfo()` and
      `mockupStatus.innerHTML`** (`solar-archive.js` L2515-25,
      L1416, L2552, L2658). `title` + `message` interpolated raw
      into `innerHTML`; any path landing server- or
      feedback-derived strings here is a sink (e.g. HQ RHEF error
      msg L2360). Repro: route `<img src=x onerror=...>` into
      `showInfo`. Mitigate: `createElement` + `textContent`, or
      strict CSP.
      **Shipped 2026-05-17:** new `escapeHtml()`; `showInfo()`
      refactored to text-by-default with `{html: true}` opt-in;
      every dynamic `mockupStatus.innerHTML` interpolation wrapped
      in `escapeHtml()`. Browser-verified.
- [x] **P0 HIGH** **`postMessage` listener trusts any origin**
      (`solar-archive.js` L201). Checks
      `e.data.source === 'solar-archive-parent'` but never
      `e.origin`. Repro: from any framing page,
      `window.frames[0].postMessage({source:'solar-archive-parent',
      type:'viewport', visibleBottomInIframe:9999}, '*')` mutates
      the FAB DOM. Impact: UI today, primes XSS the moment a
      handler hits `innerHTML`. Mitigate: hard-allowlist `e.origin`.
      **Shipped 2026-05-17:** `PARENT_ORIGIN_ALLOWLIST` constant +
      `e.origin` check at top of listener. Messages from any other
      origin dropped before touching the FAB.
- [x] **P0 HIGH** **`/api/feedback` abuse surface.** No CSRF, no
      Origin/Referer check, no rate-limit, CORS `*`.
      (a) Blast Resend free tier into quota lockout;
      (b) fill `feedback.jsonl` 8KB/row;
      (c) **`canvas_image` data-URI is emitted into the operator
          email `<img src='{canvas_image}'>` with NO escape**
          (`feedback_routes.py` L289). Body IS escaped; canvas_image
          is not. Mitigate: `_esc(canvas_image)` and
          strict-validate base64 chars after the prefix.
      **Shipped 2026-05-15:** Origin allowlist + 5/60s per-IP rate-
      limit on the POST. canvas_image base64 strict-validated
      against `[A-Za-z0-9+/]+={0,2}` after the prefix; payloads with
      `">` / `<script>` etc. fail the regex and get dropped to
      `None` before they ever reach the email body.
- [~] **P1 HIGH** **Admin key non-constant-time compare;
      query-string transport; logged.** `_check_admin_key` (L464)
      does `provided != expected` — timing-observable. Slack
      approve/reject links embed key in URL (L188-189) → access
      logs, browser history, Referer on any outbound click.
      Mitigate: `hmac.compare_digest`; header-only; rotate;
      one-shot signed tokens per Slack notification.
      **Partially shipped 2026-05-17:** `hmac.compare_digest` now
      used. URL-transport / one-shot-signed-token refactor still
      open (listed in cross-cutting work).
- [x] **P1 MEDIUM** **Email spoofing via `reply_to`.** Set straight
      from user email, no validation (L401).
      `email='victim@target.com'` + operator hits Reply =
      phishing primitive **from a verified Resend sender**.
      Subject snippet (first 60 chars of body) is attacker-
      controlled. Body in `pre-wrap` also obeys LLM-triage prompt
      injection. Mitigate: `EmailStr`, drop `reply_to`, or tag
      subject `[UNVERIFIED SUBMITTER]`.
      **Shipped 2026-05-17:** `_valid_email()` validates against
      `pydantic.EmailStr`; non-parseable addresses get nulled out
      so Resend omits `Reply-To` entirely. Added `pydantic[email]`
      to requirements. Subject-snippet tagging deferred (low-impact
      polish).
- [x] **P1 MEDIUM** **`context` dict → Slack mrkdwn injection.**
      `_format_slack_blocks` (L201) str-concats context values
      with no escape. `context = {'<!channel>': 'go'}` pings
      `@channel`; link syntax injects phishing links. (Email path
      escapes properly; Slack doesn't.) Mitigate: strip
      `<,>,|,&` or use Block Kit `plain_text`.
      **Shipped 2026-05-17:** `_slack_safe()` strips `<>|&*_``
      from body, title, name, email, and context keys+values
      before they reach the mrkdwn payload.
- [x] **P3 INFO** `PRINTIFY_SSL_VERIFY` off by default outside
      Render → dev MITM risk. Document.
      **Shipped 2026-05-17:** SECURITY NOTE added in
      `_printify_request` docstring explaining the dev-laptop
      assumption and pointing at `PRINTIFY_SSL_VERIFY=1` for any
      non-Render public deploy.

## Lex Marchetti — brand designer *(round 2, NEW)*

**Confirmed strengths** (don't lose these):
- Hero `H1` gradient + pulsing radial icon read as a real brand spine.
- BETA badge does real work — "scientific-advisory rather than sticker."
- Motion timings (0.3s `cubic-bezier(.4,0,.2,1)`, 0.12s press,
  3s hero pulse) are well-judged.

- [ ] **P2** **Two warm gradient blocks above the fold** (H1 +
      Birthday CTA) flatten optical hierarchy. Drop the CTA to a
      lower-saturation flare-only tint so the H1 keeps primacy.
- [ ] **P2** **Build-info span at 0.7rem** uses inline
      `font-family: monospace` and falls back to system mono with
      zero tracking. Add `+0.04em` letter-spacing AND switch to
      the JetBrains Mono that's already loaded (or self-host one
      face if it isn't).
- [ ] **P2** **Step-badge gradient `corona → accent-cool teal` is
      the one place the palette breaks** — the cool teal has no
      parent in the sun/flare/corona triad and reads like leftover
      Tailwind sky-400. Re-spec to `corona → flare` so badges
      belong to the family.
- [ ] **P2** **BETA badge orange is not tokenised** — three
      near-duplicate orange surfaces (BETA badge, beta-banner,
      Birthday CTA border) drift independently. Lock one
      warm-orange token across all three.
- [ ] **P3** **Spinner at 1s linear feels generic** vs the rest of
      the motion choreography. 0.9s + the same easing as state
      changes (`cubic-bezier(.4,0,.2,1)`) + tint trailing arc
      `var(--accent-corona)` so loading reads as brand, not
      bootstrap.
- [ ] **P3** **Formalise a tone-scale convention** —
      `--sun-50/100/300/500/700`, same for flare and corona; retire
      ad-hoc `rgba(247,168,37,0.16)` literals. The `corona-text`
      vs `corona` split that already exists for contrast becomes
      a pattern instead of an exception.

**Strongest opinion:** kill `--accent-cool` from the step-badges
entirely. Either earn a tier in the tone-scale or get removed from
the palette.

## Hank Yamashita — ergonomics expert *(round 2, NEW)*

Tested under a 30-minute simulated session — 3-5 prints, slider
tuning per print, frequent tab switches.

- [ ] **P1** **Slider hit-area is below Fitts' Law.** 6px tracks +
      ~14px native thumbs vs the ~9.6mm acquisition sweet spot
      for trackpad users. **Plus** 6-9 sliders stacked vertically
      per tab → first-dorsal-interosseous fatigue + trackpad-thumb
      RSI on a 30-minute session. Increase track height to ~10px
      and thumb to ~22-24px on `(pointer: coarse)` and on the
      desktop sliders both.
- [ ] **P1** **Number-key shortcuts.** Bind `1` / `2` / `3` (/`4`)
      to tab-switch + `R` to reset the active slider. Cuts ~70%
      of fine-pointing events for power users.
- [ ] **P2** **Visual fatigue from ~18:1 luminance ratio** between
      `#0a0a12` canvas and `#f7a825` sun-orange — every saccade
      forces iris re-accommodation; halation + dry eye after 30
      min (Benedetto et al., 2014). Either soften the canvas
      black to `#1a1a2e` or pull the sun-orange one step toward
      muted gold for the surrounding chrome only (keep the actual
      solar imagery untouched).
- [ ] **P2** **Cognitive overhead of three tabs hiding state.**
      Users must mentally cache crop values while on Adjust.
      Consider an inline "current state pill" row that survives
      tab switches (e.g. a row showing current crop %, vignette
      radius preset, etc., always visible above the tab bar).
- [ ] **P3** **Pomodoro session-rest nudge** at 25 minutes — a
      gentle banner suggesting a screen break.

**Notes for the docs / store page:**
- Device suitability: mouse > touchscreen > **trackpad (worst)**
  — indirection + tiny target + abducted thumb is the trifecta.
- Ambient lighting recommendation: 50-100 lux bias-lighting behind
  the monitor (ISO 9241-303); pure-dark room with the bright
  canvas blows pupils wide.

## Dr. Asha Mensah — DEI / inclusive design consultant *(round 2, NEW)*

**Top inclusion gap:** the app assumes an English-reading,
US-based, fast-broadband, physics-literate gift-buyer. Every other
inclusion win is downstream of fixing that stack.

- [ ] **P1** **Plain-language low-bandwidth mode** — single toggle
      that swaps jargon for human captions, locks to the JPG
      tier, and disables motion. **One lever moves four axes at
      once** (neurodivergence + socioeconomic + language + age).
- [ ] **P1** **Honor `prefers-reduced-motion`** — wipe transitions,
      auto-advancing JPG → Raw → RHEF → HQ RHEF, spinner
      keyframes. (Overlap with Sam's WCAG 2.3.3 ask above.)
      Also: let users pin a tier so the auto-advance stops being
      surprise motion.
- [ ] **P2** **Currency / shipping-region selector.** Shopify is
      implicitly USD; no visible region selector. Lose the
      non-US-card buyer at the price-display stage.
- [ ] **P2** **Locale switching + locale-aware date formats.** Page
      is `html lang="en"` only. Date input + "AIA imagery
      available from May 2010" assume MDY/English.
- [ ] **P2** **Wavelength tile font is small for presbyopic eyes**
      — 0.7-0.8rem stacked rows. Bump base size on
      `(min-resolution: …)` or simply across the board; the orange
      accent on dark fails AA at body sizes.
- [ ] **P3** **Cultural-symbolism review** of color tiles — red
      304 Å / purple 211 Å labels carry mourning / royalty
      connotations in parts of East Asia and West Africa that
      won't map cleanly onto "buy this as a gift." Worth a short
      review of the tile color palette + descriptor copy.
- [ ] **P3** **Server-rendered low-bandwidth fallback** for users
      on 2G / older devices / data-capped plans (Nokia in Lagos,
      Jio plan in India). Static HTML version that lets them
      pick a date + a pre-rendered JPG from a small CDN cache.

## Cole Ramirez — motor-impaired AT user *(round 2, NEW)*

Real assistive-tech run on macOS Voice Control + iOS Switch
Control. Sam's WCAG audit caught the basics; Cole's pass is the
deeper "what actually breaks when you USE the AT" layer.

**What works** (don't regress):
- Labelled buttons (Generate real mockup, Continue, Hard / Soft,
  Off / Fit / Disk, Burn Numbers Into Image) all reachable via
  "Click <name>" in Voice Control.
- Quality timeline is a real radiogroup → Voice Control names
  each step ("JPG quality", "Raw quality", …).
- Comment textarea: focus sticks, dictation is clean.
- "Press Escape" closes the variant picker (confirmed).

- [ ] **P0** **Wavelength tile grid is plain `.wl-card` divs** —
      no `role="button"`, no `aria-label`. Voice Control can't
      address them by name; users must "Show numbers" + scan ~12
      overlays + click the index. **One change, biggest single AT
      win on the page**: turn each `.wl-card` into a real button
      with an `aria-label` like
      `"171 Angstrom, golden, quiet corona"`. Same for `.wl-thumb`
      children.
- [ ] **P0** **Visible `+` / `−` step buttons next to every
      continuous-range slider** (Crop, Vignette, Brightness,
      Contrast, Hue, Size, Stroke, Text Offset). Voice users
      currently say "Press right arrow" 40 times to set a
      vignette — adding step buttons + an arrow-key shortcut is
      table-stakes for voice + switch control.
- [x] **P1** **Close-X (`×`) buttons read as "Click 2715"** (the
      codepoint) or blank when Voice Control can't find a label.
      Set explicit `aria-label="Close"` everywhere a `×` glyph is
      the only content.
      **Audit + fix 2026-05-17:** all `&#x2715;` close glyphs in
      `index.html` already had `aria-label`; the only unlabelled
      icon-only close was the dynamically-injected catalog close in
      `solar-archive.js` L8226 — added `aria-label="Close catalog"`
      and `aria-hidden="true"` on the inner icon.
- [ ] **P1** **Variant-picker listbox** inside `confirmSelectModal`
      has no roving tabindex — every variant is a sibling, so
      Switch Control item-scans the whole list. Add a real listbox
      pattern with roving tabindex.
- [ ] **P2** **Wavelength grid Switch-Control journey is the
      longest leg of a clean run** (~38 presses page-load to
      finished print). Add a group-jump landmark or a "skip to
      tile picker" affordance.

**Top blocker** (one line): wavelength tile grid as unnamed divs.

## Priya Iyer — performance engineer *(round 2, NEW)*

Tested on a throttled Moto G Power profile (Slow 4G, 4× CPU).
Findings ordered by predicted Core Web Vitals impact.

- [ ] **P1** **Render-blocking head: full Font Awesome from
      cdnjs** (~75KB gzipped CSS) blocks first paint for ~6 icons.
      Self-host a subset or swap to inline SVG. **Predicted LCP
      win on 4G mobile: 350-600ms.**
- [~] **P1** **No `preconnect` to `fonts.gstatic.com`** for Outfit;
      no `font-display: swap`. FOIT/swap stretches LCP text by
      ~400ms. Self-host one woff2 weight (~18KB) to drop the
      round-trip.
      **Note 2026-05-17:** investigated — `Outfit` is declared in
      `solar-archive.css` but never actually loaded from Google
      Fonts (silent fallback to the system sans-serif). No
      preconnect needed because no Google Fonts request fires. If
      we later opt to actually load Outfit, add the preconnect at
      the same time.
- [x] **P1** **No `preconnect` to the Render API origin.** First
      `/store-config` call eats a fresh DNS+TLS handshake (~250ms
      RTT). Add a `<link rel="preconnect">` to
      `solar-archive.onrender.com`.
      **Shipped 2026-05-17:** preconnect added in `index.html`
      `<head>` for `cdnjs.cloudflare.com` (Font Awesome) and
      `solar-archive.onrender.com` (API).
- [ ] **P1** **INP catastrophe on sliders.** Every
      `slider.addEventListener('input', renderCanvas)` is
      synchronous 80-200ms work vs the 16ms frame budget — INP
      lands in the **poor bucket (>500ms)**. **Biggest single
      perf win:** rAF-coalesce the input handlers + show a
      downsampled preview during drag, snap to full-res on
      `change`. Moves INP from ~500ms to <200ms (Good bucket).
- [ ] **P1** **`solar-archive.js` is 500KB / 10,302 lines, single
      file.** Editor (~30 slider handlers from line 4110+) ships
      to every visitor including ones who bounce at the hero.
      **Predicted TBT cut 1.5-2.5s on mid-range mobile** by
      lazy-loading the editor module behind the first
      product-card click.
- [ ] **P2** **`setInterval(_postIframeHeight, 800)` runs forever**
      plus `ResizeObserver` + `load` + `DOMContentLoaded` +
      `resize` = four redundant triggers for the same job. Drop
      the interval; the observer + events cover it.
- [ ] **P2** **`loadWavelengthThumbnails` fires on date `input`,
      not `change`** (line ~2397) — N fetches per keystroke. Add
      a 250ms debounce so typing a date isn't a network storm.
- [ ] **P2** **Memory ceiling on long sessions.** `thumbCache`
      (raw + rhef + canvas2048 + jpg per wavelength) +
      `mockupsRaw` + `mockupsFiltered` + 4 full-res state
      images = 200-400MB after 10 min. Mobile Safari kills tabs
      at 384MB. Add an LRU cap + drop the largest entry on
      memory pressure.
- [x] **P3** **`console.log` on every tile render** (line ~1802).
      Gate behind a `__DEBUG` flag so it doesn't ship to
      production.
      **Note 2026-05-17:** investigated — already gated. The
      `tileLog()` helper at L1814 short-circuits unless
      `?debug=tiles` / `?debug=1` is in the URL. The remaining 12
      `console.warn`/`console.error` sites are legitimate
      production diagnostics (catalog fetch failed, save-design
      mockup failed, etc.) and should stay.

---

## Cross-cutting work (not from a single persona)

- [x] FITS-quality gate on buy / generate-real-mockup — block on
      JPG-only, warn on MQ when HQ still rendering, pass through on
      HQ ready. Auto-promotes the editor filter to the best
      available tier before the upload snapshot. Landed alongside
      this TODOs file.
- [ ] When the attribution copy lands, surface citations next to the
      Quality tiles (JPG / Raw / RHEF / HQ RHEF) instead of (or in
      addition to) the printed product.
- [ ] Verify Helioviewer's TOS text on a fresh canonical URL — the
      current write-up is from the published Helioviewer paper +
      community convention because their wiki/docs redirect to an
      internal NASA host.
- [ ] Audit the rest of the app for hard-coded color-name strings vs
      the same `--text-*` variables Brenda's edit didn't touch
      (any place that still uses raw hexes for text on a dark panel
      should match the AA-compliant tokens).

### Round-2 additions

- [ ] **Build a `--SECURITY` CI check** that fails the build if any
      new `/api/printify/*` route is added without auth middleware.
      Belt-and-suspenders on top of the round-2 P0 fix.
- [ ] **Tone-scale roll-out** (Lex's brand ask) — once
      `--sun-N` / `--flare-N` / `--corona-N` exist, do a sweep
      replacing ad-hoc `rgba(247,168,37,0.16)` literals with named
      tokens.
- [ ] **Plain-language glossary** (intersection of Edna +
      Asha) — an inline tooltip dictionary for `Å`, `RHEF`, `HQ`,
      `BETA` that doubles as the "low-bandwidth captions" source
      for Asha's plain-language mode.

---

## Conventions

When ticking items off, please leave the commit short-hash that
shipped the fix in line with the bullet (see the `bc4ec06` markers
above). When a P-rating changes after fresh feedback, edit it in
place — keeps the file honest.

### Copy-style policy (per Brenda's pass)

- **Sentence case** for everything except brand/proper names.
  That includes section titles, modal titles, button labels, tab
  labels. Modal/dialog titles already followed this; section
  titles caught up in the same commit.
- **Tooltips:** complete sentences (or sentences-separated-by-em-
  dash with explanatory tails) end with periods. Single noun-phrase
  or single-verb action labels (Pan, Rotate 90°, Reset all edits,
  Invert colors, Add a text overlay, etc.) stay bare.
- **Spelling:** US English. `color`, `center`, `flavor`. The only
  exception is when a value is taken from an external source
  (e.g. a Printify variant label may carry its own spelling — pass
  through verbatim).
- **Solar radius:** `R☉` (U+2609 SUN). Not `R_sun`, not `R⊙`.

### Round 2 process notes

- Returning personas were given their original verbatim feedback
  + a summary of what shipped between rounds, then asked to
  re-test and grade. (Decision: shown rather than blind. Blind A/B
  is a separate future option.)
- Six new personas added unique perspectives (security, brand
  design, ergonomics, DEI, motor-AT, perf). Each got a fresh
  top-level section in the same shape as the round-1 eight.
- All round-2 submissions are tagged
  `context.alpha_test: true` + `context.round: 2` +
  `context.persona: <slug>` — filterable in the operator inbox.
