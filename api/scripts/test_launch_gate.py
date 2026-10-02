"""Self-check for the launch gate in .claude/skills/deploy-myheliograph/scripts/status.py (MH-5).

Run: python3 api/scripts/test_launch_gate.py

No network, no fly, no Shopify, no Sentry: every external read is a fake passed
in. The gate has two states only, OK and UNCHECKED, and these tests pin the
rules that keep it honest:
  - an attestation needs a terminal, a typed confirmation and a real date, and
    is never overwritten;
  - first_gated_promotion cannot be attested, only verified from prod's digest;
  - a token or secret never appears in a detail line;
  - a check that raises reads UNCHECKED, never OK.
"""
import contextlib
import datetime
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STATUS = ROOT / ".claude" / "skills" / "deploy-myheliograph" / "scripts" / "status.py"
_spec = importlib.util.spec_from_file_location("status_mh5", STATUS)
st = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(st)

SHA_A = "sha256:" + "a" * 64
SHA_B = "sha256:" + "b" * 64


class Sandbox(unittest.TestCase):
    """Point every state file the launch gate reads at a temp dir."""
    NAMES = ("ATTEST_FILE", "HQ_FILE", "LEDGER_FILE", "RUN_STATE")

    def setUp(self):
        saved = {n: getattr(st, n) for n in self.NAMES}
        self.addCleanup(lambda: [setattr(st, n, v) for n, v in saved.items()])
        self.tmp = tempfile.mkdtemp(prefix="mh5-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        st.ATTEST_FILE = os.path.join(self.tmp, ".launch-attest.json")
        st.HQ_FILE = os.path.join(self.tmp, ".launch-hq.json")
        st.LEDGER_FILE = os.path.join(self.tmp, ".deploy-ledger.jsonl")
        st.RUN_STATE = os.path.join(self.tmp, ".deploy-run.json")

    def put(self, path, obj):
        with open(path, "w") as f:
            json.dump(obj, f)


class AttestTests(Sandbox):
    def run_attest(self, key, note="", tty=True, answer=None, today=datetime.date(2026, 10, 3)):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = st.attest(key, note, today=today,
                             input_fn=lambda prompt: key if answer is None else answer,
                             is_tty=tty)
        return code, err.getvalue()

    def test_refuses_a_key_that_is_not_attestable(self):
        code, err = self.run_attest("first_gated_promotion")
        self.assertEqual(code, 2)
        self.assertIn("cannot be attested", err)
        self.assertFalse(os.path.exists(st.ATTEST_FILE))

    def test_refuses_without_a_terminal(self):
        code, err = self.run_attest("phone_store", tty=False)
        self.assertEqual(code, 2)
        self.assertIn("terminal", err)
        self.assertFalse(os.path.exists(st.ATTEST_FILE))

    def test_refuses_a_wrong_confirmation(self):
        code, err = self.run_attest("phone_store", answer="yes")
        self.assertEqual(code, 2)
        self.assertIn("did not match", err)
        self.assertFalse(os.path.exists(st.ATTEST_FILE))

    def test_end_of_input_at_the_prompt_is_a_refusal(self):
        def eof(prompt):
            raise EOFError
        with contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            code = st.attest("tablet", "", today=datetime.date(2026, 10, 3), input_fn=eof, is_tty=True)
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(st.ATTEST_FILE))

    def test_writes_one_dated_entry(self):
        code, _ = self.run_attest("phone_store", note="device and browser")
        self.assertEqual(code, 0)
        with open(st.ATTEST_FILE) as f:
            self.assertEqual(json.load(f), {"phone_store": {"attested_at": "2026-10-03",
                                                            "note": "device and browser"}})
        self.assertFalse(os.path.exists(st.ATTEST_FILE + ".tmp"))

    def test_a_second_attest_of_the_same_key_is_refused_and_changes_nothing(self):
        self.run_attest("phone_store", note="first")
        with open(st.ATTEST_FILE) as f:
            before = f.read()
        code, err = self.run_attest("phone_store", note="second", today=datetime.date(2026, 10, 9))
        self.assertEqual(code, 2)
        self.assertIn("already attested", err)
        with open(st.ATTEST_FILE) as f:
            self.assertEqual(f.read(), before)

    def test_a_corrupt_file_is_never_overwritten(self):
        with open(st.ATTEST_FILE, "w") as f:
            f.write("not json")
        code, err = self.run_attest("phone_store")
        self.assertEqual(code, 2)
        self.assertIn("not a JSON object", err)
        with open(st.ATTEST_FILE) as f:
            self.assertEqual(f.read(), "not json")

    def test_attested_needs_a_real_date(self):
        self.put(st.ATTEST_FILE, {"tablet": {"attested_at": "tomorrow", "note": ""},
                                  "phone_film": {"attested_at": "2026-10-04", "note": ""}})
        self.assertIsNone(st.attested("tablet"))
        self.assertEqual(st.attested("phone_film")["attested_at"], "2026-10-04")
        self.assertIsNone(st.attested("phone_store"))


class PromotionTests(Sandbox):
    def entry(self, **kw):
        base = {"time": "2026-10-20T15:04:05Z", "target": "prod", "git_sha": "c" * 40,
                "branch": "main", "image": "registry.fly.io/myheliograph-api@" + SHA_A,
                "worker_version_id": None, "edge_code_hash": "d" * 64, "dry_run": False}
        base.update(kw)
        return base

    def ledger(self, *lines):
        with open(st.LEDGER_FILE, "w") as f:
            for line in lines:
                f.write((line if isinstance(line, str) else json.dumps(line)) + "\n")

    @staticmethod
    def no_fly():
        raise AssertionError("fly must not be asked here")

    def test_nothing_recorded_is_unchecked(self):
        state, detail = st.check_first_gated_promotion(digests_fn=self.no_fly)
        self.assertEqual(state, "UNCHECKED")
        self.assertIn("deploy.sh", detail)

    def test_newest_ledger_entry_running_on_prod_is_ok(self):
        self.ledger(self.entry(time="2026-10-20T15:04:05Z", git_sha="1" * 40),
                    self.entry(time="2026-10-27T09:00:00Z", git_sha="2" * 40,
                               image="registry.fly.io/myheliograph-api@" + SHA_B))
        state, detail = st.check_first_gated_promotion(digests_fn=lambda: {SHA_B})
        self.assertEqual(state, "OK")
        self.assertIn("ledger", detail)
        self.assertIn("2026-10-20", detail)
        self.assertIn("11111111", detail)

    def test_dry_runs_do_not_count(self):
        self.ledger(self.entry(dry_run=True))
        state, _ = st.check_first_gated_promotion(digests_fn=self.no_fly)
        self.assertEqual(state, "UNCHECKED")

    def test_digest_mismatch_is_unchecked(self):
        self.ledger(self.entry())
        state, detail = st.check_first_gated_promotion(digests_fn=lambda: {SHA_B})
        self.assertEqual(state, "UNCHECKED")
        self.assertIn("not the recorded", detail)

    def test_fly_failure_is_unchecked(self):
        self.ledger(self.entry())
        state, detail = st.check_first_gated_promotion(digests_fn=lambda: None)
        self.assertEqual(state, "UNCHECKED")
        self.assertIn("fly status failed", detail)

    def test_fallback_candidate_running_on_prod_is_ok(self):
        self.put(st.RUN_STATE, {"git_sha": "e" * 40, "image": "registry.fly.io/x@" + SHA_A,
                                "deployed_by_script": True})
        state, detail = st.check_first_gated_promotion(digests_fn=lambda: {SHA_A})
        self.assertEqual(state, "OK")
        self.assertIn("no ledger yet", detail)

    def test_fallback_requires_a_script_made_candidate(self):
        self.put(st.RUN_STATE, {"git_sha": "e" * 40, "image": "registry.fly.io/x@" + SHA_A})
        state, _ = st.check_first_gated_promotion(digests_fn=self.no_fly)
        self.assertEqual(state, "UNCHECKED")

    def test_malformed_and_blank_ledger_lines_are_skipped(self):
        self.ledger("not json", "", self.entry())
        state, _ = st.check_first_gated_promotion(digests_fn=lambda: {SHA_A})
        self.assertEqual(state, "OK")


# --- tests: insert new test classes above this line ---
if __name__ == "__main__":
    unittest.main()
