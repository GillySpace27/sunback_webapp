# Solar Archive — Open TODOs

Last refreshed: **2026-05-15**.

Persistence file for the alpha-tester feedback round. Items are
grouped by persona; check completed items off, drop new items at
the bottom of each section. Priority hints (P0–P3) carried over
from the original triage.

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

## Dr. Patricia Vasquez — solar physicist

- [ ] **P1** Proper attribution string on every printed product
      (FITS-derived → SDO rules-of-the-road only; JPG-derived would
      need Helioviewer credit but JPG-tier prints are now gated)
- [ ] **P1** AIA Lemen 2012 instrument-paper citation surfaced in the
      Raw / JPG tier descriptions
- [ ] **P1** RHEF method-paper citation
      (`Gilly et al. 2025, Sol. Phys. 300, 174`) surfaced in the
      RHEF / HQ RHEF tier descriptions
- [ ] **P1** Fix the "wavelength" vs "filter/bandpass" copy
      conflation — AIA 171 is a ~3 Å EUV bandpass dominated by
      Fe IX, not a monochromatic line. Update tooltips/labels.

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
      attempt now has a 15s `AbortController` timeout. If a single
      attempt times out, attempts++ and retry; if attempts exhaust,
      reject with a network-specific message. Previously a single
      slow request paused the polling loop indefinitely.
- [x] **P1** Midnight-UTC at the international dateline — server-
      side `_validate_solar_date()` now also takes a `time_str` and
      rejects datetimes more than 60s in the future. Tokyo user
      picking today at 00:30 local + noon-UTC default now gets a
      400 with an explanatory message instead of a confused upstream
      failure.
- [x] **P1** Two-tab `localStorage` last-write-wins — *investigated;
      no fix needed.* Only the feedback contact info (name/email)
      lives in `localStorage`. Editor state is in-memory only, so
      two tabs have independent state. Last-wins on contact info is
      the desired behaviour (most recent value wins).
- [ ] **P1** Browser-back during checkout flow returns to a stale
      editor (partial fix earlier; verify it covers the
      variant-cleared path). *(Re-verify in a clean session.)*
- [x] **P2** Products with `variantId === null` — defensive
      null-check in `runMockupQueue` skips the entry with a polite
      mockupStatus error and continues the queue instead of POSTing
      a null variant id to Printify.

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
      match the multi-sentence Quality tier tooltips; single-clause
      action labels (Pan, Rotate 90°, Reset all edits) stay bare.
      Two specific tooltips updated, plus the broader policy is
      noted below in Conventions.
- [x] **P2** Section-title capitalisation policy — sentence case
      everywhere (was Title Case on the three `.section-title`
      headings, sentence case in modal `.confirm-modal-title` etc.).
      Settled on **sentence case** as the modern web convention.
- [x] **P2** "1 R☉" / "1 R_sun" — settled on `R☉` everywhere;
      the one `R_sun` comment in `solar-archive.js` normalised.

## Sam Rosenberg — accessibility consultant

- [x] **P1** Editor tab bar is now a proper ARIA `tablist` with
      arrow/Home/End keyboard nav — `bc4ec06`
- [x] **P0** Icon-only buttons get `aria-label`; decorative `<i>`
      icons get `aria-hidden="true"` — `bc4ec06`
- [x] **P0** `--text-dim` contrast bumped to AA across both modes
      — `bc4ec06`
- [x] **P1** Extended the polite `aria-live` region to mockup-
      generation status (MutationObserver mirrors `#mockupStatus`
      text into `#statusRegion`) and to filter-progress messages
      (`updateFilterStatusLine` writes the message to the live
      region when type is anything but "error" — error path already
      announces via `showToast`).
- [x] **P1** Focus traps in both modals — see Tom's QA section
      (`installModalFocusTrap()` covers both).
- [x] **P2** Accent-color contrast audit — `--accent-corona-text`
      (#a48dff in dark, #6a4eff in light) added as a brightened
      variant of `--accent-corona` for places the purple is used as
      TEXT on a dark background. Original `--accent-corona` keeps
      its decorative roles (borders, focus rings, gradients).
      `.edit-tab.active` text and `.confirm-summary-price` switched.
      Other accent-colour-as-text sites (filter-step loading state,
      etc.) are large/secondary text where 3:1 suffices.
      Disabled-button state on `.btn-buy-in-editor` measures
      ~4.8:1 — already passing AA.

## Jordan Watanabe — startup founder

- [x] **P1** Birthday Sun gifting CTA above the fold — `bc4ec06`
- [ ] **P2** "Two Suns" anniversary diptych product type at the
      ~$120 canvas price point
- [ ] **P2** B2B angle — wholesale-friendly entry for science teachers,
      planetariums, museum gift shops, hospital maternity wards
- [ ] **P3** "Your Year in Solar Weather" Spotify-Wrapped-style
      December drop (free shareable image → paid print upsell)
- [ ] **P3** $19/mo Monthly Sun print club for subscribers
- [ ] **P3** Curated fine-art collection of the 50 most photogenic
      CME days (authority + SEO + press hook)
- [ ] **P3** Referral mechanism ("gift a sun, get a sun")
- [ ] **P2** FAQ + meta tags don't say "birthday gift" anywhere —
      organic-search loss; needs SEO copy refresh

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
