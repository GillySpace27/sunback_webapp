# My Heliograph: product-creation contract for a reimplemented front end

Hand-off for the 3D landing page. The landing can look like anything, but to
turn "a pretty date picker" into "a real, seamless sale" it must pull every
lever below in order. Each step lists what it produces and the exact endpoint
it calls. Endpoints are relative to the API origin (`API_BASE`); today that is
the Fly app behind the Cloudflare Worker.

The reference implementation is the IIFE in `api/solar-archive.js`; the product
catalog is `api/products.js`. Function names in parentheses point at that file.

---

## Part A: the irreducible pipeline (all required, in order)

### 1. Choose the image identity
Collect `{ date, time, wavelength, mission: "SDO", detector: "AIA" }`.
- `wavelength` is one of the 9 SDO/AIA channels: **94, 131, 171, 193, 211, 304, 335, 1600, 1700** (Å). Instrument is fixed to SDO/AIA.
- `date`/`time` are arbitrary (SDO/AIA covers ~2010→present). A curated "vibe"/event is just a shortcut that sets these plus a filter tier.
- Output: the identity object. Everything downstream keys off it.

### 2. Show a preview of that image (needed for "seamless", not for the sale)
- Fast thumbnail: `GET /api/helioviewer_thumb?date=<ISO>` (+ wavelength).
- Or a quick render: `POST /api/generate_preview` → `{ task_id, status_url }`, then poll `status_url`.
- Purpose: the buyer sees the actual sun for their date before committing. Skippable only if you are willing to sell an unseen image.

### 3. Choose a product (blueprint)
Pick one entry from the catalog. The catalog is the static array `PRODUCTS`
(`api/products.js`) merged at boot with admin additions from
`GET /api/catalog/approved`. Each product must yield:
`{ id, blueprintId, printProviderId, variantId (or a variant set), checkoutPrice, position ("front"), printShape, aspectRatio, dualPanel }`.
- The 3D page needs this catalog data (import `products.js` or fetch the approved list). Without `blueprintId`/`printProviderId`/`variantId` there is no product to create.

### 4. Produce the print-quality source render
This is the 4096² time-integrated render the print is composited from. It is
NOT the preview from step 2.
- `POST /api/generate` with `{ date, time, wavelength, mission:"SDO", detector:"AIA", format }` → `{ task_id, status_url }`.
- Poll `API_BASE + status_url` until `status:"finished"` (statuses seen: `queued` → `started`/`processing` → done) → an integrated render URL staged under `/asset/...`.
- `format` selects the tier (Filtered / HQ / RHEF); carry it in state as `editorFilter` / `hqFormat`.
- Reference: `startHqFilterGeneration()`, `_prewarmIntegratedHq()`, `_ensureIntegratedHqUrl()`. Prewarm this on buy-intent so checkout finds it cached (no second wait).
- Output: `source_url` (an `/asset/...` path on the API origin).

### 5. Maintain the edit parameters
Keep an editor-state object equal to `_printParams()`. Even a no-edit purchase
must send sane defaults (Fill crop = 100%, vignette = 0). Fields:
- Geometry: `cropZoom, panX, panY, rotation, flipH, flipV, aspectRatio {w,h}` (from the product), `printShape`.
- Colour: `brightness, contrast, saturation, hue, inverted`.
- Masking/fill: `vignette, vignetteWidth, vignetteFade(+Color/mode RGB), cropEdgeFeatherX, cropEdgeFeatherY, background`.
- Personalization (optional, all client-drawn): `textOverlay {text,...}` (the PII), `timestampStamp`, `dualPanel`, `clockNumbers`.
- Output: the params object. It defines the print pixels.

### 6. Resolve the print file (exactly one of two outputs)
`_resolveCheckoutPrintSource()`:
- **Server path (preferred)** when the params are server-composable, i.e. NONE of `textOverlay / timestampStamp / dualPanel / clockNumbers` are set:
  `POST /api/print_file { source_url, params }` → `{ supported:true, url }`. Send that as `image_url` (a few hundred bytes over the wire).
- **Browser path** otherwise: render the edits (incl. text) onto a 4096² canvas, export a lossless PNG, base64-encode it. Send as `image_base64`.
- Output: one of `{ image_url }` or `{ image_base64 }`. Never both.

### 7. Compute the design identity and PII flag (load-bearing, do not skip)
This is what keeps the catalog deduped and PII off public products (see the
just-merged hygiene work; omit it and you silently revert to per-order
snowflakes with customer names baked into persistent public products).
- `personalized = !!(textOverlay && textOverlay.text)`.
- `design_hash = cyrb53(stableStringify(identity))` where identity is a
  sorted, PII-free object: `{ wavelength, date, filter, vibe, blueprint_id, print_provider_id, variant_ids (sorted), position, params (with textOverlay set to null) }`. See `_designHash()` / `_stableStringify()` / `_cyrb53()`.
- `tags = ["solar-archive","custom","sun", wlStr, productName, personalized ? "personalized" : ("design-"+design_hash)]`.
- Output: `design_hash`, `personalized`, `tags`.

### 8. Create the product (the checkout call)
`POST /api/printify/checkout` with:
```
{ image_url | image_base64, file_name, title, description,
  blueprint_id, print_provider_id, variant_ids: [...],
  price, position, tags, design_hash, personalized }
```
→ `{ printify_product_id, published, status, reused? }`.
Server does: image upload → product create → publish to Shopify (or, on a
`design_hash` hit, returns an existing product and skips all three).
Invariants:
- `title` / `description` / `tags` must contain **no customer PII** (only date, wavelength, product). PII lives only in the print pixels of a personalized order.
- Must be sent from an allow-listed origin, and only while BETA_MODE is off (see Part C).

### 9. Get the Shopify URL and hand off
Poll `GET /api/printify/product/<printify_product_id>/shopify-url` →
`{ status, shopify_url | cart_url }`. When ready, present the
"Complete purchase on Shopify" link. `cart_url` (storefront cart permalink)
pre-selects the buyer's chosen variant; `shopify_url` is the product-page
fallback. Payment happens on Shopify. This link is the terminal output of the
whole flow. Reference: `pollShopifyUrl()`.

### 10. Seed the catalog twin (personalized orders only)
After step 9 succeeds, if `personalized` AND the design is server-composable,
fire a background second `POST /api/printify/checkout` with the clean
(text-free) `image_url`, `personalized:false`, and the same `design_hash` /
`design-<hash>` tag. Fire-and-forget: never block or surface it. Skipped when
the design is not server-composable (any of timestamp/dual-panel/clock).
Reference: `_seedCatalogTwin()`. This is what lets personalized sales still
grow the deduped public catalog without leaking PII.

---

## Part B: cross-cutting invariants (break any of these and it is not seamless)

- **Origin allow-list.** The API enforces the request origin (`enforce_origin`). The 3D page's domain must be added server-side or every write 403s.
- **BETA_MODE.** When on, `/checkout` (and publish) return a specific "checkout paused" message. The front end must detect and surface it, not spin.
- **Rate limits.** `/generate`, `/print_file`, `/checkout` are rate-limited; handle 429 gracefully (retry/back off, don't double-submit).
- **Cold start.** The backend scales to zero and takes ~20 s to wake. Warm it on buy-intent (`_warmBackend()` hits `/api/health`) so the HQ render and checkout don't eat a cold start.
- **No PII outside pixels.** Never place customer text in `title`, `description`, `tags`, `file_name`, or any URL. Only the personalized print image carries it, and only via `image_base64` (never staged to a public `/asset` URL).
- **Idempotency is best-effort.** Two identical checkouts within Shopify's tag-index lag can both create a product; the `design_hash` reuse converges over time but is not a hard lock. Don't fire duplicate checkouts on double-click.

---

## Part C: parity-for-seamless (strongly recommended, not required to complete a sale)

- **Real Printify mockup in the picker.** `POST /api/printify/upload` (image → Printify image id) then `POST /api/printify/product` (a `[MOCKUP]` draft → mockup images; server sweeps stale drafts). Lets the buyer see the image on the actual product before buying.
- **Live per-variant pricing.** `/api/printify/store-config`, `/api/printify/blueprints/...`, `/api/printify/blueprints/cheapest_costs`. So the displayed price matches what the server will charge.
- **Integrated-HQ prewarm** on editor open (step 4) so checkout is instant.

## Part D: safe to defer on a landing page

Editor sliders (ship a no-edit purchase with defaults), the mockup gallery,
vibes/curated events, and personalization text. A minimal but complete sale is
steps 1, 3, 4, 5 (defaults), 6, 7, 8, 9. Personalization (and step 10) can come
later; the checkout payload already carries `personalized:false` cleanly.

---

### One-paragraph version
Pick date + wavelength (identity) and a catalog product (blueprint/provider/
variant/price); kick off the 4096 integrated render via `/api/generate` and
poll it; build the edit-params object (defaults are fine); resolve one print
file (`/api/print_file` → `image_url`, or a base64 canvas render); compute
`design_hash` + `personalized` + `tags`; `POST /api/printify/checkout`; poll
`/shopify-url`; hand the buyer the Shopify cart link. Keep PII in pixels only,
respect origin/BETA/rate-limit/cold-start, and send `design_hash`/`personalized`
so the catalog dedupes and stays PII-clean.
