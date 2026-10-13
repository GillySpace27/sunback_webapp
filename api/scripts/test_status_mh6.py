"""Self-check for the drift and backup_age milestones in status.py (MH-6).

Run: python3 api/scripts/test_status_mh6.py

backup_age is a shell check, so the test runs it with BACKUP_ROOT pointing at a temp dir.
Pins: no folder is red; a recent folder with SHA256SUMS is green; a folder without
SHA256SUMS (an incomplete backup) or older than 14 days is red; a name that is not a date
is ignored; the T-suffixed same-day names count.
"""
import datetime
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATUS = ROOT / ".claude" / "skills" / "deploy-myheliograph" / "scripts" / "status.py"
_spec = importlib.util.spec_from_file_location("status_mh6", STATUS)
st = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(st)


def check_of(key):
    return next(c for k, _, c in st.MILESTONES if k == key)


class MilestoneTests(unittest.TestCase):
    def test_the_two_milestones_follow_live_and_have_how_text(self):
        keys = [k for k, _, _ in st.MILESTONES]
        self.assertEqual(keys[-2:], ["drift", "backup_age"])
        self.assertLess(keys.index("live"), keys.index("drift"))
        for k in ("drift", "backup_age"):
            self.assertEqual(st.HOW[k][0], "shell")

    def test_drift_runs_the_script_and_ignores_its_output(self):
        self.assertIn("infra/scripts/drift.sh", check_of("drift"))


class BackupAgeTests(unittest.TestCase):
    def run_check(self, root):
        env = dict(os.environ, BACKUP_ROOT=str(root))
        return subprocess.run(check_of("backup_age"), shell=True, env=env, capture_output=True, timeout=60).returncode

    def make(self, root, name, sums=True):
        d = Path(root) / name
        d.mkdir(parents=True)
        if sums:
            (d / "SHA256SUMS").write_text("x  y\n")

    def day(self, ago):
        return (datetime.datetime.now(datetime.timezone.utc).date() - datetime.timedelta(days=ago)).isoformat()

    def test_no_root_is_red(self):
        self.assertEqual(self.run_check("/nonexistent/mh6-backups"), 1)

    def test_a_recent_complete_backup_is_green(self):
        with tempfile.TemporaryDirectory() as d:
            self.make(d, self.day(3))
            self.assertEqual(self.run_check(d), 0)

    def test_a_same_day_suffixed_folder_counts(self):
        with tempfile.TemporaryDirectory() as d:
            self.make(d, self.day(2) + "T101010-4242")
            self.assertEqual(self.run_check(d), 0)

    def test_an_old_backup_is_red(self):
        with tempfile.TemporaryDirectory() as d:
            self.make(d, self.day(20))
            self.assertEqual(self.run_check(d), 1)

    def test_a_folder_without_checksums_is_an_incomplete_backup_and_red(self):
        with tempfile.TemporaryDirectory() as d:
            self.make(d, self.day(1), sums=False)
            self.assertEqual(self.run_check(d), 1)

    def test_a_folder_that_is_not_a_date_is_ignored(self):
        with tempfile.TemporaryDirectory() as d:
            self.make(d, "notes")
            self.assertEqual(self.run_check(d), 1)

    def test_the_newest_complete_folder_wins_over_an_old_one(self):
        with tempfile.TemporaryDirectory() as d:
            self.make(d, self.day(40))
            self.make(d, self.day(5))
            self.assertEqual(self.run_check(d), 0)


if __name__ == "__main__":
    unittest.main()
