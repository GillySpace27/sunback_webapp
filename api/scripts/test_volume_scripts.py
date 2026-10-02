"""Self-check for infra/scripts/backup_state.sh and infra/scripts/seed_dev.sh (MH-6).

Run: python3 api/scripts/test_volume_scripts.py

No network and no real fly: FLY and CURL point at fakes that read and write a temp
folder standing in for the Fly volume. This proves the scripts' own logic (hash
verification, never overwriting, never pruning, never staging PII, refusing prod).
It does NOT prove flyctl's flags; those were not run when the scripts were written.
"""
import hashlib
import json
import os
import stat
import subprocess
import tarfile
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKUP = ROOT / "infra" / "scripts" / "backup_state.sh"
SEED = ROOT / "infra" / "scripts" / "seed_dev.sh"

FAKE_FLY = r'''#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
sha() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
case "$1 $2" in
  "ssh console")
    cmd="${@: -1}"
    case "$cmd" in
      "sha256sum /var/data/"*)
        rel="${cmd#sha256sum /var/data/}"
        if [ -f "$FAKE_VOLUME/$rel" ]; then echo "$(sha "$FAKE_VOLUME/$rel")  /var/data/$rel"
        else echo "sha256sum: /var/data/$rel: No such file or directory"; fi ;;
      "tar xzf /tmp/seed.tgz -C /var/data")
        tar xzf "$FAKE_CAPTURE/seed.tgz" -C "$FAKE_VOLUME" ;;
      *) echo "fake fly: unexpected console command: $cmd" >&2; exit 2 ;;
    esac ;;
  "ssh sftp")
    case "$3" in
      get)
        rel="${4#/var/data/}"
        [ "${FAKE_FAIL_GET:-}" = "${rel##*/}" ] && exit 1
        [ -f "$FAKE_VOLUME/$rel" ] || exit 1
        if [ "${FAKE_CORRUPT:-}" = "${rel##*/}" ]; then echo "junk" > "$5"; else cp "$FAKE_VOLUME/$rel" "$5"; fi ;;
      put) cp "$4" "$FAKE_CAPTURE/seed.tgz" ;;
      *) exit 2 ;;
    esac ;;
  *) echo "fake fly: unexpected: $*" >&2; exit 2 ;;
esac
'''

FAKE_CURL = r'''#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_LOG"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --max-time|--retry|--retry-delay) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
name="${url#*://*/asset/default/}"
src="$FAKE_VOLUME/default_cache/$name"
[ -f "$src" ] || exit 22
if [ "${FAKE_HTML:-}" = "$name" ]; then data="<html>error page</html>"; else data="$(cat "$src")"; fi
if [ -n "$out" ]; then printf '%s' "$data" > "$out"; else printf '%s' "$data"; fi
'''


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mh6vol-"))
        self.volume = self.tmp / "volume"
        (self.volume / "default_cache").mkdir(parents=True)
        self.capture = self.tmp / "capture"
        self.capture.mkdir()
        self.log = self.tmp / "calls.log"
        self.log.write_text("")
        self.root = self.tmp / "backups"
        for name, body in (("fly", FAKE_FLY), ("curl", FAKE_CURL)):
            p = self.tmp / name
            p.write_text(body)
            p.chmod(p.stat().st_mode | stat.S_IEXEC)
        self.env = dict(os.environ, FLY=str(self.tmp / "fly"), CURL=str(self.tmp / "curl"),
                        FAKE_LOG=str(self.log), FAKE_VOLUME=str(self.volume),
                        FAKE_CAPTURE=str(self.capture), BACKUP_ROOT=str(self.root),
                        ORIGIN="http://fixture")

    def put(self, rel, text):
        p = self.volume / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def fill_volume(self):
        self.put("feedback.jsonl", '{"email": "someone@example.com", "text": "hi"}\n')
        self.put("approved_catalog.json", '{"approved": []}')
        self.put("product_stats.json", '{"mug": 3}')
        self.put("default_cache/default_mockups.json", '{"193": {"rhef": {}}}')
        self.put("default_cache/vibe_manifest.json", '{"vibes": {}}')

    def run_script(self, script, **extra):
        env = dict(self.env, **extra)
        return subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True, timeout=120)

    def calls(self):
        return self.log.read_text()


class BackupTests(Env):
    def folders(self):
        return sorted(p for p in self.root.iterdir()) if self.root.exists() else []

    def test_copies_present_files_records_absent_ones_and_writes_checksums(self):
        self.fill_volume()
        r = self.run_script(BACKUP)
        self.assertEqual(r.returncode, 0, r.stderr)
        (dest,) = self.folders()
        self.assertEqual(dest.name, time.strftime("%Y-%m-%d", time.gmtime()))
        sums = (dest / "SHA256SUMS").read_text().strip().splitlines()
        self.assertEqual(len(sums), 5)
        for line in sums:
            digest, rel = line.split("  ", 1)
            self.assertEqual(sha256(dest / rel), digest)
        self.assertEqual((dest / "feedback.jsonl").read_text(), (self.volume / "feedback.jsonl").read_text())
        self.assertIn("absent  stats_seed.json", (dest / "BACKUP.txt").read_text())
        self.assertEqual(stat.S_IMODE(dest.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((dest / "feedback.jsonl").stat().st_mode), 0o600)

    def test_a_second_run_the_same_day_never_overwrites_the_first(self):
        self.fill_volume()
        self.assertEqual(self.run_script(BACKUP).returncode, 0)
        (first,) = self.folders()
        before = (first / "BACKUP.txt").read_text()
        self.put("product_stats.json", '{"mug": 4}')
        self.assertEqual(self.run_script(BACKUP).returncode, 0)
        self.assertEqual(len(self.folders()), 2)
        self.assertEqual((first / "BACKUP.txt").read_text(), before)
        self.assertEqual((first / "product_stats.json").read_text(), '{"mug": 3}')

    def test_dry_run_touches_nothing_and_asks_nothing(self):
        self.fill_volume()
        r = self.run_script(BACKUP, DRY_RUN="1")
        self.assertEqual(r.returncode, 0)
        self.assertFalse(self.root.exists())
        self.assertEqual(self.calls(), "")
        self.assertIn("dry run", r.stdout)

    def test_a_failed_transfer_leaves_no_checksums_and_exits_1(self):
        self.fill_volume()
        r = self.run_script(BACKUP, FAKE_FAIL_GET="product_stats.json")
        self.assertEqual(r.returncode, 1)
        (dest,) = self.folders()
        self.assertFalse((dest / "SHA256SUMS").exists())
        self.assertIn("FAILED  product_stats.json", (dest / "BACKUP.txt").read_text())

    def test_a_copy_that_does_not_match_the_machines_hash_is_a_failure(self):
        self.fill_volume()
        r = self.run_script(BACKUP, FAKE_CORRUPT="feedback.jsonl")
        self.assertEqual(r.returncode, 1)
        (dest,) = self.folders()
        self.assertIn("FAILED  feedback.jsonl", (dest / "BACKUP.txt").read_text())
        self.assertFalse((dest / "SHA256SUMS").exists())

    def test_an_error_page_is_not_a_manifest(self):
        self.fill_volume()
        r = self.run_script(BACKUP, FAKE_HTML="vibe_manifest.json")
        self.assertEqual(r.returncode, 1)
        (dest,) = self.folders()
        self.assertIn("FAILED  default_cache/vibe_manifest.json", (dest / "BACKUP.txt").read_text())


class SeedTests(Env):
    def mirror(self, extra=None):
        m = self.tmp / "mirror"
        m.mkdir(exist_ok=True)
        (m / "default_mockups.json").write_text('{"mirror": true}')
        (m / "vibe_manifest.json").write_text('{"vibes": {"mirror": true}}')
        (m / "quality_strip.webp").write_bytes(b"RIFFwebp")
        for name in (extra or []):
            (m / name).write_text("pii")
        return str(m)

    def backup_dir(self):
        b = self.tmp / "backup" / "2026-10-05"
        (b / "default_cache").mkdir(parents=True)
        (b / "default_cache" / "default_mockups.json").write_text('{"from": "backup"}')
        (b / "default_cache" / "vibe_manifest.json").write_text('{"vibes": {"from": "backup"}}')
        return str(b)

    def test_refuses_any_app_but_dev_before_touching_anything(self):
        r = self.run_script(SEED, APP="myheliograph-api", MIRROR=self.mirror(), GO="1")
        self.assertEqual(r.returncode, 64)
        self.assertIn("REFUSING", r.stderr)
        self.assertEqual(self.calls(), "")

    def test_without_go_it_prints_a_plan_and_writes_nothing(self):
        r = self.run_script(SEED, APP="myheliograph-api-dev", MIRROR=self.mirror())
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("plan only", r.stdout)
        self.assertEqual(self.calls(), "")

    def test_refuses_when_a_feedback_or_stats_file_would_be_staged(self):
        r = self.run_script(SEED, APP="myheliograph-api-dev", MIRROR=self.mirror(["feedback.jsonl"]), GO="1")
        self.assertEqual(r.returncode, 64)
        self.assertIn("REFUSING", r.stderr)
        self.assertEqual(self.calls(), "")

    def test_go_pushes_the_mirror_and_the_backups_manifests_and_verifies_them(self):
        r = self.run_script(SEED, APP="myheliograph-api-dev", MIRROR=self.mirror(),
                            FROM=self.backup_dir(), GO="1")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = self.calls()
        self.assertIn("ssh sftp put", calls)
        self.assertIn("tar xzf /tmp/seed.tgz -C /var/data", calls)
        self.assertIn("--app myheliograph-api-dev", calls)
        with tarfile.open(self.capture / "seed.tgz") as tf:
            names = tf.getnames()
        self.assertTrue(all(n == "default_cache" or n.startswith("default_cache/") for n in names), names)
        self.assertFalse([n for n in names if "feedback" in n or "approved_catalog" in n or "stats" in n], names)
        self.assertEqual((self.volume / "default_cache" / "default_mockups.json").read_text(),
                         '{"from": "backup"}')
        self.assertIn("verified", r.stdout)


if __name__ == "__main__":
    unittest.main()
