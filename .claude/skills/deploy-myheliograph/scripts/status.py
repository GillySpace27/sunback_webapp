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
import subprocess
import sys

# ─────────────────────────── CONFIG ───────────────────────────

TITLE = "Deploy myheliograph.com (dev → gate → prod)"

REPO = os.path.expanduser("~/vscode/sunback/webapp")
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

# (key, label, check)
MILESTONES = [
    ("preflight", "Preflight: tree clean, typecheck passes",
     f"cd {REPO} && test -z \"$(git status --porcelain)\" && (cd web3d && npm run typecheck >/dev/null 2>&1)"),

    ("dev", "Dev deployed and serving",
     f"{_DEV_CURL} /api/health >/dev/null"),

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

    if FOOTER_CMD:
        raw = run_out(FOOTER_CMD)
        if raw:
            lines.append("")
            lines.append(f"({FOOTER_LABEL}: {raw})")

    return "\n".join(lines)


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
                {"key": k, "label": lb, "done": state.get(k), "gated": k in GATED}
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
            "milestones": [
                {"key": k, "label": lb, "done": bool(state.get(k)),
                 "gated": k in GATED}
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
