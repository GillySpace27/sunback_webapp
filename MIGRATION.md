# Render → Cloudflare + Fly.io migration runbook

Goal: ~$100/mo (Render Standard + bandwidth) → ~$1–3/mo, with zero
user-visible breakage. Full architecture map + rationale: session notes
2026-07-07; the short version:

```
myheliograph.com  ──► Cloudflare Worker (infra/worker/)
                        ├─ static frontend  → Workers Static Assets (free)
                        ├─ /asset/**        → R2 bucket, zero egress
                        │                     └─ miss → Fly origin (dynamic renders)
                        └─ /api/** + rest   → Fly.io FastAPI origin
                                              (2GB, scale-to-zero, volume at /var/data)
```

Topology invariant: **exactly one Fly machine × one uvicorn worker** — the
in-memory task registry, heavy-render semaphore, rate buckets, and stats
lock all require it.

## Stage 1 — code changes (SHIPPED to Render first to prove them safe)
- Atomic image writes (tmp + `os.replace`) everywhere a cache-served PNG is
  written — a scale-to-zero stop mid-render can no longer poison caches
  with truncated files. (`_atomic_image_write` in api/main.py)
- Printify TLS verification now defaults ON everywhere (was: off unless the
  `RENDER` env var existed). Opt out with `PRINTIFY_SSL_VERIFY=0`.
- Printify upload-URL allowlist + localhost rewrite are env-driven
  (`PUBLIC_BASE_URL`, default onrender.com) instead of hardcoded.
- Deleted the dead unconditional `SOLAR_ARCHIVE_ASSET_BASE_URL` overwrite.
- New admin endpoint `POST /api/printify/admin/sweep_mockup_drafts`
  (X-Admin-Key) — synchronous stale-draft sweep for the Worker cron.
- Frontend: `/api/status` `unknown` streak now triggers the silent-retry
  path instead of polling forever; Render-specific banner copy generalized.

## Stage 2 — Fly.io origin
1. `fly auth signup` / login (needs payment method on file).
2. `fly launch --no-deploy --copy-config` from repo root (uses fly.toml;
   app name `myheliograph-api`, region `den`).
3. `fly volumes create data --size 3 --region den`
4. Set secrets (copy values from Render dashboard → Environment):
   `fly secrets set PRINTIFY_API_KEY=... PRINTIFY_SHOP_ID=... \
      SHOPIFY_STORE_DOMAIN=... SHOPIFY_STOREFRONT_ACCESS_TOKEN=... \
      FEEDBACK_ADMIN_KEY=... INTERNAL_AUTH_TOKEN=... \
      SOLAR_ARCHIVE_JSOC_EMAIL=... \
      ALLOWED_ORIGINS="https://myheliograph.com,https://www.myheliograph.com,https://solar-archive.myshopify.com"`
5. `fly deploy` (remote builder — no local Docker needed).
6. Seed data: `infra/scripts/pull_render_data.sh` then
   `infra/scripts/seed_fly_volume.sh`.
7. Parity checks against https://myheliograph-api.fly.dev :
   `/api/health`, `/asset/default/default_mockups.json`,
   `/api/printify/blueprints/cheapest_costs`, a preview render, an HQ
   render, feedback admin GET.

## Stage 3 — R2 + Worker
1. Cloudflare: `npx wrangler login`.
2. `npx wrangler r2 bucket create heliograph-assets`
3. `infra/scripts/sync_assets_to_r2.sh` (from the Stage-2 mirror).
4. `cd infra/worker && ./build-public.sh && npx wrangler secret put ADMIN_KEY
   && npx wrangler deploy`
5. Test everything on the workers.dev URL (full store flow, stop before
   purchase). `/asset` hits should show R2 serving (no `rndr-id` header).

## Stage 4 — cutover
1. In wrangler.jsonc: uncomment the `routes` custom-domain block.
2. Cloudflare DNS: delete the existing records for `myheliograph.com` +
   `www` (they CNAME to onrender.com).
3. `npx wrangler deploy` — custom domains mint their own DNS + certs.
4. Verify: site loads, images from R2, `/api/health` proxied, checkout
   link works, `enforce_origin` accepts posts (ALLOWED_ORIGINS!).
5. **Rollback** at any point: re-create the CNAME to
   `solar-archive.onrender.com` — Render is still running untouched.
6. Update `~/.claude/secrets` notes + api/scripts/warm_and_upload_vibe.sh
   REMOTE default + warm_cache.py to the new origin.
7. Check the Shopify app proxy (`/apps/solar-render`) — if it points at
   onrender.com, repoint to myheliograph.com.

## Stage 5 — decommission Render (after a few days' soak)
1. Suspend service srv-d478g9i4d50c73809e60 (keeps the disk).
2. Watch for breakage for a week (anything still calling onrender.com).
3. Delete service + disk. Billing stops.
4. Rotate/remove the legacy PRINTFUL_API_KEY committed in `.env` (public
   repo!) and drop the stray DEPLOY_NUDGE env var memory note.

## Post-migration ops changes
- Admin warms: call the **Fly hostname directly** (`myheliograph-api.fly.dev`)
  — warm_default/warm_vibe_grid run minutes-long single requests that would
  524 behind the Worker. They're idempotent; retry on timeout.
- After any warm, re-run `infra/scripts/sync_assets_to_r2.sh` (R2 mirrors
  origin default_cache).
- The Worker cron (every 6 h) runs the mockup-draft sweep; check
  `npx wrangler tail` if drafts ever accumulate again.
- Feedback reads: same admin endpoint, new host.
