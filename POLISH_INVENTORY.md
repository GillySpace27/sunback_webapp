# Polish inventory: the ranked accidents list

Assembled 2026-08-15 late night from five parallel audits of the LIVE site
(store visual crawl in both themes at 3 viewports; experience static-state
audit; a code sweep of every in-between state in both apps; a design-token
diff between the two apps; a trust-furniture audit). The bar this list serves:
**a cold stranger, on a phone, completes date to product to cart without one
moment of "huh?", and no screen ever looks accidental.**

Method caveat: the audit harness suspends requestAnimationFrame, so motion,
scroll-driven scenes, and paint timing were NOT judged; everything below is a
static, measured, or code-verified finding. Contrast ratios are WCAG-computed
from live computed styles. file:line references are current as of main
db26530 (plus tonight's later commits).

## The diagnosis in three sentences

1. **The worst states are not missing copy; they are authored copy that
   cannot be reached.** The store's whole preview-failure channel (four error
   messages and a Retry button) renders into a `display:none !important`
   node; the 3D site's "no image for this date" error is sealed inside a
   collapsed drawer while the hero silently substitutes a procedural fake Sun.
2. **Everything a beta tester ever hit is impeccably authored; everything no
   tester ever hit speaks engineer** (`ALLOWED_ORIGINS`, `main.py`, "check
   the hosting dashboard's logs", raw API_BASE, all visible to shoppers).
3. **The two apps share the same fonts, accents, and even the same handoff
   button, but every token is redeclared 2 to 8 percent off**, which is why
   the site reads as "two websites taped together" without anyone being able
   to name the seam.

---

## TIER 1: fix first (customer-visible, conversion path, or dishonest)

| # | Accident | Where | Fix |
|---|---|---|---|
| 1 | 404 is raw FastAPI JSON `{"detail":"Not Found"}` | any bad URL | catch-all branded 404 page in main.py (non-/api/ paths) |
| 2 | **"Add to cart" is white on gold at 1.61:1** (both themes); same style on Send feedback / Request product / floating pills; Choose-variant fails at gradient's gold end | variant modal, feedback modal | swap labels to the near-black ink token (the site's own convention: dark ink on gold) |
| 3 | **Light-mode dark-surface leak family** (same root cause as the bridge bug fixed tonight): sun-chip meta navy-on-dark 1.15:1 (invisible) and the chip covers "Choose your product" at 390px; feedback active tab white-on-white (inactive tab looks selected); Original/Filtered toggle label 1.4:1; secondary buttons with invisible white-alpha borders on white; latent Continue btn 1.44:1 | store, light mode | pin light ink on dark-pinned surfaces; opaque border token on light panels |
| 4 | **Preview-failure channel is invisible**: `#statusMsg` is `display:none !important` (index.html:710) so error copy + Retry (solar-archive.js:2392-2455,6467) show to nobody; `.image-stage` never re-enters its authored `.empty` state after failure (js:2394) | store | route errors through showToast(msg,"error"); render Retry in #imageStage; add `.empty` on failure |
| 5 | **The 3D hero silently shows a fabricated Sun** when the date's texture errors: the authored "no image for this date" line is sealed inside the collapsed drawer (WavelengthPicker.tsx:36,70; styles.css:387) while Sun.tsx:106 falls back to the procedural shader; hero load also has no timeout (useSunTextureLoader.ts:79) | experience | auto-open the drawer on texStatus==="error" or hoist the line beside the chip; add ~20s load deadline |
| 6 | **Operator-voice error banners shown to shoppers**: raw API_BASE printed 3x; "CORS blocked... ALLOWED_ORIGINS... main.py"; "deploy failed or crashed... check the hosting dashboard's logs"; "may have run out of memory"; retry counters "(attempt 3/4)" | solar-archive.js:6696-6957 | one customer sentence + Retry per state; operator detail to console only. (The adjacent CSP banner was already softened; these were missed.) |
| 7 | Checkout error injects the raw backend response body as **unescaped HTML** (an XSS sink and a stack-trace display) | solar-archive.js:13087,13161 | escape + truncate + map to authored messages |
| 8 | Handoff compare cards framed differently: Original (HV thumb, wide margins) vs Enhanced (tight crop) under the copy "The same observation" | bridge overlay, mobile worst | object-fit:contain both, or match the preview framing |
| 9 | Experience legal links sit in the iPhone home-indicator zone: `.data-credit` is the one fixed element missing `env(safe-area-inset-bottom)`; its text also fails AA (3.68:1 effective) | web3d styles.css | add the safe-area inset; raise opacity .55 to .75 |
| 10 | Error toasts render green: showToast defaults to "success" (js:6240), 6 untyped error call sites; `.toast.info` has no CSS rule at all | store | default "info"; type the 6 sites; add the .info rule |
| 11 | Invisible variant swatches: white-alpha borders vanish on light panels (White Base/White = empty gaps in the row); black fills on dark survive only via the selection ring | variant modal | opaque theme border token on swatches |
| 12 | "See this wavelength" CTA at 3.23:1 in light mode (light theme's gold TEXT token used as a background) | store light | use the light-gold fill token |
| 13 | Toast vs cookie banner collision on cold load, and the load toast leads with jargon ("193 Å loaded!") before the user does anything | store | raise toast above open banner; drop the page-load toast |
| 14 | Internal QA leakage: 35 green "Printify mockup ready" dots (all identical, inline-styled), variant-count tooltips, `Built: 08/15/2026, 20:09 MDT` footer stamp in dev mono | product grid, footer | remove dot when ready; humanize tooltips; drop or de-jargon the stamp |
| 15 | Wavelength cards: 7.83px angstrom microtype at 0.6 opacity, and TWO cards both titled "UV" (1600 vs 1700) distinguishable only by that microtype | store wl grid | bump to >=11px full opacity; retitle the UV pair |
| 16 | `window.confirm` on Start Over and `window.prompt` on Share, contradicting the codebase's own "no alert/confirm/prompt" comment (js:6288) | js:1910,5825 | use the existing showModal |
| 17 | "Developing…" pill has no terminal state: poll gives up at ~18s and the pill pulses forever over a dimmed, unpickable-looking card | js:5566 | on exhaustion: "Enhanced isn't ready; Original is ready now" + drop .is-pending |
| 18 | **Silent wrong data**: hour scrubber leaves the previous hour's Sun on failure (js:4277); a failed wheel wedge renders as a legitimate flat-color wavelength swatch (useWheelTextures.ts:78) | both apps | clear + "No frame at this hour"; mark/hide failed wedges |
| 19 | The authored WebGL-failure screen is unreachable from the likeliest 3D failure (context loss has no listener; ErrorBoundary only catches render-phase throws) | Scene.tsx:56-95 | webglcontextlost listener flips the same store flag |
| 20 | Asymmetric transitions on the two emotional peaks: bridge rises in 0.6s and exits on a hard cut (js:5650); the 3D loader hard-cuts to canvas (App.tsx:88) on a film whose AtmosphereFlash exists to hide seams | both | .is-leaving reverse keyframe; 400ms loader fade |
| 21 | Invisible collapsed picker chip is keyboard-reachable at the hero and opening it collides with hero UI (measured garble at 1280 and 320; masthead never hidden); chip hit target is 21px tall | web3d | visibility:hidden/inert while GSAP-hidden; promote the :has() hide rules out of the mobile media query; move padding onto the button |

## TIER 2: high yield, lower blast radius

- Out-of-range date is silently discarded while the field keeps showing it; the only hint says "Pick a date to continue" (they did). Return a reason: "Our archive reaches {maxDate}; SDO data takes about a week to arrive." (DateField.tsx:38, store.ts:141)
- Frontier clamp can move a chosen date under the visitor with no notice (store.ts:148); add a one-line note when it fires.
- "Preparing your Sun…" is a fixed 700ms of theatre; race it against the real /api/health response. (BuyLink.tsx:46)
- Feedback picker: native selects speaking engineer ("(no variants returned)"); move loading to the label, rewrite parentheticals. (feedback.js:463-524)
- Wheel has no loading state (nine wedges pop in network order); hold visible until complete or fade each in.
- Rate-limit latch never resets: one 429 kills hour previews for the whole session. (js:4292)
- Vibe-card 12s backstop un-dims with no explanation; add the error toast. (js:5286)
- Zip bundle build has zero in-flight UI in the no-mockup branch. (bundler.js:293)
- "MQ/HQ/FITS" register in purchase copy; replace with good/sharpest/telescope file. (js:12051-12074)
- "Your text here..." placeholder on the text tool (index.html:1156) on a site where every other placeholder is written.
- Mobile nicks: FAB pair covers Metal Art Sign price at 390; category chip row ends flush (no peek/fade); "▾" chevron renders 6.5px via font fallback; step-1 H2 orphans "2010" over five ragged lines.
- Placeholder glow at 72% while the Sun renders at ~35-45%; move to ~45% 50%. (web3d/index.html)
- apple-touch-icon is SVG (iOS ignores it) and /favicon.ico serves SVG bytes; generate 180px + 32px PNGs and a real .ico.
- Sitemap missing /accessibility and /experience/.
- No contact route on the homepage (support@ exists only inside legal pages); one footer mailto.
- support@ deliverability untested; no DMARC record. One round-trip test + p=none DMARC.
- Cloudflare Insights beacon loads pre-consent while /privacy says nothing loads; either disable auto-injection or amend one sentence (privacy.html:35).
- Checkout hands off to solar-archive.myshopify.com at the exact trust-check moment; connect a myheliograph.com subdomain, or name the destination in the confirm copy meanwhile.
- "through August 8" missing its year in the availability line; /experience/ footer omits the Shipping link.
- Fonts "preloaded but not used" warning on every load (missing crossorigin on the preload links); CSS fetched 3x per navigation (Vite chunk re-injection).
- Verify in a real browser: `.flow-inner` 888px reserved margin with no element inside it (possible blank band; rAF suspension prevented adjudication).

## TIER 3: the unification passes (one sitting each)

**A. Shared tokens** (full details in the token audit): one 22-token
`shared/tokens.css` both apps import. Chosen for minimum churn: blacks ramp +
radii + accent from the store's declared tokens; ink pair + easing + focus
ring from web3d. The single deliberate visual shift: the 3D void goes
`#05060a` to warm `#0a0908` so the floor no longer changes hue at the seam.
Top substitutions, ranked: web3d --bg (+theme-color +first-paint gradient);
the four `#0a0a0f` text colors; **one .btn-primary replacing .cta--bar and
.handoff-continue** (currently the same button drifted on six axes); store
ink tokens to web3d values; retire Material's `cubic-bezier(0.4,0,0.2,1)`
default (27 call sites, one line); one global dual-tone focus ring (deletes 9
web3d copies + 12 store overrides); **the last live purple** in .btn-order's
gradient (css:2353); **skip-link white-on-gold 1.6:1 WCAG failure**
(css:216, caused by the July palette migration re-meaning --accent-corona);
collapse four competing golds (#ffb347 x33) into the accent ramp; tokenize
the masthead's hardcoded accents; radius tokens (fix three self-contradicting
fallbacks); two border-alpha tokens replacing ten ad-hoc alphas.

**B. Type discipline**: collapse the store's ten sizes inside 0.74-0.88rem to
three; convert six raw px sizes to rem; decide the serif personality (web3d
runs Fraunces at weight 380/340, the store at 700/800; same typeface, two
personalities; adopting the light editorial weight store-side is the largest
single perceptual change available and is a design decision, not a cleanup).

**C. Copy register pass** (with the style guide open): Filtered vs Enhanced
for the same thing; "AIA 30.4 nm" vs "AIA 304 Å" on the same overlay; four
date formats; colour/color in one modal; "Choose your product" vs "Pick your
product"; legal pages never use the brand serif and have no shared footer.

**D. Shadows/motion**: 48 distinct store shadows to a 3-step neutral
elevation set; retire the 17 accent-colored glows (web3d has zero, and the
mismatch reads as two render engines); drop the sub-perceptual 1-3px
backdrop-blur tier (11 uses, pure compositing cost); `transition: all` x17 to
named properties.

## Already polished: do not touch

Dark-theme store end-to-end (hero, cards, modals all pass comfortably); the
cookie banner (copy, hierarchy, decline-first, both themes); the examples
gallery pattern; wavelength color strips + selection rings; product-card
anatomy + hover states + price anchors; the bridge's desktop art direction
(eyebrow / serif date / two cards / provenance); trust-bar shipping claims
synced to /shipping (with a comment documenting the sync); legal content
substance; the HQ queue chip with elapsed/estimate (best loading state in
either app); HEK skeletons + honest fallback copy; checkout step list with
real substates; the beta gate's fail-secure design; web3d's loader-as-Act-One,
baked-Sun first paint, procedural-to-photo crossfade, branded WebGL fallback,
frontier gate, inert-CTA-with-reason, complete SEO/unfurl surface, zero
console errors; and tonight's additions (648-mockup grid, honest bridge copy,
one-committed-date, bare-landing rule).

## Suggested order

1. **Session A (about a half day): Tier 1.** Almost all are one-file CSS/copy
   changes or one-line wirings; items 1-6 alone would change how the site
   reads to a stranger more than anything else available.
2. **Session B: the two-funnel divergence** (architecture doc first). Absorbs
   the remaining bridge polish; ends the film at conversion in the gallery.
3. **Session C: Tier 3A+3B tokens/type** (mechanical, ships as one commit).
4. **Session D: the copy pass, then five real strangers on their own phones,
   recorded.** That test, not this list, is the pride criterion.
