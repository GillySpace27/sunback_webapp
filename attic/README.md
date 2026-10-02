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
