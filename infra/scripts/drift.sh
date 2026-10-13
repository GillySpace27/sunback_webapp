#!/usr/bin/env bash
# Read-only drift report (MH-6): what Fly and Cloudflare run now, against what the repo says.
#
#   ./infra/scripts/drift.sh
#
# Rows: "OK|DRIFT|UNCHECKED <item>: <detail>", then a summary line. Exit 0 all OK, 1 any
# DRIFT, 3 no DRIFT but something UNCHECKED, 64 when run in CI.
#
# It reads only: `fly machine list`, `fly volumes list`, `fly secrets list` (secret NAMES are
# used; digests are never printed) and `wrangler secret list`. It sets, unsets, scales and
# deploys nothing. Never run it in public CI: it needs local fly and wrangler logins and
# handles secret digests, and it refuses when GITHUB_ACTIONS or CI=true is set.
#
# Expected values: the [[vm]] and [[mounts]] of fly.toml, fly.dev.toml and fly.render.toml
# (so a silent `fly scale` revert shows as DRIFT, the 2026-08-22 incident), exactly one
# machine per app, the secret names in infra/secrets.names (any SHOPIFY_* name on a dev app
# is DRIFT: dev has no Shopify credentials by design), and the cron, routes and dev IS_DEV
# in infra/worker/wrangler.jsonc. The JSON shapes of the fly and wrangler commands were not
# verified when this was written: a shape it does not recognise reads UNCHECKED with key
# names only. wrangler has no read-only listing of triggers or routes, so those are compared
# against the repo's own file here and covered live by the outside probes.
set -uo pipefail
if [ -n "${GITHUB_ACTIONS:-}" ] || [ "${CI:-}" = "true" ]; then
  echo "REFUSING: drift.sh is never run in CI (it needs local fly and wrangler logins and handles secret digests)." >&2
  exit 64
fi
cd "$(dirname "$0")/../.."
PYTHON="${PYTHON:-python3}"
FLY="${FLY:-fly}"
[ -f infra/scripts/pins.env ] && . infra/scripts/pins.env
WRANGLER="${WRANGLER:-npx --yes wrangler${WRANGLER_VERSION:+@$WRANGLER_VERSION}}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/drift.XXXXXX")"
export DRIFT_DIR="$OUT"

keep_json() {  # keep_json <raw> <final>: keep the file only when it parses as JSON
  if "$PYTHON" -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null; then mv "$1" "$2"; fi
}

for app in myheliograph-api myheliograph-api-dev myheliograph-render; do
  "$FLY" machine list --app "$app" --json >"$OUT/$app.machines.raw" 2>/dev/null && keep_json "$OUT/$app.machines.raw" "$OUT/$app.machines.json"
  "$FLY" volumes list --app "$app" --json >"$OUT/$app.volumes.raw" 2>/dev/null && keep_json "$OUT/$app.volumes.raw" "$OUT/$app.volumes.json"
  "$FLY" secrets list --app "$app" --json >"$OUT/$app.secrets.raw" 2>/dev/null && keep_json "$OUT/$app.secrets.raw" "$OUT/$app.secrets.json"
done
( cd infra/worker && $WRANGLER secret list ) >"$OUT/worker.raw" 2>/dev/null && keep_json "$OUT/worker.raw" "$OUT/worker.json"
( cd infra/worker && $WRANGLER secret list --env dev ) >"$OUT/worker-dev.raw" 2>/dev/null && keep_json "$OUT/worker-dev.raw" "$OUT/worker-dev.json"

"$PYTHON" - <<'PY'
import json
import os
import re
import sys

out = os.environ["DRIFT_DIR"]
rows = []


def row(status, item, detail):
    rows.append((status, item, detail))


def jload(name):
    try:
        with open(os.path.join(out, name), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None


def toml_of(path):
    if tomllib is None:
        return None
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except (OSError, ValueError):
        return None


def megabytes(text):
    m = re.fullmatch(r"(\d+)\s*(gb|mb)", str(text).strip().lower())
    return None if not m else int(m.group(1)) * (1024 if m.group(2) == "gb" else 1)


def gigabytes(text):
    m = re.fullmatch(r"(\d+)\s*gb", str(text).strip().lower())
    return None if not m else int(m.group(1))


def expected_secret_names(app):
    found, names = False, set()
    with open("infra/secrets.names", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) != 2 or parts[0] != app:
                continue
            found = True
            if parts[1] != "-":
                names.add(parts[1])
    return names if found else None


def secret_names(data):
    if not isinstance(data, list):
        return None
    names = set()
    for item in data:
        if not isinstance(item, dict):
            return None
        name = item.get("name") or item.get("Name")
        if not name:
            return None
        names.add(str(name))
    return names


def compare_names(item, expected, live):
    if expected is None:
        row("UNCHECKED", item, "the app is not listed in infra/secrets.names")
    elif live is None:
        row("UNCHECKED", item, "could not read the live secret names (command failed or an unknown JSON shape)")
    else:
        missing, extra = sorted(expected - live), sorted(live - expected)
        if missing or extra:
            row("DRIFT", item, "missing live: %s; live but not listed: %s"
                % (", ".join(missing) or "none", ", ".join(extra) or "none"))
        else:
            row("OK", item, "%d names match infra/secrets.names" % len(live))


APPS = (("myheliograph-api", "fly.toml", False),
        ("myheliograph-api-dev", "fly.dev.toml", True),
        ("myheliograph-render", "fly.render.toml", False))

for app, tomlfile, is_dev in APPS:
    cfg = toml_of(tomlfile)
    machines = jload(app + ".machines.json")
    if isinstance(machines, dict):
        machines = machines.get("Machines")
    if not isinstance(machines, list):
        row("UNCHECKED", "machines " + app, "`fly machine list` gave nothing readable")
    elif len(machines) != 1:
        row("DRIFT", "machines " + app, "%d machines; the repo says exactly 1 (one uvicorn worker, one volume)" % len(machines))
    else:
        row("OK", "machines " + app, "1 machine")

    if cfg is None:
        row("UNCHECKED", "vm " + app, "could not parse %s (needs Python 3.11 tomllib)" % tomlfile)
    elif not cfg.get("vm"):
        row("UNCHECKED", "vm " + app, "%s has no [[vm]]" % tomlfile)
    elif not isinstance(machines, list) or not machines:
        row("UNCHECKED", "vm " + app, "no machine to read")
    else:
        vm = cfg["vm"][0]
        want = (megabytes(vm.get("memory")), vm.get("cpus"), vm.get("cpu_kind"))
        got_list, shape_ok = [], True
        for m in machines:
            guest = ((m.get("config") or {}).get("guest")) if isinstance(m, dict) else None
            if not isinstance(guest, dict):
                shape_ok = False
                break
            got_list.append((guest.get("memory_mb"), guest.get("cpus"), guest.get("cpu_kind")))
        if not shape_ok:
            keys = sorted(machines[0]) if isinstance(machines[0], dict) else []
            row("UNCHECKED", "vm " + app, "machine JSON has no config.guest (top-level keys: %s)" % ", ".join(keys))
        elif any(g != want for g in got_list):
            g = next(g for g in got_list if g != want)
            row("DRIFT", "vm " + app, "live %s MB, %s cpus, %s; %s says %s MB, %s cpus, %s"
                % (g[0], g[1], g[2], tomlfile, want[0], want[1], want[2]))
        else:
            row("OK", "vm " + app, "%s MB, %s cpus, %s match %s" % (want[0], want[1], want[2], tomlfile))

    vols = jload(app + ".volumes.json")
    if cfg is None or not isinstance(vols, list):
        row("UNCHECKED", "volume " + app, "no readable volume list or toml")
    else:
        mounts = cfg.get("mounts") or []
        want_sizes = [gigabytes(mounts[0].get("initial_size"))] if mounts else []
        sizes = []
        for v in vols:
            size = v.get("size_gb", v.get("SizeGb", v.get("size"))) if isinstance(v, dict) else None
            sizes.append(size)
        if any(not isinstance(s, int) or isinstance(s, bool) for s in sizes):
            keys = sorted(vols[0]) if vols and isinstance(vols[0], dict) else []
            row("UNCHECKED", "volume " + app, "volume JSON size key not recognised (keys: %s)" % ", ".join(keys))
        elif sorted(sizes) != sorted(want_sizes):
            row("DRIFT", "volume " + app, "live volumes %s GB, %s says %s GB" % (sizes or "none", tomlfile, want_sizes or "none"))
        else:
            row("OK", "volume " + app, "%s GB volume(s) match %s" % (sizes or "no", tomlfile))

    live = secret_names(jload(app + ".secrets.json"))
    compare_names("secrets " + app, expected_secret_names(app), live)
    if is_dev:
        if live is None:
            row("UNCHECKED", "no-shopify " + app, "could not read the live secret names")
        else:
            shop = sorted(n for n in live if n.startswith("SHOPIFY_"))
            if shop:
                row("DRIFT", "no-shopify " + app, "%s (dev has no Shopify credentials by design)" % ", ".join(shop))
            else:
                row("OK", "no-shopify " + app, "no SHOPIFY_* secret on dev")

for worker, fname in (("myheliograph-router", "worker.json"), ("myheliograph-router-dev", "worker-dev.json")):
    compare_names("worker-secrets " + worker, expected_secret_names(worker), secret_names(jload(fname)))


def strip_jsonc(text):
    res, i, n, in_str = [], 0, len(text), False
    while i < n:
        c = text[i]
        if in_str:
            res.append(c)
            if c == "\\" and i + 1 < n:
                res.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            res.append(c)
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            res.append(c)
            i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(res))


try:
    with open("infra/worker/wrangler.jsonc", encoding="utf-8") as f:
        wr = json.loads(strip_jsonc(f.read()))
except (OSError, ValueError):
    wr = None
if wr is None:
    row("UNCHECKED", "worker-config", "could not parse infra/worker/wrangler.jsonc")
else:
    problems = []
    if (wr.get("triggers") or {}).get("crons") != ["17 */6 * * *"]:
        problems.append('prod cron is not ["17 */6 * * *"]')
    prod_routes = {r.get("pattern") for r in (wr.get("routes") or []) if isinstance(r, dict)}
    if not {"myheliograph.com", "www.myheliograph.com"} <= prod_routes:
        problems.append("prod routes lack myheliograph.com or www.myheliograph.com")
    dev = (wr.get("env") or {}).get("dev") or {}
    if (dev.get("triggers") or {}).get("crons") != []:
        problems.append("dev has a cron (the sweep must run once, from prod)")
    if "dev.myheliograph.com" not in {r.get("pattern") for r in (dev.get("routes") or []) if isinstance(r, dict)}:
        problems.append("dev route dev.myheliograph.com is missing")
    if (dev.get("vars") or {}).get("IS_DEV") != "1":
        problems.append("dev IS_DEV is not 1")
    row("DRIFT" if problems else "OK", "worker-config",
        "; ".join(problems) or "prod cron and routes and dev IS_DEV match the file's own comments")

for status, item, detail in rows:
    print("%s %s: %s" % (status, item, detail))
drift = sum(1 for r in rows if r[0] == "DRIFT")
unchecked = sum(1 for r in rows if r[0] == "UNCHECKED")
print("drift.sh: %d OK, %d DRIFT, %d UNCHECKED" % (len(rows) - drift - unchecked, drift, unchecked))
sys.exit(1 if drift else 3 if unchecked else 0)
PY
