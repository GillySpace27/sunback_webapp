# api/scripts

Self-checks and operator tools for the origin. `./infra/scripts/check.sh`
runs every `test_*.py` (as `python3 <file>`) and every `test_*.mjs` (as
`node <file>`) in this folder; a new test file is picked up with no edit to
check.sh. Run any one alone with the command in its row.

## Self-checks (run by check.sh)

| File | Covers | Network | Run alone |
|---|---|---|---|
| test_coregistration.mjs | the solar disk fills the same fraction of the frame on every image tier | no | node api/scripts/test_coregistration.mjs |
| test_design_hash.mjs | design-identity hash ignores overlay text (personal data) and follows wavelength and crop; imports the helpers from api/identity.js | no | node api/scripts/test_design_hash.mjs |
| test_disk_guard.py | disk-full vs no-data failure classification, failure TTL, temp-cache pruning | no | python3 api/scripts/test_disk_guard.py |
| test_full_res_guard.py | full-resolution AIA guard: no 1024 px synoptic frame reaches a 4K print | only with GUARD_TEST_NETWORK=1 (JSOC) | python3 api/scripts/test_full_res_guard.py |
| test_grid_mockups.py | mockup grid cache keys, crop geometry, coverage, manifest round trip | no | python3 api/scripts/test_grid_mockups.py |
| test_ladder.py | price ladder: never below cost, anchor, $1.00 steps, .99 endings | no | python3 api/scripts/test_ladder.py |
| test_lazy_imports.py | importing api.main does not load the science stack | no | python3 api/scripts/test_lazy_imports.py |
| test_print_compose.py | print compositor formulas against hand-computed values | no | python3 api/scripts/test_print_compose.py |
| test_bundle_manifest.py | edge bundle code hash ignores tier-specific paths and the noindex meta, and changes with any code or font | no | python3 api/scripts/test_bundle_manifest.py |
| test_dockerfile_git_sha.py | the Dockerfile bakes GIT_SHA after the pip layer; deploy.sh passes the build arg once | no | python3 api/scripts/test_dockerfile_git_sha.py |
| test_deploy_receipt.py | deploy receipt: commit range, both capture columns, escaping, no external request | no | python3 api/scripts/test_deploy_receipt.py |
| test_status_identity.py | the tracker's Build identity lines (OK, SKEW, UNKNOWN) and newest receipt, with stubbed requests | no | python3 api/scripts/test_status_identity.py |
| test_settings.py | api/settings.py: env() matches getenv, REQUIRED_ENV has no Shopify name for dev and is covered by secrets.names or the Fly [env], startup lines never show a secret | no | python3 api/scripts/test_settings.py |
| test_no_stray_env.py | api/*.py reads configuration only through settings.env; lists the files still pending (main.py, printify_routes.py) | no | python3 api/scripts/test_no_stray_env.py |
| test_config_aliases.py | feedback_routes PRINTIFY_BASE, _public_base_url and _data_dir delegate to settings.py | no | python3 api/scripts/test_config_aliases.py |
| test_check_headers.py | infra/scripts/check_headers.py: PASS, FAIL and SKIP rows, and the HSTS values in its table equal the files that set them | no | python3 api/scripts/test_check_headers.py |
| test_ladder.mjs | api/pricing.js against the shared ladder vectors (the file test_ladder.py also reads), and the store's inline copy against it | no | node api/scripts/test_ladder.mjs |
| test_catalog_drift.py | catalog ids and Printify ids agree between api/main.py and api/products.js (backpack is the one known drift) | no | python3 api/scripts/test_catalog_drift.py |
| test_wavelength_drift.py | wavelength tiles in api/index.html and the film channels are consistent with the store wavelength list in api/main.py | no | python3 api/scripts/test_wavelength_drift.py |

## Tools (never run by check.sh)

| File | What it does | Network and gates |
|---|---|---|
| compare_print_compose.mjs | browser canvas vs server compositor, per-case pixel deltas | local Chromium via playwright-core in web3d/node_modules |
| race_repro.js | stale-render race repro; paste into DevTools on a page served by ./run_server | local origin only |
| make_compare_pair.py | builds the landing before/after webp pair into infra/data_mirror | local files |
| snapshot_routes.py | compares the FastAPI route table with routes.snapshot.json (check.sh runs it as routes_snapshot); `--update` rewrites the snapshot, only in a commit that adds or removes a route | imports api.main with scratch output and data dirs; no network |
| printify_swap_probe.py | creates a throwaway Printify product and an on-hold order, swaps the image, then cancels and deletes them | real Printify shop: Gilly's yes for every run |
| warm_cache.py | pre-seeds the preview cache on a deployed tier | live tier: Gilly's yes |
| warm_and_upload_vibe.sh | renders vibe tiles locally and uploads them with the admin key | live tier and admin key: Gilly's yes |
| warm_vibe_jpg_hq.py, warm_vibe_jpg_thumbs.py, warm_vibe_mq.py | warm the vibe-grid tiers into default_cache | Helioviewer, VSO and JSOC; any upload to a tier needs Gilly's yes |
| checkout_decouple_plan.md | design note for the checkout decouple (not a script) | none |


## Fixtures

Not recorded yet. MH-4 Task 8 (scrubbed Printify, Helioviewer and frontier
responses in `fixtures/`, plus `test_fixtures.py`) needs read-only requests to
the dev tier and Helioviewer, so it waits for a run by Gilly or a session
allowed to use the network. `./infra/scripts/check.sh --only fixtures_pii`
reports SKIP until the folder exists.

Never record /api/printify/blueprints/<bp>/providers/<pp>/pricing: on a
cost gap it creates and deletes a reference product in the real Printify
shop.
