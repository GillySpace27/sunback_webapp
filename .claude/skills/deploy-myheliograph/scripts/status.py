#!/usr/bin/env python3
"""Tiered-deploy progress tracker for myheliograph.com.

Checks REAL external state — the live sites, the Fly machines' actual image
digests, the files on disk — rather than trusting what an earlier turn in the
conversation claimed to have done.

The load-bearing check is `promoted`: it compares the image digest production
is *actually running* against the digest recorded when dev was deployed and
reviewed. That is the one fact the whole two-tier structure exists to
guarantee, so it is the one fact that must never be self-reported.

Usage:
    python3 status.py [--done captured,panel] [--json]
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

# ─────────────────────────── CONFIG ───────────────────────────

TITLE = "Deploy myheliograph.com (dev → gate → prod)"

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
RUN_STATE = os.path.join(REPO, ".deploy-run.json")
SHOTS = os.path.join(REPO, ".deploy-shots")

SUBTITLE_CMD = (
    f"cd {REPO} && python3 -c \"import json;d=json.load(open('.deploy-run.json'));"
    f"print('candidate ' + d['git_sha'][:8] + '  ' + d['image'].split('@')[-1][:19])\" 2>/dev/null"
)

# Fetch a dev path, falling back to the workers.dev hostname.
#
# Both names serve the SAME worker + the same asset upload, so either proves
# the deployment. The fallback exists because NWRA's network refuses to
# forward to dev.myheliograph.com (`X-Squid-Error: ERR_CANNOT_FORWARD`,
# 2026-08-22) while the domain resolves and works fine from outside. Without
# it this tracker would sit permanently red on Gilly's own machine, which
# would just teach him to ignore it — a red tracker nobody believes is worse
# than no tracker.
_DEV_HOSTS = "https://dev.myheliograph.com https://myheliograph-router-dev.gilly-22d.workers.dev"
_DEV_CURL = (
    'p="$0"; for h in ' + _DEV_HOSTS + '; do '
    'curl -fsS --max-time 30 "$h$p" && exit 0; done; exit 1'
)
_DEV_CURL = f"sh -c '{_DEV_CURL}'"

# Compare the digest prod is RUNNING against the recorded candidate digest.
# Any mismatch — a rebuild, a hand-run `fly deploy`, a stale record — reads as
# not-promoted, which is the safe direction to be wrong in.
_PROMOTED_CHECK = f"""
cd {REPO} && python3 - <<'EOF'
import json, subprocess, sys
try:
    want = json.load(open(".deploy-run.json"))["image"].split("@")[-1]
except Exception:
    sys.exit(1)
out = subprocess.run(
    ["fly", "status", "--app", "myheliograph-api", "--json"],
    capture_output=True, text=True, timeout=45)
if out.returncode != 0:
    sys.exit(1)
machines = json.loads(out.stdout).get("Machines") or []
got = {{m.get("image_ref", {{}}).get("digest") for m in machines}}
sys.exit(0 if want in got else 1)
EOF
"""

# Dev running a digest that .deploy-run.json does not record means someone
# ran `fly deploy` by hand (the 2026-09-15 dev deploy was one), so the record
# no longer describes dev and a promotion would ship an unrecorded image.
# Every dev machine must run the recorded digest; no machines reads as red.
_DEV_DRIFT_CHECK = f"""
cd {REPO} && python3 - <<'EOF'
import json, subprocess, sys
try:
    want = json.load(open(".deploy-run.json"))["image"].split("@")[-1]
except Exception:
    sys.exit(1)
out = subprocess.run(
    ["fly", "status", "--app", "myheliograph-api-dev", "--json"],
    capture_output=True, text=True, timeout=45)
if out.returncode != 0:
    sys.exit(1)
machines = json.loads(out.stdout).get("Machines") or []
got = {{m.get("image_ref", {{}}).get("digest") for m in machines}}
sys.exit(0 if got == {{want}} else 1)
EOF
"""

# (key, label, check)
MILESTONES = [
    ("preflight", "Preflight: tree clean, typecheck passes",
     f"cd {REPO} && test -z \"$(git status --porcelain)\" && (cd web3d && npm run typecheck >/dev/null 2>&1)"),

    ("dev", "Dev deployed and serving",
     f"{_DEV_CURL} /api/health >/dev/null"),

    ("dev_drift", "Dev runs the recorded candidate digest (red: out-of-band deploy, re-run deploy.sh)",
     _DEV_DRIFT_CHECK.strip()),

    # Checks the META TAG, not robots.txt. Measured 2026-08-22: Cloudflare
    # prepends its own managed robots.txt containing `User-agent: * / Allow: /`,
    # which merges with ours and WINS the equal-specificity tie — so a
    # robots.txt check here would have reported green while the tier was in
    # fact indexable. The meta tag cannot be rewritten by the zone, and
    # noindex is the stronger signal anyway (robots.txt blocks crawling;
    # Google will still index a URL it was never allowed to read).
    #
    # /experience/ specifically, because that page is built by a different
    # pipeline than the store and was the one the injector originally missed.
    ("noindex", "Dev is un-indexable (noindex meta on /experience/)",
     f"{_DEV_CURL} /experience/ | grep -qi 'name=\"robots\"[^>]*noindex'"),

    ("captured", "Evidence captured from BOTH tiers",
     f"test -d {SHOTS}/prod && test -d {SHOTS}/dev "
     f"&& test $(ls {SHOTS}/dev/*.png 2>/dev/null | wc -l) -ge 4 "
     f"&& test $(ls {SHOTS}/prod/*.png 2>/dev/null | wc -l) -ge 4"),

    # Session-only: the panel's verdict is a judgement, not a queryable fact.
    # Passed in via --done panel ONLY after the adjudicated result is in hand.
    ("panel", "Review panel run and adjudicated (regression = blocking)", None),

    ("promoted", "Prod running the REVIEWED image digest", _PROMOTED_CHECK.strip()),

    # Deliberately ANDed with the digest check. On its own, "prod answers
    # /api/health" is green before the deploy even starts — production is
    # always up — which would show a reassuring tick for work not yet done.
    # Health alone is also not enough after a promotion: the digest can land
    # and the app still crash-loop or the edge still serve the old frontend.
    ("live", "Prod healthy AND serving the promoted build",
     f"({_PROMOTED_CHECK.strip()}) "
     "&& curl -fsS --max-time 25 https://myheliograph.com/api/health >/dev/null "
     "&& curl -fsS --max-time 25 -o /dev/null https://myheliograph.com/"),
]

# HOW to advance each step: (kind, text). Taken verbatim from DEPLOY.md rather
# than paraphrased — a command that only looks right is worse than none, and
# this renders on the Orrery's runbooks page where it will be copied.
#
# The KIND says who can act:
#   shell  needs a real Claude Code session; the Orrery has no shell by design
#   panel  a judgement, not a command — the codex-loop review
#   gate   shown so you can SEE what would happen; never given a run affordance
HOW = {
    "preflight": ("shell",
        "source ~/.claude/secrets/solar-archive.env   # FEEDBACK_ADMIN_KEY\n"
        "git status --porcelain      # must be clean for prod; dirty is allowed on dev\n"
        "( cd web3d && npm run typecheck )"),

    "dev": ("shell",
        "TARGET=dev ADMIN_KEY=$FEEDBACK_ADMIN_KEY ./infra/scripts/deploy.sh\n"
        "# writes .deploy-run.json (git SHA + image digest) — that file is what makes\n"
        "# the promotion in step 4 verifiable"),

    "dev_drift": ("shell",
        "# out-of-band deploy, re-run deploy.sh: dev runs a digest .deploy-run.json does not record\n"
        "TARGET=dev ADMIN_KEY=$FEEDBACK_ADMIN_KEY ./infra/scripts/deploy.sh"),

    "noindex": ("shell",
        "curl -fsS https://dev.myheliograph.com/experience/ | grep -i 'name=\"robots\"'\n"
        "# check the META TAG, not robots.txt: Cloudflare prepends its own managed\n"
        "# robots.txt whose Allow wins the equal-specificity tie"),

    "captured": ("shell",
        "# warm both tiers first — a cold Fly machine on one side reads as a regression\n"
        "node web3d/tools/capture-pages.mjs https://myheliograph.com     .deploy-shots/prod\n"
        "node web3d/tools/capture-pages.mjs https://dev.myheliograph.com .deploy-shots/dev\n"
        "# CAPTURE_SETTLE_MS=12000 if the two disagree in the thumbnail region"),

    "panel": ("panel",
        "Invoke the codex-loop skill in PANEL mode. Standing lenses: regression (blocking), "
        "presentation, accessibility, conversion-funnel, plus safety-claims IF the diff "
        "touches customer-facing copy. Only a CONFIRMED regression blocks; everything else "
        "reports to TODOS.md. Pass --done panel once the adjudicated result is in hand."),

    "promoted": ("gate",
        "Promote to production. Never without asking Gilly in chat, this deploy — a yes for "
        "one never carries to the next. Say plainly what goes live: 'this will make commit "
        "<sha> live on myheliograph.com for real customers.'\n"
        "TARGET=prod ADMIN_KEY=$FEEDBACK_ADMIN_KEY ./infra/scripts/deploy.sh"),

    "live": ("shell",
        "python3 .claude/skills/deploy-myheliograph/scripts/status.py\n"
        "# compares prod's running digest against the recorded candidate; if they differ,\n"
        "# the promotion did not ship what was reviewed.\n"
        "# rollback: fly releases --app myheliograph-api && fly deploy --config fly.toml \\\n"
        "#           --app myheliograph-api --image <previous digest>"),
}

GATED = {"promoted"}

FOOTER_CMD = (
    "fly status --app myheliograph-api --json 2>/dev/null | python3 -c "
    "\"import json,sys;m=(json.load(sys.stdin).get('Machines') or [{}])[0];"
    "r=m.get('image_ref',{});print(m.get('state','?')+'  '+r.get('digest','?')[:19])\" 2>/dev/null"
)
FOOTER_LABEL = "prod machine"

# ───────────────────────── END CONFIG ─────────────────────────

BAR_WIDTH = 20


def run_ok(cmd):
    """True when the command exits 0. Never raises; a broken check reads as
    'not done', which is the safe direction to fail."""
    try:
        return subprocess.run(cmd, shell=True, capture_output=True,
                              timeout=120).returncode == 0
    except Exception:
        return False


def run_out(cmd):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True,
                           text=True, timeout=120)
        return r.stdout.strip()
    except Exception:
        return ""


def evaluate(done_keys):
    state = {}
    for key, _label, check in MILESTONES:
        state[key] = key in done_keys if check is None else run_ok(check)
    return state


def render(state):
    total = len(MILESTONES)
    done = sum(1 for k, _, _ in MILESTONES if state.get(k))
    filled = round(BAR_WIDTH * done / total) if total else 0
    bar = "█" * filled + "░" * (BAR_WIDTH - filled)

    lines = [TITLE]
    if SUBTITLE_CMD:
        sub = run_out(SUBTITLE_CMD)
        if sub:
            lines.append(sub)
    lines.append(f"[{bar}] {done}/{total}")
    lines.append("")

    pointed = False
    for key, label, _ in MILESTONES:
        suffix = "  (gated: needs your go-ahead)" if key in GATED else ""
        if state.get(key):
            mark = "✅"
        elif not pointed:
            mark = "▶"
            pointed = True
        else:
            mark = "⬜"
        lines.append(f"{mark} {label}{suffix}")
        # Only the NEXT step shows its how-to: all of them at once turns a
        # status read into a wall of commands.
        if mark == "▶" and key in HOW:
            kind, how = HOW[key]
            for i, ln in enumerate(how.split("\n")):
                lines.append(f"      {'[' + kind + '] ' if i == 0 else '      '}{ln}")

    if FOOTER_CMD:
        raw = run_out(FOOTER_CMD)
        if raw:
            lines.append("")
            lines.append(f"({FOOTER_LABEL}: {raw})")

    return "\n".join(lines)


# >>> launch-gate (MH-5) >>>
# LAUNCH GATE: what must be true before any ad spend.
#
# MILESTONES above track ONE deploy. These track the one-time launch. Each
# item is OK (verified from real external state, or attested by Gilly with a
# date) or UNCHECKED (nothing proves it yet). There is no "failed" state on
# purpose: an unverifiable step is UNCHECKED, neither done nor failed, and
# nothing here reports a step done on its own say-so. An agent never makes the
# test purchase, never enters payment details, never accepts the cookie banner
# and never runs --attest (LAUNCH_REVIEW.md section 6).

ATTEST_FILE = os.path.join(REPO, ".launch-attest.json")
HQ_FILE = os.path.join(REPO, ".launch-hq.json")
LEDGER_FILE = os.path.join(REPO, ".deploy-ledger.jsonl")
ATTESTABLE = {"test_purchase", "sentry_event", "phone_store", "phone_film",
              "tablet", "hq_4gb"}
PROD_APP = "myheliograph-api"
LAUNCH_OK = "OK"
LAUNCH_UNCHECKED = "UNCHECKED"
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _launch_json_file(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load_attest():
    data = _launch_json_file(ATTEST_FILE, {})
    return data if isinstance(data, dict) else {}


def attested(key):
    """The attest record for key when it carries a real YYYY-MM-DD date, else None."""
    rec = load_attest().get(key)
    if isinstance(rec, dict) and _DATE_RE.fullmatch(str(rec.get("attested_at", ""))):
        return rec
    return None


def attest(key, note="", today=None, input_fn=input, is_tty=None):
    """Write one dated attestation. Returns an exit code: 0 written, 2 refused.

    Refuses without a terminal (an agent has none), asks Gilly to type the key,
    never overwrites an existing key and never overwrites a file it cannot read
    as a JSON object. Delete nothing: changing an attestation is done by hand.
    """
    def refuse(why):
        print("refusing: " + why, file=sys.stderr)
        return 2

    if key not in ATTESTABLE:
        return refuse("%r cannot be attested. Attestable: %s. first_gated_promotion is "
                      "verified from the digest prod runs, or not at all."
                      % (key, ", ".join(sorted(ATTESTABLE))))
    tty = sys.stdin.isatty() if is_tty is None else is_tty
    if not tty:
        return refuse("--attest is typed by Gilly at a terminal. An agent never attests.")
    existing = {}
    if os.path.exists(ATTEST_FILE):
        existing = _launch_json_file(ATTEST_FILE, None)
        if not isinstance(existing, dict):
            return refuse("%s exists but is not a JSON object; fix it by hand, it is never overwritten."
                          % os.path.basename(ATTEST_FILE))
    if key in existing:
        prev = existing[key]
        when = prev.get("attested_at", "?") if isinstance(prev, dict) else "?"
        return refuse("%s was already attested on %s. Edit %s by hand to change it."
                      % (key, when, os.path.basename(ATTEST_FILE)))
    try:
        answer = input_fn("Type %s to confirm you did this yourself: " % key)
    except EOFError:
        answer = ""
    if answer.strip() != key:
        return refuse("confirmation did not match; nothing written.")
    day = (today or datetime.date.today()).isoformat()
    existing[key] = {"attested_at": day, "note": note or ""}
    tmp = ATTEST_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(existing, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, ATTEST_FILE)
    print("attested %s on %s" % (key, day))
    return 0


def launch_prod_digests():
    """Image digests prod's machines run now (a set), or None when fly cannot say."""
    try:
        r = subprocess.run(["fly", "status", "--app", PROD_APP, "--json"],
                           capture_output=True, text=True, timeout=45)
        if r.returncode != 0:
            return None
        machines = json.loads(r.stdout).get("Machines") or []
        return {m.get("image_ref", {}).get("digest") for m in machines} - {None}
    except Exception:
        return None


def ledger_prod_entries():
    """Real (not dry-run) prod entries of MH-8's append-only ledger, oldest first.
    An absent ledger, or lines that are not JSON objects, give []."""
    out = []
    try:
        with open(LEDGER_FILE) as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(entry, dict) and entry.get("target") == "prod"
                        and entry.get("dry_run") is not True):
                    out.append(entry)
    except OSError:
        return []
    return out


def check_first_gated_promotion(digests_fn=None):
    """(state, detail). OK when the image of the newest real prod promotion is
    the one prod runs now. Reads MH-8's ledger when it has a prod entry; until
    then reads .deploy-run.json (the dev candidate that deploy.sh TARGET=prod
    promotes) and requires deployed_by_script, so a hand-made record never counts."""
    digests_fn = digests_fn or launch_prod_digests
    entries = ledger_prod_entries()
    if entries:
        newest = entries[-1]
        want = str(newest.get("image", "")).split("@")[-1]
        origin = "ledger: first prod entry %s %s, newest %s" % (
            str(entries[0].get("time", "?"))[:10], str(entries[0].get("git_sha", "?"))[:8],
            str(newest.get("git_sha", "?"))[:8])
    else:
        run = _launch_json_file(RUN_STATE, {})
        if not isinstance(run, dict) or run.get("deployed_by_script") is not True:
            return (LAUNCH_UNCHECKED, "no prod entry in the ledger and no script-made candidate; "
                                      "promote through infra/scripts/deploy.sh TARGET=prod")
        want = str(run.get("image", "")).split("@")[-1]
        origin = "no ledger yet: candidate %s from .deploy-run.json" % str(run.get("git_sha", "?"))[:8]
    if not want.startswith("sha256:"):
        return (LAUNCH_UNCHECKED, "the recorded image carries no sha256 digest")
    got = digests_fn()
    if got is None:
        return (LAUNCH_UNCHECKED, "fly status failed; cannot read the digest prod runs")
    if want in got:
        return (LAUNCH_OK, "prod runs %s (%s)" % (want[:19], origin))
    return (LAUNCH_UNCHECKED, "prod runs %s, not the recorded %s (%s)"
            % (", ".join(sorted(d[:19] for d in got)) or "nothing", want[:19], origin))


# Shopify: a read-only Admin GraphQL query for the order Gilly places himself.
# The store domain and API version are the defaults in api/shopify_storefront.py
# (L30, L175). The app's existing Admin scopes (L165-166) do not include
# read_orders, so this needs a read-only token Gilly creates himself (Q21);
# without LAUNCH_SHOPIFY_READ_TOKEN the item stays UNCHECKED and is attested.
# The query text and field names are written from knowledge of the Admin
# GraphQL API and were not run against the store.
SHOPIFY_DOMAIN = "solar-archive.myshopify.com"
SHOPIFY_API_VERSION = "2024-10"
LAUNCH_ORDER_SINCE = "2026-10-01"
OLD_TEST_TITLE = "[PHASE1-TEST]"
PAID_STATES = {"PAID", "PARTIALLY_REFUNDED", "REFUNDED"}
_EMAIL_RE = re.compile(r"[^\s\"'\\]+@[^\s\"'\\]+")
_ORDERS_QUERY = """query LaunchTestOrder($q: String!) {
  orders(first: 10, query: $q, sortKey: CREATED_AT, reverse: true) {
    edges { node {
      name createdAt cancelledAt displayFinancialStatus
      lineItems(first: 10) { edges { node { title } } }
    } }
  }
}"""


def _shopify_orders(token, search):
    """[{"name","created","cancelled","status","titles"}]; raises on transport or GraphQL errors."""
    req = urllib.request.Request(
        "https://%s/admin/api/%s/graphql.json" % (SHOPIFY_DOMAIN, SHOPIFY_API_VERSION),
        data=json.dumps({"query": _ORDERS_QUERY, "variables": {"q": search}}).encode(),
        headers={"Content-Type": "application/json", "X-Shopify-Access-Token": token},
        method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = json.load(resp)
    if body.get("errors"):
        raise RuntimeError("graphql errors")
    edges = ((body.get("data") or {}).get("orders") or {}).get("edges") or []
    out = []
    for edge in edges:
        node = edge.get("node") or {}
        items = (node.get("lineItems") or {}).get("edges") or []
        out.append({"name": node.get("name") or "?",
                    "created": node.get("createdAt") or "",
                    "cancelled": bool(node.get("cancelledAt")),
                    "status": node.get("displayFinancialStatus") or "",
                    "titles": [(i.get("node") or {}).get("title") or "" for i in items]})
    return out


def check_test_purchase(env=None, fetch=None):
    """(state, detail). OK only when a paid, uncancelled order from the address
    in LAUNCH_TEST_EMAIL exists on or after LAUNCH_TEST_SINCE and none of its
    items is the old [PHASE1-TEST] product (Q8). Never prints the token or the
    address."""
    env = os.environ if env is None else env
    token = env.get("LAUNCH_SHOPIFY_READ_TOKEN", "").strip()
    if not token:
        return (LAUNCH_UNCHECKED, "no LAUNCH_SHOPIFY_READ_TOKEN (a read_orders token, Q21); "
                                  "after the purchase run status.py --attest test_purchase")
    email = env.get("LAUNCH_TEST_EMAIL", "").strip()
    if not _EMAIL_RE.fullmatch(email):
        return (LAUNCH_UNCHECKED, "set LAUNCH_TEST_EMAIL to the address you will use at checkout")
    since = env.get("LAUNCH_TEST_SINCE", "").strip() or LAUNCH_ORDER_SINCE
    if not _DATE_RE.fullmatch(since):
        return (LAUNCH_UNCHECKED, "LAUNCH_TEST_SINCE must be YYYY-MM-DD")
    search = "email:%s created_at:>=%s" % (email, since)
    try:
        orders = (fetch or _shopify_orders)(token, search)
    except urllib.error.HTTPError as e:
        return (LAUNCH_UNCHECKED, "Shopify answered HTTP %d (token or scope?)" % e.code)
    except Exception as e:
        return (LAUNCH_UNCHECKED, "Shopify query failed (%s); scope or token?" % type(e).__name__)
    for o in orders:
        if o["cancelled"] or o["status"] not in PAID_STATES:
            continue
        if any(OLD_TEST_TITLE.lower() in t.lower() for t in o["titles"]):
            continue
        return (LAUNCH_OK, "order %s created %s, %s" % (o["name"], o["created"][:10], o["status"]))
    return (LAUNCH_UNCHECKED, "no paid, uncancelled order since %s from the test address" % since)


# Sentry: the project and the test event are the ones named in LAUNCH_REVIEW.md
# section 5 (org sunny-days, project my-heliograph, "Launch-verification test
# event from Claude"). The API path is written from knowledge of Sentry's REST
# API and was not run; a wrong path reads UNCHECKED, never OK.
SENTRY_ORG = "sunny-days"
SENTRY_PROJECT = "my-heliograph"
SENTRY_MARKER = "Launch-verification test event"


def _sentry_titles(token):
    req = urllib.request.Request(
        "https://sentry.io/api/0/projects/%s/%s/events/" % (SENTRY_ORG, SENTRY_PROJECT),
        headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    if not isinstance(data, list):
        raise ValueError("unexpected response shape")
    return [str(e.get("title") or e.get("message") or "") for e in data if isinstance(e, dict)]


def check_sentry_event(env=None, fetch=None):
    env = os.environ if env is None else env
    token = env.get("LAUNCH_SENTRY_TOKEN", "").strip()
    if not token:
        return (LAUNCH_UNCHECKED, "no LAUNCH_SENTRY_TOKEN (a Sentry read token, Q21); look for %r in "
                                  "the Issues feed, then status.py --attest sentry_event" % SENTRY_MARKER)
    try:
        titles = (fetch or _sentry_titles)(token)
    except urllib.error.HTTPError as e:
        return (LAUNCH_UNCHECKED, "Sentry answered HTTP %d" % e.code)
    except Exception as e:
        return (LAUNCH_UNCHECKED, "Sentry query failed (%s)" % type(e).__name__)
    if any(SENTRY_MARKER.lower() in t.lower() for t in titles):
        return (LAUNCH_OK, "found %r in project %s" % (SENTRY_MARKER, SENTRY_PROJECT))
    return (LAUNCH_UNCHECKED, "no event titled like %r among the newest events" % SENTRY_MARKER)


# HQ re-test on the 4 GB origin. infra/scripts/hq_retest.py renders once on dev
# and appends a run to .launch-hq.json; this check only reads that record and
# re-verifies, from real state, that dev still serves the recorded master at
# the recorded size. A cache hit, a failure or a vanished file is UNCHECKED.
DEV_BASES = ("https://dev.myheliograph.com",
             "https://myheliograph-router-dev.gilly-22d.workers.dev")
_ASSET_RE = re.compile(r"/asset/[A-Za-z0-9_.-]+\.png")


def _launch_content_length(base, path):
    try:
        with urllib.request.urlopen(base.rstrip("/") + path, timeout=30) as resp:
            value = resp.headers.get("Content-Length")
        return int(value) if value else None
    except Exception:
        return None


def check_hq_4gb(head_fn=None):
    head_fn = head_fn or _launch_content_length
    rec = _launch_json_file(HQ_FILE, {})
    runs = rec.get("runs") if isinstance(rec, dict) else None
    good = [r for r in (runs or []) if isinstance(r, dict) and r.get("ok") is True
            and r.get("cached") is not True and isinstance(r.get("bytes"), int)]
    if not good:
        return (LAUNCH_UNCHECKED, "no timed render recorded in .launch-hq.json; run "
                                  "infra/scripts/hq_retest.py (dev, once, with Gilly's yes)")
    run = good[-1]
    base = str(run.get("base", "")).rstrip("/")
    url = str(run.get("image_url", ""))
    if base not in DEV_BASES or ".." in url or not _ASSET_RE.fullmatch(url):
        return (LAUNCH_UNCHECKED, "the latest recorded run names a host or file this check will not fetch")
    size = None
    for b in [base] + [x for x in DEV_BASES if x != base]:
        size = head_fn(b, url)
        if size is not None:
            break
    if size is None:
        return (LAUNCH_UNCHECKED, "the master %s is not reachable on dev now" % url)
    if size != run["bytes"]:
        return (LAUNCH_UNCHECKED, "the master on dev is %d bytes, the run recorded %d" % (size, run["bytes"]))
    peak = run.get("peak_mb")
    mem = ("peak memory %g MB (read by Gilly)" % peak if isinstance(peak, (int, float))
           else "peak memory UNCHECKED")
    kind = "integrated" if run.get("integrate") else "editor HQ"
    return (LAUNCH_OK, "%s render of %s %s UTC took %.0f s, master %d bytes; %s"
            % (kind, run.get("date", "?"), run.get("time", "?"), float(run.get("elapsed_s") or 0), size, mem))


# --- launch-gate: checks end ---
# <<< launch-gate (MH-5) <<<


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--done", default="",
                   help="comma-separated keys for session-only milestones")
    p.add_argument("--json", action="store_true")
    p.add_argument("--emit", action="store_true",
                   help="also write a snapshot to ~/.claude/runbooks/state/ for the "
                        "Orrery dashboard. The snapshot is a CACHE, never truth: it "
                        "records checked_at so the dashboard can show its age and grey "
                        "it out when stale. A green tick that silently means 'true an "
                        "hour ago' is the exact failure this whole pattern exists to "
                        "prevent.")
    args = p.parse_args()

    done_keys = {k.strip() for k in args.done.split(",") if k.strip()}
    known = {k for k, _, c in MILESTONES if c is None}
    unknown = done_keys - known
    if unknown:
        print(f"warning: --done keys not declared session-only: "
              f"{', '.join(sorted(unknown))}", file=sys.stderr)

    state = evaluate(done_keys)

    if args.json:
        print(json.dumps({
            "title": TITLE,
            "complete": sum(1 for k, _, _ in MILESTONES if state.get(k)),
            "total": len(MILESTONES),
            "milestones": [
                {"key": k, "label": lb, "done": state.get(k), "gated": k in GATED,
                 "how_kind": HOW.get(k, ("", ""))[0], "how": HOW.get(k, ("", ""))[1]}
                for k, lb, _ in MILESTONES
            ],
        }, indent=2))
    else:
        print(render(state))

    if args.emit:
        # Title carries the CANDIDATE identity, not just the procedure name.
        # On a dashboard of several runbooks, "Deploy myheliograph.com" alone
        # cannot tell you whether you are looking at today's work or a stale
        # card from last week — the commit is what makes the card legible at
        # a glance.
        sha = ""
        try:
            with open(RUN_STATE) as f:
                sha = json.load(f).get("git_sha", "")[:8]
        except Exception:
            pass
        snap = {
            "name": "deploy-myheliograph",
            "title": (f"myheliograph.com — candidate {sha}" if sha
                      else "myheliograph.com — no candidate"),
            "checked_at": datetime.datetime.now(datetime.timezone.utc)
                            .isoformat(timespec="seconds"),
            "complete": sum(1 for k, _, _ in MILESTONES if state.get(k)),
            "total": len(MILESTONES),
            "next": next((lb for k, lb, _ in MILESTONES if not state.get(k)), None),
            "external_state": run_out(FOOTER_CMD) if FOOTER_CMD else None,
            "external_label": FOOTER_LABEL if FOOTER_CMD else None,
            "milestones": [
                {"key": k, "label": lb, "done": bool(state.get(k)),
                 "gated": k in GATED,
                 "how_kind": HOW.get(k, ("", ""))[0],
                 "how": HOW.get(k, ("", ""))[1]}
                for k, lb, _ in MILESTONES
            ],
        }
        d = os.path.expanduser("~/.claude/runbooks/state")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "deploy-myheliograph.json"), "w") as f:
            json.dump(snap, f, indent=2)
        print(f"\n(snapshot written to {d}/deploy-myheliograph.json)")


if __name__ == "__main__":
    main()
