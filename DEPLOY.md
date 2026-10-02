# Deploying myheliograph.com

The authoritative procedure. When this file and
`.claude/skills/deploy-myheliograph/SKILL.md` disagree, **this file wins** and
the skill gets fixed.

Two tiers, one reviewed artifact:

    commit → dev.myheliograph.com → REVIEW GATE → myheliograph.com

The gate is the reason the tiering exists. A dev tier you can skip past is a
second place for bugs to live, not a safeguard.

---

## Topology

| | dev | prod |
|---|---|---|
| site | `dev.myheliograph.com` | `myheliograph.com`, `www.` |
| Fly app | `myheliograph-api-dev` | `myheliograph-api` |
| Fly config | `fly.dev.toml` | `fly.toml` |
| Worker | `myheliograph-router-dev` | `myheliograph-router` |
| Wrangler | `wrangler deploy --env dev` | `wrangler deploy` |
| volume | 1 GB, seeded | 3 GB, the real cache |
| Printify | **yes** (real shop) | yes |
| Shopify | **no — checkout unreachable** | yes |
| mockup warm | never | every deploy |
| stale-draft cron | disabled | every 6h |
| robots | `Disallow: /` + `X-Robots-Tag` | normal |

Both tiers run **the same image digest**. `TARGET=dev` builds and records it;
`TARGET=prod` promotes that exact digest. This makes "what was reviewed is
what shipped" a checkable fact rather than a hope about reproducible builds.

### Why dev has no Shopify credentials

Gilly's call, 2026-08-22. Dev renders real Printify mockups (drafts are
reversible and already reaped by the prod cron) but physically cannot reach
checkout. No review pass — human or agent — can create a real order on dev.
**If a dev checkout path ever starts working, that is a misconfiguration to
fix, not a capability to use.**

---

## One-time setup

Only needed once per machine/account. Skip if `fly apps list` already shows
`myheliograph-api-dev`.

1. **Create the dev Fly app and volume.**

       fly apps create myheliograph-api-dev --org personal
       fly volumes create data --app myheliograph-api-dev --region dfw --size 1

2. **Set dev secrets.** Note the deliberate absence of Shopify.

       fly secrets set --app myheliograph-api-dev \
         PRINTIFY_API_KEY=... PRINTIFY_SHOP_ID=... \
         FEEDBACK_ADMIN_KEY=... INTERNAL_AUTH_TOKEN=... \
         SOLAR_ARCHIVE_JSOC_EMAIL=... \
         ALLOWED_ORIGINS=https://dev.myheliograph.com

3. **Point DNS at the dev worker.** In Cloudflare, add `dev` as a custom
   domain on `myheliograph-router-dev` (the route is already declared in
   `wrangler.jsonc` under `env.dev`). The first `wrangler deploy --env dev`
   provisions it.

4. **Seed the dev volume** so the mockup grid isn't empty (an empty grid
   falls back to canvas mockups, which the presentation lens will report as a
   regression that isn't one):

       ./infra/scripts/pull_fly_assets.sh          # refresh infra/data_mirror
       # then push the mirror's default_mockups.json to the dev origin

5. **Verify dev is un-indexable.** Check the META TAG, not robots.txt — see
   the 2026-08-22 incident below for why robots.txt lies here:

       curl -s https://dev.myheliograph.com/experience/ | grep -i 'name="robots"'
       curl -s https://dev.myheliograph.com/          | grep -i 'name="robots"'

   **From NWRA's network these will fail** — the corporate proxy refuses to
   forward to dev.myheliograph.com (`ERR_CANNOT_FORWARD`) even though DNS
   resolves and the site is fine externally. Use the browser pane, or the
   workers.dev hostname, which serves the identical worker and assets.

---

## The deploy

### 0. Preflight

    cd ~/vscode/sunback/webapp
    source ~/.claude/secrets/solar-archive.env      # FEEDBACK_ADMIN_KEY
    git status --porcelain                          # must be clean for prod
    ( cd web3d && npm run typecheck )
    ./infra/scripts/check.sh                        # every row PASS or SKIP

A dirty tree is allowed on dev and **refused** on prod: a promoted image must
map to a real commit or the whole audit trail is fiction.

**Ignored scratch.** `solar_archive_output/` and `web3d/rainbow/` are
gitignored (MH-4), so they no longer make the tree dirty for the prod
refusal; any other untracked file still does. The full list of untracked
folders left in place is in `attic/README.md`.

**Branches first.** Read `BRANCHES.md` at the repo root before any deploy:
it names the integration line, Gilly's landing order and the FREEZE list.
A branch that is not on the integration line is never deployed.

**Revoked key history on GitHub.** The revoked Printful key is still
reachable through GitHub pull-request refs. Removing it takes a
GitHub Support purge request, which only Gilly can file. No agent files it,
and no agent pushes any pre-purge branch listed in `BRANCHES.md`. The
`.env` history guard in `.githooks/pre-push` (MH-3 Task 6) is not landed
yet; until it is, nothing but this rule stops such a push.

### 1. Deploy to dev

    TARGET=dev ADMIN_KEY=$FEEDBACK_ADMIN_KEY ./infra/scripts/deploy.sh

Writes `.deploy-run.json` (gitignored) recording the git SHA and the image
digest. That file is what makes the promotion in step 4 verifiable.
deploy.sh merges into the file rather than overwriting it, and also records
`branch`, `deployed_by_script: true` and `worker_version_id` (parsed from the
wrangler output; `null` when it could not be parsed). A dev deploy from a
commit that is not on `origin/main` prints `### dev from unmerged branch
<name>`: prod will refuse to promote that candidate until the commit is on
`origin/main`.

Rehearse any tier without deploying anything and without a secret:

    DRY_RUN=1 TARGET=prod ./infra/scripts/deploy.sh

**Never run `fly deploy` or `wrangler deploy` by hand, on any tier.** A hand
deploy leaves `.deploy-run.json` describing something that is not running;
the tracker's `dev_drift` milestone turns red when dev runs an unrecorded
digest. The one exception is a rollback Gilly has said yes to (see Rollback).

### 2. Capture evidence for the panel

Both tiers, same pages, same viewports. Identical viewports are what make the
diff mean anything.

    node web3d/tools/capture-pages.mjs https://myheliograph.com     .deploy-shots/prod
    node web3d/tools/capture-pages.mjs https://dev.myheliograph.com .deploy-shots/dev

It lives in `web3d/tools/` rather than `infra/scripts/` for a boring reason:
Node resolves modules by walking *up* from the script, and `playwright-core`
is in `web3d/node_modules`. From `infra/scripts/` it is simply not found.

**Two things reliably produce false regressions here, so check them before
believing a diff:**

- *Thumbnails still loading.* The store paints its hero from network thumbs;
  the capture waits `CAPTURE_SETTLE_MS` (default 6000) and shoots regardless.
  A cold Fly machine on one tier and a warm one on the other is enough to
  make an empty tile look like a regression. Raise it
  (`CAPTURE_SETTLE_MS=12000`) if the shots disagree in that region, and warm
  both tiers with a throwaway request first.
- *The cookie banner.* It covers the lower third on a first visit. Present on
  both tiers, so it cancels out — but never dismiss it to "clean up" a
  screenshot. Accepting consent on Gilly's behalf is not yours to do, and the
  banner is part of what the accessibility lens should be looking at.

### 3. The review gate — the codex-loop panel

Invoke the `codex-loop` skill in **panel mode** (see [[mixture-of-experts-loop]]:
the full tree, codex side and claude side, adjudicated rather than merged).

**Standing lens set for a deploy** (Gilly, 2026-08-22):

| lens | side | why it is here |
|---|---|---|
| `regression` | claude | The blocking one. Diffs `.deploy-shots/prod` against `.deploy-shots/dev` and asks only: did this change break something that worked? |
| `presentation` | claude | Renders and *looks*. A deploy's whole surface is visual; a CSS judgement from source is worthless. |
| `accessibility` | claude | WCAG contrast, focus order, alt text, keyboard traps. Cheap ADA exposure for a small store. |
| `conversion-funnel` | claude | Cart → checkout. Partially blind on dev by design (no Shopify), so it reviews the dev funnel up to handoff and the **prod** funnel read-only. |
| `safety-claims` | claude | **Conditional.** Runs only when the diff touches customer-facing copy. See below. |

**`safety-claims` is conditional, not standing.** The expert pool flags it as
run-first for anything solar-adjacent — it is the only lens with physical-harm
exposure, and false solar-viewing safety claims are an active enforcement
area. Gilly did not want it on every deploy, which is reasonable: marketing
copy rarely changes. So it fires only when the diff touches copy:

    git diff --name-only <last-prod-sha>..HEAD | grep -E 'index\.html|products\.js|legal/|solar-archive\.js'

If that matches, run it. If it doesn't, skip it silently.

**Personas are OFF by default.** Gilly, 2026-08-22: they belong to drafting
and debugging, not deploying, and running them last in a deploy round leaves
their findings with no implementation path. Run them explicitly when you want
them, and route findings to `TODOS.md` — never to this gate.

#### Gate policy: blocking on regression only

- A **confirmed `regression` finding blocks promotion.** Fix it, redeploy to
  dev, re-run. Or Gilly overrides explicitly, in chat, per instance.
- Every other lens **reports but does not block.** File what matters in
  `TODOS.md`.
- "Confirmed" means the adjudicator kept it. A finding the panel's own
  adjudication dropped is not a blocker.

### 4. **GATED** — promote to production

⚠️ **Never run this without asking Gilly in chat and getting an explicit yes,
every single time.** A yes for one deploy never carries to the next. State
plainly what is about to happen: *"this will make commit `abc1234` live on
myheliograph.com for real customers"* — never a vague "shall I continue?".

    TARGET=prod ADMIN_KEY=$FEEDBACK_ADMIN_KEY ./infra/scripts/deploy.sh

Refuses to run if the tree is dirty, if HEAD is not an ancestor of
`origin/main` (the 2026-08-11 incident below), if `.deploy-run.json` is
missing, or if HEAD has moved since the dev deploy. Because prod promotes the
dev candidate, the dev deploy that feeds a promotion must itself be from
`origin/main` ancestry. Pushing `main` is Gilly's call.

### 5. Verify production

    python3 .claude/skills/deploy-myheliograph/scripts/status.py

The tracker compares prod's running image digest against the recorded
candidate. If they differ, the promotion did not ship what was reviewed.

### Render service (myheliograph-render)

    DRY_RUN=1 TARGET=render ./infra/scripts/deploy.sh   # rehearse
    TARGET=render ./infra/scripts/deploy.sh             # GATED: Gilly's yes, every time

The render service has no dev tier, so it takes the prod gates: clean tree,
HEAD an ancestor of `origin/main`, and the `render-service/Dockerfile` base
image tag equal to the `playwright` version in `render-service/package.json`.
The deployed image digest is recorded under `render` in `.deploy-run.json`;
a dev deploy never drops that key.

---

## Rollback

Fly keeps prior releases; the worker keeps prior versions.

    fly releases --app myheliograph-api
    fly deploy --config fly.toml --app myheliograph-api --image <previous digest>
    ( cd infra/worker && npx wrangler rollback )

Rolling back the origin does **not** roll back the edge. The frontend and the
API version independently, so decide which actually broke before rolling
either — and remember `public/` ships whatever `web3d/dist` held at build
time.

## Probes, drift and backups

| What | Command | Reads | When |
|---|---|---|---|
| Outside probes | `python3 infra/scripts/probe.py --tier prod` (and `--tier dev`); a scheduled `probe` workflow (every six hours) is written in MH-6 but not added yet: it waits for Gilly's yes to GitHub Actions for it | public URLs only | by hand until then |
| Drift report | `./infra/scripts/drift.sh` | `fly machine list`, `fly volumes list`, `fly secrets list` (names only), `wrangler secret list`, `fly*.toml`, `wrangler.jsonc`, `infra/secrets.names` | before a release and after any console change; never in CI |
| Volume backup | `./infra/scripts/backup_state.sh` | six files from prod's `/var/data` over `fly ssh` and two public manifests | weekly; Gilly's yes for each run; scheduling is his choice of mechanism |
| Seed dev | `APP=myheliograph-api-dev FROM=<backup dir> GO=1 ./infra/scripts/seed_dev.sh` | writes the dev volume only | on demand; Gilly's yes for each run |

`/api/health` does not report `disk_pct` below 85 percent until the one-line `api_health` edit in MH-6 lands (it waits on the `api/main.py` freeze in BRANCHES.md); until then `probe_health` passes with "disk_pct not reported". The probe thresholds are estimates to tune after a week of history: disk alert 80 percent, frontier older than 9 days, TLS under 14 days, first byte of `/` over 3 s. Probing four times a day wakes the scale-to-zero machine for a few minutes each time (estimated). GitHub disables scheduled workflows on a repository with no activity for 60 days (general GitHub behavior, not verified here); push or dispatch once to wake it. A failing scheduled run emails the account that last edited the schedule line (as understood, not verified here).

**Backups hold PII.** `feedback.jsonl` has email addresses. Backups live in `~/Documents/NWRA/vault-backups/myheliograph/<UTC date>/` (mode 0700), are never committed and are never pruned. `./infra/scripts/backup_state.sh` writes `SHA256SUMS` only for a complete run; verify with `cd <folder> && shasum -a 256 -c SHA256SUMS` (macOS) or `sha256sum -c SHA256SUMS`. status.py's `backup_age` goes red 14 days after the newest complete backup.

**Restore drill.** Seed dev from the latest backup, then compare dev with prod: the served manifests must be byte-identical (`for h in https://myheliograph-api.fly.dev https://myheliograph-api-dev.fly.dev; do curl -fsS $h/asset/default/default_mockups.json | shasum -a 256; done`) and the two landing captures (`node web3d/tools/capture-pages.mjs <base> .deploy-shots/<tier>`, warm both tiers first, never dismiss the cookie banner) show the same default tiles.

- Fly volume snapshots (read 2026-10-02): not read: the listing needs a Fly login and no Fly call was allowed in this session (UNCHECKED); run fly volumes snapshots list <volume id> --app myheliograph-api, newest snapshot UNCHECKED

---

## Things that have actually gone wrong here

<!-- Real dated incidents. Append, never delete. -->

- **2026-08-15 — deploying without `web3d/dist` DELETED the live `/experience/`
  tree.** Static Assets deploys `public/` atomically, so a build missing the
  3D app doesn't degrade it, it removes it (worker `e8d32dcb`). `build-public.sh`
  now hard-fails rather than warns, and `deploy.sh` builds web3d every run
  because `dist` is gitignored and a fresh checkout never has it.

- **2026-08-15 — `_persist_default_manifest` wiped the origin mockup manifest.**
  A version that dropped flat pid keys clobbered it; the edge copy was the only
  surviving source and became the restore path. Backup lives on the volume as
  `default_mockups.json.clobbered.bak`. Any change to that function must
  preserve flat pid keys.

- **2026-08-15 → 2026-08-22 — a CLI scale-up silently reverted.** The prod
  machine was scaled to 4 GB after HQ renders 503'd with
  "212MB free need ≥400MB". On 2026-08-22 the live machine measured **2 GB**
  again, matching `fly.toml`'s `[[vm]] memory = "2gb"` — a later `fly deploy`
  reset it, because the config file is authoritative and nobody updated it.
  **Scale in `fly.toml`, never only with `fly scale`.** `fly.dev.toml` pins
  the same 2 GB deliberately, so dev cannot review a box shape prod won't get.

- **2026-08-22 — a store deploy shipped a frontend whose store-side deep link
  the film never read.** Both halves were verified separately and neither was
  wrong alone. Where two components agree on a contract, check the contract
  end-to-end on dev before promoting, not each side in isolation.

- **2026-08-22 — Cloudflare's managed robots.txt defeated the dev crawler
  guard.** The dev tier shipped `User-agent: * / Disallow: /`, and measuring
  the live file showed Cloudflare had PREPENDED its own managed block ending
  in `User-agent: * / Allow: /`. Crawlers merge same-agent groups and, on an
  equal-specificity tie, **Allow wins** — so dev.myheliograph.com was
  indexable while its robots.txt appeared to forbid it. The `X-Robots-Tag`
  header did not cover the gap either: Static Assets serve HTML before worker
  code runs, so no HTML page ever got it. Fixed by injecting
  `<meta name="robots" content="noindex, nofollow">` into every static HTML
  file at dev-build time — the zone cannot rewrite it, and noindex is the
  stronger signal anyway (robots.txt only blocks fetching; Google will still
  index a URL it was never allowed to read). The tracker now checks the meta
  tag, not robots.txt.

- **2026-08-22 — the dev noindex injector silently skipped `/experience/`.**
  The build-public.sh block ran before the web3d tree was copied in, so it
  tagged 7 of 8 HTML files and missed the single most visible page on the
  tier. Caught only by counting tags per file rather than trusting the
  script's own success message. The block now runs last and prints the count.

- **2026-08-22 — nearly reported a working dev tier as broken.** A hand-made
  `helioviewer_thumb` probe returned 502, which looked like the dev origin
  failing. The URL was missing the time component and `image_scale`; the
  app's own request at the same moment returned 200. Reproduce a failure with
  the request the APP actually sends (copy it out of the logs) before
  concluding the tier is broken.

- **2026-08-22 — production builds strip `window.__store`.** The plate renderer
  drives the app through that handle, so every plate render against a real
  production build silently spun until timeout while local dev worked
  perfectly. Anything that only exists under `import.meta.env.DEV` is invisible
  to the dev tier too, because the dev tier builds for production. When a tool
  depends on a debug handle, gate it on a URL flag, not on the build mode.

- **2026-08-11: a deploy from an unmerged branch, then a deploy from `main`,
  silently reverted six days of work.** `deploy.sh` now refuses `TARGET=prod`
  and `TARGET=render` unless HEAD is an ancestor of `origin/main`.

- **2026-09-15: a dev deploy ran as a hand `fly deploy` plus
  `wrangler deploy --env dev`, outside deploy.sh**, so `.deploy-run.json` kept
  recording an older commit. The tracker's `dev_drift` milestone now reads red
  when dev runs a digest the record does not hold.
