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

## Integration line

- Integration line: `codex/store-production-value` (tip `f2396ef`).
  Decision B10 (Gilly, 2026-10-02): tag the old `main` as `archive/main-<date>`
  first, then `codex/store-production-value` becomes `main`; nothing is deleted.
  Done 2026-10-02 (see Landing order row 1).
- `origin/main`: `a7edb0a`, 66 commits behind `codex/store-production-value`.
- Live on prod (Q1): unknown until Gilly records the commit and the Worker version here.

## Ledger

| Branch | Worktree | Ahead/behind main | Last commit | api/ diffstat | Decision (Gilly) | Landed as |
|---|---|---|---|---|---|---|
| `claude/prologue` | none visible from this clone | 67 / 0; 1 not in `codex/store-production-value` | 0325e40 2026-09-29 | 11 files changed, 2222 insertions(+), 209 deletions(-); god files: api/main.py api/solar-archive.js infra/worker/build-public.sh |  |  |
| `codex/store-production-value` | none visible from this clone | 66 / 0 | f2396ef 2026-09-15 | 11 files changed, 2222 insertions(+), 209 deletions(-); god files: api/main.py api/solar-archive.js infra/worker/build-public.sh | land (Gilly, 2026-10-02, decision sheet B10) |  |

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
| api/main.py | frozen | claude/prologue, codex/store-production-value |
| api/solar-archive.js | frozen | claude/prologue, codex/store-production-value |
| infra/worker/build-public.sh | frozen | claude/prologue, codex/store-production-value |

## Landing order

Gilly's order (decision B10 only; the rest is empty until he answers Q2 and Q3):

| # | Branch | Method | Gilly's yes (date) | Result |
|---|---|---|---|---|
| 1 | codex/store-production-value | tag old main as archive/main-<date>, then it becomes main | 2026-10-02 (decision sheet B10); tag and move: Gilly's yes in chat, 2026-10-02 | done 2026-10-02: old main tagged `archive/main-2026-10-02` (`a7edb0a`, local, not pushed); `origin/main` fast-forwarded to `31bb5c0`, which also carries `claude/prologue` |

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
