# Checkout Decouple: Implementation Plan

Goal: a buyer reaches Shopify checkout within ~5 seconds of clicking "Continue to
checkout", while the print still ships at full science-image quality. Today the
`_gatePrintQuality()` block (`api/solar-archive.js:11673`) holds checkout until at
least medium-res FITS is available, so a buyer whose render is queued gets
"Waiting for Science Image" and never hands off. We remove that block and move
the quality guarantee to a server-side regenerate-before-production step.

The whole plan hinges on one Printify fact: an order's `line_items` reference only
`product_id` + `variant_id` + `quantity`; the print files live on the PRODUCT's
`print_areas`. So swapping the product's image before the order is sent to
production changes what prints, and Printify's manual order-approval hold gives us
the window. Phase 0 proves that on real infrastructure before we build anything.

---

## Phase 0 — Validate the mechanism (do this first, ~1 hour, no code shipped)

1. In the Printify dashboard set order approval to MANUAL
   (Settings -> Orders -> order approval). This makes API/synced orders land
   "On hold: Submit order" instead of auto-producing. It is the safety interlock
   the whole design depends on, and it is reversible.

2. Run the probe (creates a throwaway product + one ON-HOLD order, swaps the
   image, dumps JSON, cancels + deletes; never sends to production, never
   charges):

   ```bash
   PRINTIFY_API_KEY=... PRINTIFY_SHOP_ID=... \
   python3 api/scripts/printify_swap_probe.py --confirm-manual-approval
   ```

   Read the two "ORDER JSON" dumps. If the order's preview / print references
   move from image A (red) to image B (blue) after the product PUT, print files
   resolve live from the product and the decouple is safe. If the order still
   pins image A, go to step 3 before committing to the design.

3. Final gate — one real held order (only if you want production-proof certainty,
   or if step 2 was inconclusive). Place a genuine $3 greeting-card order through
   the live store, confirm it lands On hold, swap the product image via the API,
   then either (a) approve it and inspect the production proof to confirm the
   swap, or (b) cancel it. This is the only step that costs money, and only if
   you choose (a).

Decision point: proceed to Phase 1 only if the swap is confirmed. If Printify
snapshots at order-creation (unexpected), fall back to the "priority-render"
mitigation instead (jump the checkout item's MQ render to the front of the queue
and keep the quality floor).

---

## Phase 1 — Persist the full editor state with the order

The server must be able to recompose the exact print file later, so it needs the
whole editor state, not just date+wavelength: date, time (UTC), wavelength,
crop/pan/zoom transform, any text overlay + position, product id, variant id,
and the RHEF tier. The client already holds all of this in `state`.

Recommended: server-side keyed record (smaller change than reworking checkout to
carry Shopify line-item properties).

- At checkout, after the per-order Printify product is created, POST the editor
  state to a new endpoint `POST /api/order-intent` keyed by the Printify
  `product_id` (and the Shopify variant). Store it in the existing data dir /
  a small table. This record is the recompose recipe.
- When the paid order arrives (Phase 3), look the recipe up by the ordered
  product id.

Alternative (more robust, more work): switch the one-tap cart-permalink to a
Storefront `cartLinesAdd` mutation so we can attach the state as line-item
attributes that ride with the Shopify order natively. Defer unless Phase 3's
lookup proves fragile.

Acceptance: given a `product_id`, the server can reconstruct the identical print
composition it would have produced client-side.

---

## Phase 2 — Relax the checkout gate (frontend)

- In `_gatePrintQuality()`, stop hard-blocking on `jpg_only`. Instead: compose the
  best-available preview, proceed to product-create + publish + cart URL, and show
  the report's reassurance copy:
  > Your preview is ready now. We are preparing the full-resolution telescope
  > image for print.
- Keep the existing per-variant price integrity and the upload-by-URL path.
- The `mq_ready` soft-confirm can go away; quality is now guaranteed server-side.
- Gate behind a feature flag (`CHECKOUT_DECOUPLE`) read from `/store-config`, so we
  can dark-launch and roll back instantly.

Acceptance: click to Shopify in <5s regardless of render-queue depth.

---

## Phase 3 — Server-side regenerate-before-production

Trigger: a Shopify `orders/paid` webhook (preferred) to a new
`POST /api/shopify/order-paid` endpoint. If we would rather not run webhook infra
on Fly, a 60s poll of new paid orders works as a fallback.

Job steps (idempotent, keyed by Shopify order id):
1. Map the ordered line item to its Printify `product_id`, load the Phase 1
   recipe.
2. Regenerate the HQ 4096 print file from the recipe. This reuses the existing
   server-side compositor `api/print_compose.py` (already used for the >20 MB
   URL-upload path at `printify_routes.py:1287`) and the HQ RHEF pipeline.
3. Upload the HQ file to Printify (`POST /uploads/images.json`, by URL for large
   files, exactly as checkout does today).
4. `PUT /shops/{shop}/products/{product_id}.json` with `print_areas` pointing at
   the new image id.
5. `POST /shops/{shop}/orders/{order_id}/send_to_production.json`.
6. Record success on the order record.

Failure path (non-negotiable): if any of 2 to 4 fail, do NOT send to production.
Leave the order On hold, mark the record `needs_recovery`, and alert the operator
(email or Slack) with the order id + a one-click "retry regeneration" link. A
buyer never receives a low-res print; a human clears the exception.

Guardrails:
- A production-hold check: never call `send_to_production` unless the product's
  current `print_areas` image id equals the freshly uploaded HQ id (prevents
  racing a stale image into production).
- A dead-man timer: any order still On hold after N hours with no successful
  regen pages the operator.

Acceptance: every fulfilled order used the HQ production render; zero orders
auto-fulfilled on a preview; failures surface to the operator, never to print.

---

## Phase 4 — Rollout

1. Ship Phases 1 to 3 behind `CHECKOUT_DECOUPLE=false`. Manual order approval
   stays ON the whole time (it is the interlock).
2. Canary: flip the flag for a single test purchase you make yourself, watch the
   full path (fast checkout -> webhook -> regen -> product PUT ->
   send_to_production -> proof).
3. Enable for real traffic. Monitor the report's metrics: time-from-checkout-click
   to Shopify, regen success rate, regen duration, orders-on-hold age.
4. Rollback: set the flag false (checkout re-gates on quality, the safe old
   behavior) and, if needed, keep manual approval so nothing auto-produces while
   you investigate.

---

## Risks and mitigations

- Printify snapshots print files at order creation (the Phase 0 risk). Mitigation:
  Phase 0 proves it before we build; fallback is priority-render.
- Regen never completes (backend down, archive gap). Mitigation: failure path +
  dead-man timer; order sits On hold, operator alerted, buyer already has their
  receipt and preview.
- Recompose does not match the client preview exactly (crop/text drift).
  Mitigation: the recipe captures the full transform; add a pixel-diff sanity
  check in the canary between client preview and server recompose.
- Manual approval accidentally turned off. Mitigation: the send_to_production
  guardrail (image-id match) still prevents a preview from being produced; add a
  startup check that logs a loud warning if approval is auto.

## Not doing (out of scope for this change)
Category nav, personalized card mockups, hero configurator, social proof. Those
are separate conversion items from the report and need product/content decisions.
