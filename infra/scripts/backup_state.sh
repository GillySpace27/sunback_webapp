#!/usr/bin/env bash
# Copy the volume files that cannot be regenerated to this machine (MH-6).
#
#   ./infra/scripts/backup_state.sh              the real run: reads prod's volume over fly ssh
#   DRY_RUN=1 ./infra/scripts/backup_state.sh    print the plan, touch nothing
#
# Paths below are relative to /var/data on the volume:
#   feedback.jsonl approved_catalog.json product_stats.json stats_seed.json   over fly ssh
#   default_cache/default_mockups.json default_cache/vibe_manifest.json        over HTTPS (public /asset/default/)
# Each ssh file is checked against a hash the machine computes itself; each manifest must
# parse as JSON. The folder is $BACKUP_ROOT/<UTC date>; a second run on the same day gets
# its own folder, so nothing is overwritten, and nothing is ever pruned. SHA256SUMS is
# written only when every file copied or is legitimately absent, and status.py counts a
# folder only if it has one.
#
# feedback.jsonl holds email addresses (PII): the folder is created 0700, stays on this
# machine and is never committed. Reading the volume over fly ssh needs Gilly's yes for
# each run. The flyctl flags used (ssh console -C, ssh sftp get) were not run when this
# was written: a flag that does not behave shows up as FAILED rows, never as a bad backup.
set -euo pipefail
FLY="${FLY:-fly}"
CURL="${CURL:-curl}"
APP="${APP:-myheliograph-api}"
ORIGIN="${ORIGIN:-https://myheliograph-api.fly.dev}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/Documents/NWRA/vault-backups/myheliograph}"
SSH_FILES=(feedback.jsonl approved_catalog.json product_stats.json stats_seed.json)
HTTP_FILES=(default_cache/default_mockups.json default_cache/vibe_manifest.json)

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "backup_state: dry run, nothing touched."
  echo "  app $APP, folder $BACKUP_ROOT/$(date -u +%Y-%m-%d)"
  for rel in "${SSH_FILES[@]}"; do echo "  would read /var/data/$rel over fly ssh"; done
  for rel in "${HTTP_FILES[@]}"; do echo "  would GET $ORIGIN/asset/default/${rel#default_cache/}"; done
  exit 0
fi

umask 077
mkdir -p "$BACKUP_ROOT"
STAMP="$(date -u +%Y-%m-%d)"
DEST="$BACKUP_ROOT/$STAMP"
if ! mkdir "$DEST" 2>/dev/null; then
  DEST="$BACKUP_ROOT/${STAMP}T$(date -u +%H%M%S)-$$"
  mkdir "$DEST"
fi

LINES=()
SUMS=()
failed=0

for rel in "${SSH_FILES[@]}"; do
  remote="/var/data/$rel"
  reply="$("$FLY" ssh console --app "$APP" -C "sha256sum $remote" 2>&1 || true)"
  want="$(printf '%s\n' "$reply" | grep -Eo '^[0-9a-f]{64}' | head -n 1 || true)"
  if [ -z "$want" ]; then
    if printf '%s\n' "$reply" | grep -q 'No such file'; then
      LINES+=("absent  $rel  (not on the volume)")
    else
      LINES+=("FAILED  $rel  (no hash from the machine)"); failed=1
    fi
    continue
  fi
  mkdir -p "$(dirname "$DEST/$rel")"
  if ! "$FLY" ssh sftp get "$remote" "$DEST/$rel" --app "$APP" >/dev/null 2>&1; then
    LINES+=("FAILED  $rel  (sftp get failed)"); failed=1; continue
  fi
  got="$(sha256_of "$DEST/$rel")"
  if [ "$got" != "$want" ]; then
    LINES+=("FAILED  $rel  (copy hash $got differs from the machine's $want)"); failed=1; continue
  fi
  LINES+=("ok      $rel  $got  ssh"); SUMS+=("$got  $rel")
done

for rel in "${HTTP_FILES[@]}"; do
  mkdir -p "$(dirname "$DEST/$rel")"
  if "$CURL" -fsS --max-time 120 --retry 2 -o "$DEST/$rel" "$ORIGIN/asset/default/${rel#default_cache/}" 2>/dev/null \
     && python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$DEST/$rel" 2>/dev/null; then
    got="$(sha256_of "$DEST/$rel")"
    LINES+=("ok      $rel  $got  https"); SUMS+=("$got  $rel")
  else
    LINES+=("FAILED  $rel  (not fetched, or not JSON)"); failed=1
  fi
done

{
  echo "backup of $APP, UTC $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' "${LINES[@]}"
} > "$DEST/BACKUP.txt"

if [ "$failed" = "1" ]; then
  printf '%s\n' "${LINES[@]}" >&2
  echo "backup_state: INCOMPLETE. No SHA256SUMS written, so status.py does not count $DEST. Nothing was deleted; fix the failure and run again." >&2
  exit 1
fi
if [ "${#SUMS[@]}" -eq 0 ]; then
  echo "backup_state: nothing copied (every file absent?)" >&2
  exit 1
fi
printf '%s\n' "${SUMS[@]}" | sort -k2 > "$DEST/SHA256SUMS"
printf '%s\n' "${LINES[@]}"
echo "backup_state: ${#SUMS[@]} file(s) in $DEST (holds PII; keep it here, never commit it)"
