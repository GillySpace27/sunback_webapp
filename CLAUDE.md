# CLAUDE.md: My Heliograph webapp

Operating notes for an agent in this repository. `README.md` says what the
system is. `DEPLOY.md` is the deploy procedure and wins over anything here.
The owner is Gilly; call him Gilly.

## Before you change anything

1. Read `BRANCHES.md`: the integration line to start from, Gilly's landing
   order, and the FREEZE list.
2. Other Claude sessions often work in this repository and its worktrees at
   the same time. Re-read a file immediately before editing it, patch by an
   exact unique string, and merge on top of their changes; never revert them.
3. One branch per task. Small local commits are fine and expected.
4. Run `./infra/scripts/check.sh` before saying anything is done. A check
   that cannot fail proves nothing; a step you could not verify is reported
   as UNCHECKED, not as done.
5. Verify in the real page, not only in tests. The browser harness cannot
   validate motion: anything that moves gets a hand check on a real device.

## Safe without asking

    ./run_server                                  # origin on 127.0.0.1:8000
    cd web3d && npm ci && npm run typecheck       # film typecheck
    cd web3d && npm run build                     # film build (web3d/dist)
    cd web3d && npm run dev                       # film dev server
    ./infra/scripts/check.sh                      # every self-check
    ./infra/scripts/check.sh --list               # names of the checks
    python3 .claude/skills/deploy-myheliograph/scripts/status.py

Self-checks and what they need: `api/scripts/README.md`.

## Needs Gilly's explicit yes, every time

A yes covers one action. It never carries over to the next one.

- Any deploy, dev included: `infra/scripts/deploy.sh`, wrangler deploy,
  fly deploy. Production promotion follows `DEPLOY.md` step 4.
- Any rollback of the origin or the edge.
- fly secrets, fly scale, creating Fly apps or volumes, fly ssh into prod,
  writing to a Fly volume.
- Any Shopify write. Any Printify product creation, publish, image swap or
  order. That includes `api/scripts/printify_swap_probe.py` and the admin
  warm and upload scripts in `api/scripts/`.
- GET on the Printify variant pricing route
  (/api/printify/blueprints/<bp>/providers/<pp>/pricing): on a cost gap it
  creates and deletes a reference product in the real shop
  (_backfill_variant_costs_sync in `api/printify_routes.py`).
- git push of any branch or tag, and merging any branch listed in
  `BRANCHES.md`.
- Sending email or Slack, posting anywhere, changing DNS.

## Never

- Delete nothing. Never rm a tracked file, never git rm, never force-push,
  never rewrite history, never delete a branch, tag, release, volume file or
  cloud object. Retire a file with git mv into attic/ and add a row to
  `attic/README.md`. Retire a branch with a local archive tag (see
  `BRANCHES.md`).
- Never read, print or commit .env files or ~/.claude/secrets. Secrets never
  appear in a terminal, a log or a transcript.
- Never push the pre-purge branches listed in `BRANCHES.md`: their history
  holds a revoked key. A pre-push guard for this (MH-3) is not landed yet,
  so nothing but this rule stops it; --no-verify is not an option.
- Never give the dev tier Shopify credentials. A working dev checkout is a
  misconfiguration.
- Never accept or dismiss the cookie banner in captures.
- No em dashes anywhere: code, comments, commit messages, docs, UI copy.
- Buyer-facing words are Original and Enhanced. Internal names stay
  solar-archive and myheliograph-api. heliograph.com is not ours.
- RHEF output is a visualization, not a calibrated radiance. Never invent a
  citation, number or instrument fact.

## Hazards in the code

- One process. Exactly one Fly machine and one uvicorn worker (`fly.toml`
  header): the task registry, render semaphore, rate buckets and stats lock
  are in memory. Scale in `fly.toml`, never only with fly scale.
- Mount order. In `api/main.py`, /asset/default and /asset/preview are
  mounted before the catch-all /asset; the first matching prefix wins.
- Two-place whitelist. A new store module needs an entry in both
  _FRONTEND_MODULES (`api/main.py`) and the copy loop in
  `infra/worker/build-public.sh`; check.sh's whitelist_parity compares them.
- `infra/worker/build-public.sh` fails closed without web3d/dist (Static
  Assets replace public/ atomically) and runs its dev noindex block last.
  Never blind-merge it.
- Never serve .py source: api/ is never mounted as static and never copied
  wholesale into public/.
- _persist_default_manifest must keep the flat pid keys (`DEPLOY.md`,
  2026-08-15 incident).
- The design hash excludes overlay text, which can be personal
  (`api/scripts/test_design_hash.mjs`). Feedback files are never committed.
- Anything behind import.meta.env.DEV is invisible on the dev tier too: dev
  builds for production. Gate debug handles on a URL flag.
- Dates offered to buyers come from /api/data_frontier, never from today.
- NASA/SDO attribution stays visible on every page, phones included.
- Editor gamma: no CSS-filter fix; it breaks preview-equals-print.
- GA4 only after consent; Sentry crash reports only.

## FREEZE

`api/main.py`, `api/solar-archive.js` and `infra/worker/build-public.sh` are
on the FREEZE list in `BRANCHES.md`. Structural moves (splits, carve-outs)
wait until the row reads open. Additive edits wait until every branch named
in that row has Gilly's decision.

## Where things are

| Path | What |
|---|---|
| `api/main.py` | FastAPI origin: routes, fetch ladder, renders |
| `api/printify_routes.py` | Printify catalog, pricing, products, checkout |
| `api/shopify_storefront.py` | Storefront variant lookup, cart permalinks |
| `api/index.html` | the store page (served at /store/ on the edge) |
| `api/solar-archive.js` | store main module; siblings beside it |
| `web3d/` | the film (Vite, React Three Fiber), served at / |
| `infra/worker/src/index.js` | Cloudflare Worker: static assets, proxy, headers |
| `infra/scripts/deploy.sh` | the one deploy road (gated) |
| `render-service/` | Playwright plate renderer (Fly app myheliograph-render) |
| `attic/` | retired files, register in `attic/README.md` |
