# Attic

Retired files, moved here with git mv so their history follows them
(git log --follow <path>). Nothing here is used by the running system.
Never delete from here; add a row for every move.

| Path | Original path | Moved | Reason | Replacement |
|---|---|---|---|---|
| attic/MIGRATION.md | MIGRATION.md | 2026-10-02 | Render to Cloudflare and Fly runbook; its Stage 3 (R2 bucket) is not what shipped | README.md (topology), DEPLOY.md |
| attic/SESSION_NOTES.md | SESSION_NOTES.md | 2026-10-02 | Session breadcrumb, 426 lines, plan dated 2026-05-22 | BRANCHES.md, DEPLOY.md |
| attic/PLAN.md | PLAN.md | 2026-10-02 | Three lines: "No active work in progress" | BRANCHES.md |
| attic/infra-scripts/sync_assets_to_r2.sh | infra/scripts/sync_assets_to_r2.sh | 2026-10-02 | Syncs to an R2 bucket the shipped Worker does not bind; calls the removed pull_render_data.sh | infra/scripts/pull_fly_assets.sh, infra/worker/build-public.sh |

## Left in place (untracked, not moved, not read)

Listed on 2026-10-02 from the plan's map (2026-09-28), not measured: this
list was written in a fresh clone that has none of these folders. Sizes are
the map's. Nothing here was moved or deleted. Re-measure on the Mac with
`du -sh <path>` from the main checkout.

| Path | Size | Note |
|---|---|---|
| dep | 596M (map) | backups; stays until Gilly decides |
| solar_archive_output | 1.3G (map) | local render output; now gitignored |
| api/static | not measured | may be referenced; stays |
| logs | not measured | may be referenced; stays |
| web3d/captures* | 4 to 19 MB each (map) | eleven capture folders; already ignored by web3d/.gitignore |
| web3d/plates* | not measured | already ignored by web3d/.gitignore |
| web3d/timelapse | not measured | already ignored by web3d/.gitignore |
| web3d/rainbow | not measured | now gitignored |
| web3d/sky-by-date.png, web3d/film-now.png | not measured | ignored by `*.png` in .gitignore |
| .claude/worktrees/gracious-gates | not measured | not a registered worktree; holds a .env copy that is never read, moved or printed |
