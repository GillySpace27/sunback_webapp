"""Self-check for infra/scripts/drift.sh (MH-6).

Run: python3 api/scripts/test_drift.py

No network: FLY and WRANGLER are fakes that print canned JSON. The expected values come from
the real fly*.toml, wrangler.jsonc and infra/secrets.names, so the "everything matches"
case fails if the repo and the fake disagree. Pins: a wrong VM size, a second machine, a
Shopify name on dev, an unlisted secret and a missing volume are DRIFT; unreadable output is
UNCHECKED (exit 3), never OK; secret digests are never printed; CI is refused.
"""
import json
import os
import re
import stat
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DRIFT = ROOT / "infra" / "scripts" / "drift.sh"

FAKE_FLY = r'''#!/usr/bin/env bash
app="$4"
case "$1 $2" in
  "machine list") f="$FAKE_DIR/$app.machines.json" ;;
  "volumes list") f="$FAKE_DIR/$app.volumes.json" ;;
  "secrets list") f="$FAKE_DIR/$app.secrets.json" ;;
  *) exit 2 ;;
esac
[ -f "$f" ] && cat "$f" || exit 1
'''

FAKE_WRANGLER = r'''#!/usr/bin/env bash
case " $* " in
  *" --env dev "*) f="$FAKE_DIR/worker-dev.json" ;;
  *) f="$FAKE_DIR/worker.json" ;;
esac
[ -f "$f" ] && cat "$f" || exit 1
'''

APPS = {"myheliograph-api": "fly.toml", "myheliograph-api-dev": "fly.dev.toml",
        "myheliograph-render": "fly.render.toml"}


def expected_names(app):
    names = set()
    for line in (ROOT / "infra" / "secrets.names").read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and not line.startswith("#") and parts[0] == app and parts[1] != "-":
            names.add(parts[1])
    return names


def secrets_json(names):
    return [{"name": n, "digest": "DO-NOT-PRINT-0123", "created_at": "2026-08-22T00:00:00Z"} for n in sorted(names)]


class DriftTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mh6drift-"))
        for name, body in (("fly", FAKE_FLY), ("wrangler", FAKE_WRANGLER)):
            p = self.tmp / name
            p.write_text(body)
            p.chmod(p.stat().st_mode | stat.S_IEXEC)
        for app, tomlfile in APPS.items():
            cfg = tomllib.loads((ROOT / tomlfile).read_text())
            vm = cfg["vm"][0]
            mem = int(re.match(r"(\d+)gb", vm["memory"]).group(1)) * 1024
            self.write(app + ".machines.json", [{"id": "m1", "state": "stopped", "config": {
                "guest": {"cpu_kind": vm["cpu_kind"], "cpus": vm["cpus"], "memory_mb": mem}}}])
            mounts = cfg.get("mounts")
            vols = [{"id": "vol_1", "name": "data", "size_gb": int(re.match(r"(\d+)gb", mounts[0]["initial_size"]).group(1))}] if mounts else []
            self.write(app + ".volumes.json", vols)
            self.write(app + ".secrets.json", secrets_json(expected_names(app)))
        self.write("worker.json", [{"name": n, "type": "secret_text"} for n in sorted(expected_names("myheliograph-router"))])
        self.write("worker-dev.json", [])

    def write(self, name, obj):
        (self.tmp / name).write_text(json.dumps(obj))

    def run_drift(self, **extra):
        env = dict(os.environ, FLY=str(self.tmp / "fly"), WRANGLER=str(self.tmp / "wrangler"),
                   FAKE_DIR=str(self.tmp), PYTHON=os.environ.get("PYTHON", "python3"))
        env.pop("GITHUB_ACTIONS", None)
        env.pop("CI", None)
        env.update(extra)
        return subprocess.run(["bash", str(DRIFT)], env=env, capture_output=True, text=True, timeout=120)

    def test_everything_matching_is_all_ok_and_exits_0(self):
        r = self.run_drift()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotRegex(r.stdout, r"(?m)^(DRIFT|UNCHECKED) ")
        self.assertIn("OK machines myheliograph-api:", r.stdout)
        self.assertIn("OK worker-config:", r.stdout)

    def test_a_silently_reverted_vm_size_is_drift(self):
        cfg = json.loads((self.tmp / "myheliograph-api.machines.json").read_text())
        cfg[0]["config"]["guest"]["memory_mb"] = 2048
        self.write("myheliograph-api.machines.json", cfg)
        r = self.run_drift()
        self.assertEqual(r.returncode, 1)
        self.assertRegex(r.stdout, r"DRIFT vm myheliograph-api: .*2048")

    def test_a_second_machine_is_drift(self):
        cfg = json.loads((self.tmp / "myheliograph-api.machines.json").read_text())
        self.write("myheliograph-api.machines.json", cfg + cfg)
        r = self.run_drift()
        self.assertEqual(r.returncode, 1)
        self.assertIn("DRIFT machines myheliograph-api:", r.stdout)

    def test_a_different_volume_size_is_drift(self):
        vols = json.loads((self.tmp / "myheliograph-api.volumes.json").read_text())
        vols[0]["size_gb"] = 5
        self.write("myheliograph-api.volumes.json", vols)
        r = self.run_drift()
        self.assertEqual(r.returncode, 1)
        self.assertIn("DRIFT volume myheliograph-api:", r.stdout)

    def test_shopify_credentials_on_dev_are_drift_and_named(self):
        names = expected_names("myheliograph-api-dev") | {"SHOPIFY_STORE_DOMAIN"}
        self.write("myheliograph-api-dev.secrets.json", secrets_json(names))
        r = self.run_drift()
        self.assertEqual(r.returncode, 1)
        self.assertIn("DRIFT no-shopify myheliograph-api-dev: SHOPIFY_STORE_DOMAIN", r.stdout)

    def test_an_unlisted_secret_is_drift_by_name_and_no_digest_is_printed(self):
        names = expected_names("myheliograph-api") | {"MYSTERY_KEY"}
        self.write("myheliograph-api.secrets.json", secrets_json(names))
        r = self.run_drift()
        self.assertEqual(r.returncode, 1)
        self.assertIn("MYSTERY_KEY", r.stdout)
        self.assertNotIn("DO-NOT-PRINT", r.stdout + r.stderr)

    def test_a_missing_secret_is_drift(self):
        names = expected_names("myheliograph-api") - {"PRINTIFY_API_KEY"}
        self.write("myheliograph-api.secrets.json", secrets_json(names))
        r = self.run_drift()
        self.assertEqual(r.returncode, 1)
        self.assertIn("missing live: PRINTIFY_API_KEY", r.stdout)

    def test_unreadable_output_is_unchecked_and_exits_3_never_ok(self):
        (self.tmp / "myheliograph-render.machines.json").unlink()
        (self.tmp / "worker-dev.json").unlink()
        r = self.run_drift()
        self.assertEqual(r.returncode, 3, r.stdout)
        self.assertIn("UNCHECKED machines myheliograph-render:", r.stdout)
        self.assertIn("UNCHECKED worker-secrets myheliograph-router-dev:", r.stdout)
        self.assertNotRegex(r.stdout, r"(?m)^DRIFT ")

    def test_it_refuses_to_run_in_ci(self):
        r = self.run_drift(GITHUB_ACTIONS="true")
        self.assertEqual(r.returncode, 64)
        self.assertIn("REFUSING", r.stderr)


if __name__ == "__main__":
    unittest.main()
