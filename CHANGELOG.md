# Changelog

Deploys and operating changes for myheliograph.com, newest first, one
`## YYYY-MM-DD` heading per day. Seeded 2026-10-01 from the dated incident
headings in DEPLOY.md. From MH-8 on, `.deploy-ledger.jsonl` (local, gitignored)
holds the per-deploy record; after a prod promotion deploy.sh prints, and never
runs, `git tag mh-YYYY.MM.DD <sha>`. Creating that tag is local; pushing it
needs Gilly's yes.

## Unreleased

- Build identity (MH-8, partly landed): the git SHA is baked into the origin
  image (`GIT_SHA`) and status.py prints one line per tier saying whether
  origin and edge agree. Reporting it from `/api/build-info` and `/build.json`
  waits on the FREEZE rows for `api/main.py` and `build-public.sh`.
- Prod refuses an edge bundle whose code hash differs from the one dev
  recorded (`edge_code_hash` in `.deploy-run.json`).
- Append-only deploy ledger (`.deploy-ledger.jsonl`), a local HTML receipt per
  deploy (`.deploy-artifacts/<sha>/receipt.html`) and
  `infra/scripts/rollback.sh` (origin image and Worker version together,
  typed SHA, gated).
- Waking panel (MH-12): while a render request waits on a sleeping origin,
  a small non-blocking card says so; a preview that met the sleeping origin
  is retried once after `/api/health` answers (`api/waking.js`).
- One error envelope (MH-16): buyer-visible refusals (origin, rate limit,
  beta block, server busy, bad request, preview failure) return
  `{"code", "detail"}` with unchanged status codes (`api/errors.py`), and the
  store shows buyer text for each code from `api/messages.js` (DRAFT copy,
  tone waiting on Gilly). Full-resolution render timeouts get their own code.
  `product.name` and the checkout link are escaped where they enter HTML.
  The beta thank-you title "Thanks for testing My Heliograph!" became
  "Your design is saved" (DRAFT, Gilly's call).
- Editor drag comparison (MH-11): the Color tab opens the shared wipe over
  the canvas, Original against Enhanced at the design's own crop and edits,
  or the buyer's day against the newest printable day from
  `/api/data_frontier` (`api/editor_compare.js`). No CSS filter on either half.
- Replace this heading with the deploy date when the first prod promotion
  carries these changes.

## 2026-09-15

- A dev deploy ran as a hand `fly deploy` plus `wrangler deploy --env dev`,
  outside deploy.sh, so `.deploy-run.json` kept recording an older commit. The
  tracker's `dev_drift` milestone reads red when dev runs a digest the record
  does not hold (MH-1).

## 2026-08-22

- Dev is un-indexable by a `<meta name="robots" content="noindex, nofollow">`
  injected into every static HTML file at dev-build time; Cloudflare's managed
  robots.txt let `Allow` win, so the robots.txt guard alone did not work.
- The noindex injector in build-public.sh runs last, so
  `/experience/index.html` is covered.
- Machine size is set in `fly.toml` (4gb); never scale only with `fly scale`,
  a later `fly deploy` resets it.
- Production builds strip `window.__store`; tools must not depend on
  `import.meta.env.DEV` handles.

## 2026-08-15

- build-public.sh hard-fails without `web3d/dist`: a deploy without it had
  deleted the live `/experience/` tree (worker `e8d32dcb`); deploy.sh builds
  web3d on every run.
- `_persist_default_manifest` must preserve flat pid keys: a version that
  dropped them wiped the origin mockup manifest (backup on the volume as
  `default_mockups.json.clobbered.bak`).

## 2026-08-11

- A deploy from an unmerged branch, then a deploy from `main`, silently
  reverted six days of work. deploy.sh refuses `TARGET=prod` and
  `TARGET=render` unless HEAD is an ancestor of `origin/main` (MH-1).
```
