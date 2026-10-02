---
name: deploy-myheliograph
description: Tiered deploy of myheliograph.com — ship to dev.myheliograph.com, run the regression/presentation review panel, then promote the reviewed image to production. Use when Gilly says "deploy the site", "ship myheliograph", "push to dev", "promote to prod", "deploy the store", or asks to release a change to myheliograph.com. Do NOT use for deploying the render service (myheliograph-render) or for a local dev server — those are separate.
---

# deploy-myheliograph

Ships myheliograph.com through two tiers with a review gate between them:
**commit → dev.myheliograph.com → panel → myheliograph.com**. Both tiers run
the *same image digest*, so what the panel reviewed is provably what
production ships.

The authoritative procedure is [DEPLOY.md](../../../DEPLOY.md) in the project
repo — read it if anything here seems to disagree; **the procedure doc wins**
and this file gets fixed.

## What this can finish unattended

Everything up to the promotion: preflight checks, deploying to dev, capturing
screenshot evidence from both tiers, running the panel, and adjudicating its
findings. Dev is safe to deploy freely — it has no Shopify credentials, so no
checkout exists there to accidentally complete.

## What requires Gilly in the loop

**Hard gate: never promote to production without asking Gilly in chat and
getting an explicit yes, every single time.** A yes for one deploy does not
cover the next. Preparation steps before the gate do NOT need per-step
confirmation; only the irreversible edge does.

State plainly what is about to happen — *"this will make commit `abc1234` live
on myheliograph.com for real customers"* — never a vague "shall I continue?".

Also gated, because each mutates real external state:

- Creating the dev Fly app or volume (one-time setup).
- Any `fly secrets set`.
- Rolling a tier back (`TARGET=prod ./infra/scripts/rollback.sh`, or `TARGET=dev`): lists
  the last five ledger entries, needs the SHA typed, and is a deploy in its own right.
- Deploying the render service (`TARGET=render ./infra/scripts/deploy.sh`).

**Never run `fly deploy` or `wrangler deploy` by hand, on any tier.** Every
deploy goes through `infra/scripts/deploy.sh`, which records what it shipped;
a hand deploy turns the tracker's `dev_drift` milestone red. The one
exception is a rollback Gilly has said yes to.

## Credentials

`FEEDBACK_ADMIN_KEY` (the `x-admin-key` for `/api/admin/*` warms) lives in
`~/.claude/secrets/solar-archive.env`. **Source it; never ask Gilly to paste
it.**

    source ~/.claude/secrets/solar-archive.env

Printify / JSOC / Shopify credentials are Fly secrets — write-only, never
readable back, never logged or committed. Dev deliberately has **no Shopify
credentials**; if a dev checkout ever works, that is a misconfiguration to
report, not to use.

## Progress tracker — show this after every milestone

    python3 .claude/skills/deploy-myheliograph/scripts/status.py --done captured,panel

Paste the output **verbatim**. Do not reformat or summarize it — a stable,
scannable format Gilly can pattern-match across runs is the entire point.

The `promoted` check compares the digest production is actually running
against the digest recorded when dev was deployed, so it can and will
disagree with the assistant. That disagreement is the tracker earning its
keep.

Render it after: preflight, dev deploy, evidence capture, panel adjudication,
and promotion.

Under the milestones the tracker prints a `Build identity` block: one line per
tier, `<tier>: origin <sha8> edge <sha8> OK` or `SKEW` (origin and edge are on
different commits) or `UNKNOWN`, and the newest receipt path. A `SKEW` line
after a deploy means one half did not ship; say so plainly.

## Steps

1. **Preflight.** A dirty tree is fine for dev, refused for prod.

       cd ~/vscode/sunback/webapp
       source ~/.claude/secrets/solar-archive.env
       git status --porcelain && ( cd web3d && npm run typecheck )

2. **Deploy to dev.** Records the candidate git SHA + image digest in
   `.deploy-run.json`.

       TARGET=dev ADMIN_KEY=$FEEDBACK_ADMIN_KEY ./infra/scripts/deploy.sh

3. **Capture evidence from both tiers.** Same pages, same viewports — that is
   what makes the diff meaningful.

       node web3d/tools/capture-pages.mjs https://myheliograph.com     .deploy-shots/prod
       node web3d/tools/capture-pages.mjs https://dev.myheliograph.com .deploy-shots/dev

4. **Run the review panel.** Invoke the `codex-loop` skill in **panel mode**
   (the full tree, both sides, adjudicated rather than merged — see
   `[[mixture-of-experts-loop]]`). Read `experts.md` first; state the lens
   picks and why in one line before running.

   Standing set: **`regression`**, **`presentation`**, **`accessibility`**,
   **`conversion-funnel`**.

   Add **`safety-claims`** only when the diff touches customer-facing copy:

       git diff --name-only <last-prod-sha>..HEAD \
         | grep -E 'index\.html|products\.js|legal/|solar-archive\.js'

   **Personas are off by default** (Gilly, 2026-08-22): they belong to
   drafting and debugging, and running them last in a deploy leaves their
   findings with no implementation path. If run explicitly, their findings go
   to `TODOS.md`, never to this gate.

5. **Adjudicate.** A confirmed `regression` finding **blocks** — fix,
   redeploy to dev, re-run. Everything else reports; file what matters in
   `TODOS.md`. "Confirmed" means the panel's own adjudication kept it.

6. **GATED** ⚠️ **Ask first.** This makes the commit live for real customers.

       TARGET=prod ADMIN_KEY=$FEEDBACK_ADMIN_KEY ./infra/scripts/deploy.sh

   deploy.sh refuses unless HEAD is an ancestor of `origin/main` (the
   2026-08-11 incident). Rehearse first; the rehearsal needs no secret and
   ships nothing:

       DRY_RUN=1 TARGET=prod ./infra/scripts/deploy.sh

7. **Verify.** Re-render the tracker. `promoted` must be green — if it isn't,
   production is not running the reviewed image and you must say so plainly
   rather than calling the deploy done.

8. **Receipt.** Every deploy appends to `.deploy-ledger.jsonl` and writes
   `.deploy-artifacts/<sha>/receipt.html` (commit range, digest, Worker
   version, edge hash, both capture columns). Open it before asking for the
   next yes: `open .deploy-artifacts/$(git rev-parse HEAD)/receipt.html`. After
   a prod promotion deploy.sh prints a `git tag mh-YYYY.MM.DD <sha>` line; it is
   printed, never run, and pushing the tag needs Gilly's yes.

## Launch gate (before any ad spend)

`status.py` prints a second block, "Launch gate", under the deploy milestones and ends it with `ADS: BLOCKED (<n> UNCHECKED)` until every launch item is verified or attested, then `ADS: CLEAR`. Paste it verbatim like the rest. What each item is, how it is proven and what Gilly does are in [LAUNCH_REVIEW.md](../../../LAUNCH_REVIEW.md) section 6.

Hard rules, no exceptions:

- The assistant never clicks Buy, never enters payment details, and never accepts or dismisses the cookie banner, in any browser, capture or script.
- The assistant never runs `--attest`. Only Gilly does, typing at a terminal; the script refuses otherwise.
- `infra/scripts/hq_retest.py` wakes the dev machine and fetches NASA data: ask Gilly first, once, off hours, and run its `--dry-run` before it.
- A launch item the tracker cannot verify stays UNCHECKED. Do not describe it as done, and do not describe it as failed.

## Hand-off

Say what is live and what is not. A prod deploy is **not** finished until the
tracker's `promoted` and `live` checks both pass. The mockup warm is
non-blocking and may still be running after the deploy reports success — the
grid falls back to canvas mockups until it completes, so say "deployed, warm
still running" rather than implying the grid is fully populated.

If the panel found non-blocking issues, list them and say where they were
filed. Do not let "deployed" imply "reviewed clean".

## Things that have actually gone wrong here

<!-- Real dated incidents. Append, never delete. Mirror into DEPLOY.md. -->

- **2026-08-15 — deploying without `web3d/dist` DELETED the live `/experience/`
  tree.** Static Assets deploys `public/` atomically, so a missing 3D build
  removes the app rather than degrading it. `build-public.sh` now hard-fails;
  `deploy.sh` rebuilds web3d every run.

- **2026-08-15 → 2026-08-22 — a `fly scale` change silently reverted.** Prod was
  scaled to 4 GB after HQ renders 503'd; on 2026-08-22 it measured 2 GB again,
  matching `fly.toml`. A later deploy reset it, because the config file is
  authoritative. **Scale in `fly.toml`, never only via CLI.**

- **2026-08-22 — Cloudflare's managed robots.txt defeated the dev crawler
  guard.** Cloudflare prepends its own block ending `User-agent: * / Allow: /`,
  which merges with ours and wins the equal-specificity tie, leaving dev
  indexable while its robots.txt looked correct. The real guard is now a
  `<meta name="robots" content="noindex">` injected into every static HTML
  file at dev-build time. **Never treat robots.txt as the dev guard, and
  never verify it by reading the file we ship — read the file the zone
  serves.**

- **2026-08-22 — dev.myheliograph.com is unreachable from NWRA's network.**
  The corporate proxy refuses it (`X-Squid-Error: ERR_CANNOT_FORWARD`) while
  DNS resolves and the site works fine externally. Verify dev through the
  browser pane or the workers.dev hostname; the tracker already falls back to
  workers.dev for exactly this reason. A dev check failing from Gilly's desk
  is not evidence the deploy failed.

- **2026-08-22 — production builds strip `window.__store`.** Tooling that
  drives the app through a debug handle silently spun until timeout against
  real production builds while local dev worked. Anything behind
  `import.meta.env.DEV` is invisible to the dev tier too, because the dev tier
  builds for production.

- **2026-08-11: a deploy from an unmerged branch, then a deploy from `main`,
  silently reverted six days of work.** `deploy.sh` now refuses `TARGET=prod`
  and `TARGET=render` unless HEAD is an ancestor of `origin/main`.

- **2026-09-15: a dev deploy ran as a hand `fly deploy` plus
  `wrangler deploy --env dev`, outside deploy.sh**, so `.deploy-run.json` kept
  recording an older commit. The tracker's `dev_drift` milestone now reads red
  when dev runs a digest the record does not hold.
