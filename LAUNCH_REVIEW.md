# My Heliograph — Pre-Launch Release Report

*Prepared by the release manager, synthesizing 7 verified red-team reviews (UX/UI, Accessibility, CRO, Launch-blockers, Market/Positioning, Feature-upgrades, Technical/Security).*

> **Scope caveat — read first.** Every finding below is **source-code + live-HTTP based**. Two things are still owed before any spend goes live and are baked into the gate at the bottom: (1) a **real-device visual QA pass** (mobile + desktop, light + dark) in an actual browser, and (2) **one real end-to-end test purchase** (card charged → Printify order created → confirmation received). No review here has driven the checkout to a completed order.

---

## 1. Verdict

**Not yet — do not point paid traffic at it today, but it's close.** The product itself is strong and differentiated (real NASA data + the RHEF filter is a genuine moat), the money path *exists*, and a lot of prior a11y/SEO/cold-start work is real and holds up under scrutiny. But three classes of problem stand between "live" and "advertise": (a) a **committed live vendor API key in a public repo** plus **several unauthenticated expensive/destructive backend endpoints** that a crawler or attacker can use to get your NASA/VSO fetch IP block-listed — which breaks the core product *for everyone*; (b) a **checkout that reads like an internal Shopify/Printify publishing tool** — a 4-step "Create product" progress list, a up-to-5-minute spinner, and a second click into a new tab — sitting right at the highest-intent moment, with the **Buy button hard-disabled** until the user finds and clicks a non-obvious "Generate real mockup"; and (c) **self-contradicting legal/telemetry disclosures** (the cookie banner affirmatively claims Google Analytics tracking that isn't even loaded). Fix the security items and the checkout framing, reconcile the legal copy, run one real test purchase, and you can start a **soft launch**. Full-send waits on a handful of fulfilled orders and stable conversion telemetry.

---

## 2. BLOCKERS — must fix before advertising

Ranked by "loses money / breaks the money path / legal-trust / embarrasses."

| # | Blocker | One-line fix | Sev | Effort | Evidence |
|---|---------|--------------|-----|--------|----------|
| **B1** | **Live `PRINTFUL_API_KEY` committed in a tracked `.env` in the *public* GitHub repo** (in 4 historical commits, so deletion ≠ purge). | Rotate the token at Printful **now**; `git rm --cached .env`, gitignore it, purge history (BFG/filter-repo), force-push; confirm secrets live only in Fly. | blocker | S | `git show HEAD:.env`; `.env` not in `.gitignore`; remote is public `sunback_webapp` |
| **B2** | **Checkout is a "Create *product* on Shopify" publish flow** — 4-step progress list (Uploading / Creating / Publishing / Waiting), 5-min (`300000ms`) fetch timeout, "Leave site?" beforeunload guard, then a **second** click opening Shopify in a **new tab**. Reads as broken/technical at peak intent. | Reframe as a normal purchase: CTA "Buy now"; do the Printify-create + 4K render server-side, hand back a Shopify checkout URL; pre-warm the print render at editor-open; replace the 4-step list with "Taking you to secure checkout…" and drop the second click. | blocker | L | `solar-archive.js:11485-11670` (11508-13, 11551-66, 11620, 11524-29, 11656-57) |
| **B3** | **Buy button is hard-disabled on the *real* (personalized) path** until the user manually clicks "Generate real mockup" — the moment they change the date/wavelength, `isDefaultActive` flips false and the gate re-engages with hint "Click Generate real mockup first to unlock checkout." | Remove the hard-disabled state; either make the mockup a soft nudge and render server-side at checkout, or lazily generate one mockup in the background once per personalized session (don't auto-fire on every editor-open — each call is real wholesale $). | high→blocker | M | `solar-archive.js:10578-10600, 10705-10760, 2136-41, 2255` |
| **B4** | **Path traversal / arbitrary-file read on the catch-all `/asset/{subpath:path}`** — no containment check; `/asset/..%2f..%2f…` can read arbitrary files incl. the persistent disk's **`feedback.jsonl` (user PII)**. (The other two asset routes are already guarded — this one only.) | Add realpath-containment (`rp.startswith(OUTPUT_DIR+os.sep)` else 404) + reject `..` up front, mirroring the guard `/asset/preview/` already has. Verify against live Fly deploy. | high | S | `main.py:4252-4258` (unguarded) vs `4236-41` (guarded) |
| **B5** | **Unauthenticated destructive / expensive backend endpoints** → NASA/VSO IP block-listing risk (breaks the product for *all* users) + info disclosure. `/api/clear_cache`, `/api/generate` + `/api/generate_preview`, `/logs/stream` (SSE log tail), `/api/clear_preview_failed` all have no origin/rate/admin gate — while the *cheap* Helioviewer proxy is throttled (protection is backwards). | Gate each behind `_check_warm_admin_key` and/or `enforce_origin` + `enforce_rate_limit` (the admin/debug routes already do). Add a per-IP render budget on `/generate`. | high | S–M | `main.py:2912` (clear_cache), `1827`/`1392` (generate), `2879` (logs/stream), `1378` (clear_preview_failed); gated counterexamples at `912-13, 3033, 3114` |
| **B6** | **Self-contradicting telemetry disclosure across 3 canonical sources.** Privacy says "no third-party analytics"; Terms lists "GA4 + Sentry"; the **cookie banner affirmatively tells users the site uses Google Analytics 4** — but GA/Sentry are unconfigured and never load. The banner making a *false* tracking claim is the worst. | Pick launch reality. Shipping without GA/Sentry (current): strike GA4+Sentry from Terms, drop the GA4 line from the banner (and reconsider showing the banner at all). If enabling them, populate env IDs and update Privacy. Don't launch with all three disagreeing. | high | S | `privacy.html:35`, `terms.html:71`, `index.html:1089`, `solar-archive.js:3-4,83` |

> **Why B4/B5 are advertising-blockers, not just "later":** paid traffic *is* the trigger. Ad clicks + one bored crawler scripting unique dates against an open `/generate`, or hammering `/clear_cache`, is exactly the pattern the code warns "gets our IP block-listed at NASA" — at which point nobody's Sun renders. And B4 can leak the PII you've collected in `feedback.jsonl`.

---

## 3. High-ROI pre-launch fixes (do first, not strictly blockers)

Ranked by impact ÷ effort.

1. **Add trust signals at the CTA** — one satisfaction/returns-guarantee line + a "Secure checkout via Shopify" lock badge + "Printed & shipped by Printify." Currently *zero* trust markers anywhere; footer is legal-links-only. **[high, S]** (`index.html:1059-1077`)
2. **Fix the "Pick your canvas" heading** → "Pick your product" — the grid is mostly mugs/shirts/socks/clocks/phone cases, and the label narrows perceived selection. **[low, S — trivial win]** (`index.html:125`)
3. **Correct the quality-strip alt text + caption** — they describe a 4-panel/"stacked HQ 4K" tier the deployed 3-panel image no longer shows; screen-reader users are told about a panel that isn't there. **[low, S]** (`index.html:118-119`)
4. **Swap the 13 MB PNG OG/share image** for an optimized ≤1 MB 1200×630 JPEG/WebP — Twitter/X rejects >5 MB so share cards silently show no image (kills the gift-product viral loop) and it compounds the known bandwidth bill. **[medium, S]** (`index.html:21`)
5. **Fix `ALLOWED_ORIGINS` stale defaults** — hard-coded defaults still list `solar-archive.onrender.com`/`myshopify.com` and **omit `myheliograph.com`**; if the env var is ever unset, real storefront requests get 403'd (breaks mockups/checkout). Log the effective allowlist at startup. **[medium, S]** (`security.py:41-46`, `main.py:643-655`)
6. **Reconcile legal host** Render → the real host (code says Fly; memory says Render service exists — *confirm ops truth first*), fix the "US-East" region, bump "Last updated." Add `/accessibility` to `sitemap.xml`; align the refund vs shipping "lost in transit" windows. **[medium/low, S]** (`privacy.html:54`, `terms.html:71`, `sitemap.xml`, `refund.html:34` vs `shipping.html:78`)
7. **Accessibility — legal/ADA exposure + core-editor usability** (bundle): (a) give the 20 editor sliders/selects/color-pickers accessible names (`for`/`aria-label`) — the core surface is unusable non-visually; (b) make the quality timeline keyboard-operable (radios are `tabindex=-1`, click-only handler); (c) **add light-mode overrides for accent-as-text colors** — the *Shopify-required* footer legal links use `--accent-cool` at ~1.8:1 in the default light theme (fails AA + distinguished by color alone); (d) define the missing `.sr-only` class so the assertive alert region doesn't render visibly; (e) fix the invalid `*::before:not()` selector that voids the reduced-motion reset. **[high, M]** (`index.html:728-751`; `solar-archive.js:3421-37`; `solar-archive.css:52-71,3099,102-110,1304`)
8. **Re-render the default sample mockups** from a vivid red-orange RHEF frame that matches the hero quality strip — every default mockup is a muted bronze/sepia sun that clashes with the "wow" strip directly above and undercuts "the filter is what you're buying"; also reconcile the "orange Sun is a sample" copy. **[medium, M]** (live `/asset/default/mockups/*.thumb.webp` vs `/asset/default/quality_strip.webp`; `index.html:129`)
9. **Surface an "arrives by ~<date>" delivery estimate** on the product card + confirm modal — the #1 anxiety for a *dated gift* and it's never shown anywhere. **[high, M]** (`solar-archive.js` — no arrives-by logic)
10. **Un-invert the funnel** — the hero *promises* a date picker (`index.html:55`) but it's `display:none` behind a mandatory product pick (`css:2346-51`). Surface a compact "Your day" date field in the hero so the emotional, differentiating action is one tap from arrival. **[high, L — real IA work; can also be an A/B test post-launch]**

---

## 4. Then: growth

### Top unmined audiences (ranked)
1. **Astrology "solar return"** — a birthday *is* the Sun returning to its natal position; a real photo of the Sun on your birthday is the most literal artifact this viral, low-price-sensitivity audience could own, and **no star-map incumbent can credibly claim it.** Currently zero astrology copy. **[high, M]**
2. **Memorial / remembrance** — premium, highest emotional intent, lowest price sensitivity. The Sun (warmth/life/presence) carries it more viscerally than stars. Needs its own sensitive tone + a two-date "life in sunlight" diptych. **[high, M]**
3. **New-baby / nursery** — "the Sun that shone the day you were born"; top-converting star-map segment, natural canvas/poster fit, grandparent + baby-shower gifters are high-AOV. **[medium, M]**
4. **Anniversary / couples** — merchandise the **two-date diptych** ("the day we met" + "the day we married"), the category's biggest revenue driver. **[medium, M]**
5. **Educators / space enthusiasts** — the real SDO+RHEF depth ("Gilly et al. 2025") is a credibility moat with r/space, planetarium/museum shops; cheap high-intent traffic that avoids star-map ad-keyword competition. **[low, S]**
6. **Corporate / milestone / retirement (B2B)** — uncontested high-AOV lane ("the Sun on the day we launched" on metal/acrylic). **[idea, L]**

### Highest-value feature upgrades
- **Digital-download SKU (~100% margin, instant delivery)** — the 4K composite already renders and a local PNG export path exists (BETA-gated). Add a $7–12 "print-your-own" product for impulse/last-minute gifting. **[high, M]**
- **Share-to-social** — *no* share/clipboard code exists anywhere; every creation is a dead end. `navigator.share`+`canvas.toBlob` on mobile, copy-link/download fallback on desktop, pre-filled caption. Turns each session into free acquisition. **[high, M]**
- **Gift UX** — gift message / recipient / gift receipt. "Gift" is asserted in copy but unsupported in flow; every occasion audience above depends on it. **[high, S–M]**
- **Occasion landing pages, *pre-rendered*** — the site is a client-rendered SPA, so crawlers see only the shell and it ranks for *nothing* occasion-specific. The whole competitor category (The Night Sky, Positive Prints) acquires through per-occasion pages. Requires static-snapshot prerender to be indexable at all. **[L]**
- **Unlock pre-2010 dates** — anyone born/married before 2010-05-15 can't use the core product; the SOHO-EIT backend is *already largely built* (`main.py:3166,3183-85,3398-3409`) — it's mostly a frontend cap + QA unlock. **[M]**
- **"This day in solar history"** — turn the already-fetched HEK event into a one-line story under the picked date; pure copy from data you already have, raises perceived value at the decision moment. **[S]**

### 🎯 Single best next bet
**A pre-rendered "your birthday, your solar return" occasion landing page.** It simultaneously fixes the biggest growth blocker (an SPA that's invisible to search/ads-quality-score) *and* stakes the one audience wedge a Sun product owns more literally than any star-map competitor — for cheap, mostly-copy effort plus a static snapshot. It's the page you point your first ad dollars at.

---

## 5. THE ADVERTISE-READINESS GATE

**The literal answer to "how will I know when I should start driving traffic?"** — every box below must be checkable-true. Split into "gate to spend a dollar" (hard) and "gate to full-send" (scale).

### 🔴 Hard gate — ALL must be true before *any* paid/seeded traffic

**Status as of 2026-07-15 (this session's pass):**

- [~] **B1 half-done:** Printful token **revoked at the vendor 2026-07-15** (operator action, confirmed). Git-history purge (the leaked value still sits in 5 old commits / 12 branches in the public repo) is prepped but paused — deliberately deferred, low urgency now that the key itself is dead. See MIGRATION.md Stage 5.
- [x] **B4 + B5 done:** verified live on `myheliograph.com` this session — `/asset/..%2f..%2f..%2fetc%2fpasswd` → 400, `/asset/../main.py` → 404; `clear_cache` → 401, `logs/stream` → 401, `generate` → 403 (origin-gated), `generate_preview` → 403 (origin-gated) when called without the frontend Origin header.
- [ ] **One real end-to-end test purchase completed** — real card charged, Printify order created, Shopify confirmation received. *(Still owed — operator-only, needs a real card/store action.)*
- [x] **B3 done:** Buy button is no longer hard-disabled on the personalized path (commit `cd4d70d`) — the mockup is now a soft nudge, not a checkout gate.
- [x] **B2 acceptable:** checkout reframed in customer language — CTA "Buy now", confirm modal "Buy \<product\>", 4-step list now reads "Preparing your print file… / Setting up your product / Connecting to secure checkout / Getting your checkout link" (commit `cd4d70d`). Mechanics (idempotency latch, beforeunload guard, timeouts) unchanged.
- [x] **B6 done:** cookie banner copy corrected from an affirmative "we use GA4" claim to a consent-conditional "may use, with your consent" (commit `cd4d70d`), matching Privacy's "we do not currently use" language and the code's actual consent-gated `_initGA4()`/`_initSentry()` flow. Legal host (Fly.io + Cloudflare) already correct in `privacy.html`.
- [~] **Analytics half-installed:** GA4 is live (`G-YQGH255Z02`, dedicated "My Heliograph" property, verified firing via the deployed index.html). Sentry DSN still empty — no Sentry account exists under the operator's Google login (Sign-in-with-Google returned "New Identity, could not find a Sentry account"). *(Operator-only: create a Sentry account — 30 seconds — then the DSN can be wired in the same way GA4 was.)*
- [x] **Visual QA** — this session's pass: desktop (1280px) + mobile (375px) viewports, light + dark `prefers-color-scheme`, live site + local build, via the in-app browser. Console clean, no layout breaks found. *(Not a physical-device pass — recommend one manual phone check before spend, but no blocking issues surfaced.)*
- [x] **OG share preview** — `og:image` is a 187 KB JPEG at the correct 1200×630, served with `cf-cache-status: HIT` (verified live this session; well under Twitter/X's 5 MB cap).
- [x] Trust line + returns/guarantee visible near the CTA (fix #1, already live); "arrives by" estimate now shown in the trust bar and the buy confirm modal (fix #9, commit `cd4d70d`).

Also landed this session (a11y bundle, fix #7): `.sr-only` class defined (the assertive alert region no longer paints visibly), the reduced-motion selector fixed (`::before:not()` had voided the whole rule), a light-mode `--accent-cool` override (footer links were ~2:1 contrast on light, now ~5.9:1), the quality-timeline radios are keyboard-operable, and all 20 editor sliders + their row selects/color-pickers have accessible names. Fix #2 ("Pick your canvas" → "Pick your product") also shipped.

Also fixed: the editor's preview pane was floating fixed on top of the quality timeline and Buy button at 741–1099px widths (a JS pinning threshold that didn't match the actual layout breakpoint), and the feedback FAB pills covered the Buy button in the same width range plus mobile — both reported live by the operator with a screenshot, reproduced and fixed by measuring real element geometry against myheliograph.com before/after.

**DEPLOYED 2026-07-15.** [PR #9](https://github.com/GillySpace27/sunback_webapp/pull/9) merged to `main`; `fly deploy` shipped the backend, `cd infra/worker && ./build-public.sh && npx wrangler deploy` shipped the frontend (index.html/js/css are served from Cloudflare Workers Static Assets, a separate deploy step from the Fly API — easy to miss). All of B2/B3/B6/#7/#9/layout-overlap/GA4 verified live on myheliograph.com post-deploy (heading, buy-button copy, GA measurement ID, copyright year, arrives-by estimate, `.sr-only` CSS all confirmed via cache-busted curl).

GA4: new dedicated property "My Heliograph" created (separate from the pre-existing "Personal Website - GA4" property so storefront conversion data isn't mixed with gilly.space traffic), measurement ID `G-YQGH255Z02` is live. Sentry DSN still empty — no Sentry account exists yet under the operator's Google login; needs the operator to create one (or point at an existing account under a different email).

### 🟡 Soft-launch first (STRONGLY recommended) — trickle, then watch
Once the hard gate is green, **do not full-send.** Drive a **trickle** — ~$20–50/day of tightly-targeted ads, or friends/family + one enthusiast community (r/space) — and watch these for ~1–2 weeks:
- **Checkout completion rate** and **median time-on-checkout** (is the multi-minute render killing conversion?).
- **Backend error rate / NASA-fetch success rate**; does the "waking up" banner behave under real cold starts?
- **First real orders fulfilled correctly** by Printify (print quality, color — the bronze-vs-red concern, arrival time).
- **Refund / complaint / support volume.**
- **Share-link and OG-preview behavior** in the wild.

### 🟢 Full-send gate — ALL true after soft launch
- [ ] **≥ 5–10 real orders fulfilled** with acceptable print quality and delivery time, zero payment-path failures.
- [ ] Checkout completion rate stable and not obviously depressed by the render wait.
- [ ] Refund/complaint rate within tolerance; no recurring quality issue.
- [ ] Backend stable under trickle load — no NASA/VSO throttling, cold-start banner working, no 5xx spikes.
- [ ] Conversion telemetry trustworthy enough to compute a CAC and not burn budget blind.

Only when every 🟢 box is checked do you open the spend.

---

*Report basis: static source + live-HTTP review of 7 red-team passes. A real-device browser visual pass and a completed test purchase remain outstanding and are gated above.*

🕐 05:11 MDT, Sat 2026-07-11