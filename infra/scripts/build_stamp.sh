#!/usr/bin/env bash
# Prints the store build stamp: YYYY.MM.DD-<7-character git sha>, UTC date (SU-15).
# BUILD_STAMP_DATE=YYYY.MM.DD overrides the date; the tests use it.
set -euo pipefail
cd "$(dirname "$0")/../.."          # repo root
printf '%s-%s\n' "${BUILD_STAMP_DATE:-$(date -u +%Y.%m.%d)}" "$(git rev-parse --short=7 HEAD)"
