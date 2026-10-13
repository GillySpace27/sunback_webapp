# Branches, landing order and freeze (webapp)

Written by MH-3 on 2026-10-02 from read-only git commands run in a clone of
GitHub (`origin`), not on Gilly's Mac. Counts are against `origin/main`
(`a7edb0a`) and need a re-run on the Mac, where
the local-only branches and worktrees also exist (see "Not visible from the
clone" below). Gilly fills the Decision column; agents never do, except to
copy a decision he has already written down (cited in the cell). Values:
`land`, `park`, `land in <initiative>`, `keep as is`. Nothing listed here
is deleted: parked branches stay, and their tips should carry local
`archive/2026-10/<branch>` tags that are never pushed (not yet created; see
Implementation notes in MH-3).

Refreshed 2026-10-12 (MH-3 Task 1) from read-only git commands in a full
clone of `origin`: integration line, ledger, FREEZE rows and landing order.
Counts below are against `origin/main` (`4ece09a`).

## Integration line

- Integration line: `main` (tip `4ece09a` on 2026-10-12).
  Decision B10 (Gilly, 2026-10-02): tag the old `main` as `archive/main-<date>`
  first, then `codex/store-production-value` becomes `main`; nothing is deleted.
  Done 2026-10-02 (see Landing order row 1). `codex/store-production-value`
  (tip `5fbabbf`) and `claude/prologue` (tip `0325e40`) are both ancestors of
  `main` now; they stay as history.
- Old `main` (`a7edb0a`) is an ancestor of `main`; its tag
  `archive/main-2026-10-02` is local on Gilly's Mac and not on origin.
- Live on prod (Q1): unknown until Gilly records the commit and the Worker version here.

## Ledger

| Branch | Worktree | Ahead/behind main | Last commit | api/ diffstat | Decision (Gilly) | Landed as |
|---|---|---|---|---|---|---|
| `claude/prologue` | none visible from this clone | 0 / 21 (contained in `main`) | 0325e40 2026-09-29 | landed | land (carried by `main` since 2026-10-02) | `main` (fast-forward, 2026-10-02) |
| `codex/store-production-value` | none visible from this clone | 0 / 5 (contained in `main`) | 5fbabbf 2026-10-01 | landed | land (Gilly, 2026-10-02, decision sheet B10) | `main` (fast-forward, 2026-10-02) |
| `claude/wave1-myheliograph` | none visible from this clone | 53 / 0 | e8c2c24 2026-10-13 | 33 files changed, 3393 insertions(+), 117 deletions(-); god files: api/main.py |  | not yet: PR #55 (draft; base retargeted to `main` 2026-10-12, `main` merged into it) |
| `claude/project-thread-o18i7n` | none visible from this clone | 2 / 0 | 669807a 2026-10-11 | 10 files changed, 35 insertions(+), 35 deletions(-); god files: api/main.py api/solar-archive.js |  | not yet: PR #56 (draft, base `main`) |

Contained in `origin/main` (0 ahead, kept as history, no decision needed): `claude/cold-start`, `claude/disk-guard`, `claude/heliograph-ship-readiness-242a1f`, `claude/hq-lazy-swapout-wip`, `claude/launch-merge`, `claude/molten-record-2d-motion`, `claude/patricia-p2-provenance-jsonld`, `claude/premium-3d-solar-site-dfed89`, `claude/qa-fixes-2026-08-10`, `claude/race-fix-on-main`, `claude/rhef-pane-image-display-e71f85`, `claude/website-launch-readiness-d8fca6`, `pii-hygiene-reusable-catalog`, `worktree-agent-a0ca78663b70f0627`, `worktree-agent-a2dcd2d0b1c042337`.

Not visible from the clone (exist only on Gilly's Mac; add rows there with the
generator in the MH-3 task file): `claude/continue-previous-work-721f36`,
`claude/catalog-gc-donations`, `web3d-timelapse`, `web3d-diegetic-corona`,
`claude/myheliograph-conversion-review-c05d69`, `claude/commit-provenance-hooks`,
and the detached worktrees `elated-mirzakhani-b6d3d4` and
`website-design-audit-680db7`. The FREEZE "Waiting on rows" below therefore
lists only the branches visible here; add the local ones that touch the files.

## FREEZE

Structural moves (file splits, module carve-outs) in these files wait until
the row reads `open YYYY-MM-DD`. Additive edits wait until every branch in
"Waiting on rows" has a Decision.

| File | Status | Waiting on rows |
|---|---|---|
| api/main.py | open 2026-10-02 (small targeted edits only; see Decision below) | none (both branches are in `main`) |
| api/solar-archive.js | open 2026-10-12 (additive edits; structural moves need Gilly's yes) | none (both branches are in `main`) |
| infra/worker/build-public.sh | open 2026-10-12 (additive edits; structural moves need Gilly's yes) | none (both branches are in `main`) |

Decision (Gilly, 2026-10-02): `api/main.py` is unfrozen for small targeted
edits only (the RH-9 fallback fixes, MH-10 configuration, MH-8 `/api/build-info`,
MH-6 `disk_pct`, MH-7 lint comments). It stays closed to structural moves (file
splits, module carve-outs). Reason: those edits are small, tested, and the
waiting branches are not being landed ahead of them. `api/solar-archive.js` and
`infra/worker/build-public.sh` stay FROZEN: nothing may touch them, and any
task that needs them stays skipped (footer build stamp, `build.json`, the
`solar-archive.js` side of the RHEF changes). Also decided the same day:
`.github/workflows/check.yml` is approved (Linux, runs `infra/scripts/check.sh`
on pull requests, no secrets, no production calls); `probe.yml` is NOT approved
and no scheduled or live-probing workflow may be added.

Decision (Gilly, 2026-10-12, Wave 0/1 finish sheet question A2): the
`api/solar-archive.js` and `infra/worker/build-public.sh` rows are open for
additive edits, since both branches they waited on are in `main`. Structural
moves (file splits, module carve-outs) in any of the three files still need
his yes for that move. The "stay FROZEN" sentence above is superseded for
additive edits.

## Landing order

Gilly's order (decision B10 only; the rest is empty until he answers Q2 and Q3):

| # | Branch | Method | Gilly's yes (date) | Result |
|---|---|---|---|---|
| 1 | codex/store-production-value | tag old main as archive/main-<date>, then it becomes main | 2026-10-02 (decision sheet B10); tag and move: Gilly's yes in chat, 2026-10-02 | done 2026-10-02: old main tagged `archive/main-2026-10-02` (`a7edb0a`, local, not pushed); `origin/main` fast-forwarded to `31bb5c0`, which also carries `claude/prologue` |
| 2 | claude/wave1-myheliograph (PR #55) | merge commit into main, no rebase | retarget to `main`: decision sheet D, 2026-10-12; the merge itself waits for Gilly's yes | 2026-10-12: base retargeted to `main`; `main` (`4ece09a`) merged into the branch (merge commit `2ed53cb`); full `check.sh` 16 passed, 0 failed, 0 skipped in a cloud clone; not merged |

## Pre-purge bundle

These branches predate the 2026-07-15 history purge and still carry `.env`
commits (the revoked Printful key) in the local copies on Gilly's Mac. They
stay in place. They get no archive tag. The table shows what the origin copy
of each looks like from the clone (the origin refs carry rewritten history).

| Branch | .env commits on origin ref | Origin tip |
|---|---|---|
| `claude/angry-cray` | not on origin | n/a |
| `claude/brave-easley-a2652d` | 0 | 115656a |
| `claude/cranky-ishizaka-307f34` | not on origin | n/a |
| `claude/dazzling-torvalds-ffe3ab` | not on origin | n/a |
| `claude/dreamy-davinci-c8e1a5` | 0 | cb7839e |
| `claude/elated-euclid-2bf1bd` | not on origin | n/a |
| `claude/loving-driscoll-166818` | not on origin | n/a |
| `claude/mac-sleep-mode-terminal-628b66` | not on origin | n/a |
| `claude/privacy-telemetry-accuracy` | 0 | 2c0c04a |
| `claude/quirky-goldwasser-87d05d` | 0 | 394c77c |
| `claude/quizzical-newton-949554` | 0 | 686f2cb |
| `claude/suspicious-lumiere-c43fa1` | 0 | aa0aefb |
| `claude/trusting-roentgen-f07d2a` | not on origin | n/a |
| `claude/zealous-mayer` | not on origin | n/a |
| `feature/rhef-progressive-and-preview-fixes` | 0 | 2904ff9 |
| `worktree-agent-a9bd191437d44b703` | not on origin | n/a |

Bundle: not created (waiting on Gilly's answer to Q4; it is a file on his Mac).
