#!/usr/bin/env python3
"""Write a local HTML receipt for one deploy (MH-8).

    python3 infra/scripts/deploy_receipt.py <git_sha> [--run-check] [--out PATH]

Output: .deploy-artifacts/<git_sha>/receipt.html (gitignored). An existing
receipt is renamed to receipt.<UTC stamp>.html first; nothing is overwritten
or pruned. Inputs are all local: the git history, .deploy-ledger.jsonl,
.deploy-artifacts/<sha>/check-summary.txt and .deploy-shots/{dev,prod}/*.png.
The page makes no external request, holds no secret (the ledger holds none)
and escapes every value it prints.
"""
import argparse
import datetime
import html
import json
import os
import pathlib
import subprocess
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[2]

# Token values read from api/solar-archive.css (:root dark, then the light block).
CSS = """
:root{color-scheme:dark light;--bg:#1a1814;--card:#25221c;--text:#f4efe6;--dim:#c3b9a9;--border:#3a362c;--sun:#d9a91a;--flare:#e8663a}
@media (prefers-color-scheme: light){:root{--bg:#faf8f3;--card:#ffffff;--text:#1a2a5a;--dim:#555555;--border:#e4ddcf;--sun:#806200;--flare:#e8663a}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:28px 0 8px;color:var(--sun)}
.dim{color:var(--dim)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:8px}
th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{color:var(--dim);font-weight:600}
td.none{color:var(--flare)}
img{max-width:100%;height:auto;border:1px solid var(--border);border-radius:6px;display:block}
ul{margin:0;padding-left:20px}
"""


def e(value):
    return html.escape("" if value is None else str(value))


def _git(root, *args):
    try:
        r = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def read_ledger(path):
    entries = []
    try:
        text = pathlib.Path(path).read_text()
    except OSError:
        return entries
    for line in text.splitlines():
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            entries.append(obj)
    return entries


def previous_prod_sha(entries, sha):
    """The prod commit before this candidate: the newest prod ledger line for
    a different commit that comes before the first prod line for `sha`."""
    prev = None
    for ent in entries:
        if ent.get("target") != "prod" or ent.get("dry_run"):
            continue
        if ent.get("git_sha") == sha:
            break
        prev = ent.get("git_sha")
    return prev


def commit_range(root, prev, sha):
    if prev and _git(root, "cat-file", "-t", prev) == "commit":
        out = _git(root, "log", "--oneline", "-n", "40", f"{prev}..{sha}")
        return f"since the last prod promotion ({prev[:8]})", out.splitlines()
    out = _git(root, "log", "--oneline", "-n", "20", sha)
    return "last 20 commits (no earlier prod promotion in the ledger)", out.splitlines()


def collect_shots(root):
    shots = {}
    for tier in ("dev", "prod"):
        d = pathlib.Path(root) / ".deploy-shots" / tier
        shots[tier] = {p.name: p for p in sorted(d.glob("*.png"))} if d.is_dir() else {}
    return shots


def check_summary(root, sha, run_check):
    d = pathlib.Path(root) / ".deploy-artifacts" / sha
    f = d / "check-summary.txt"
    if run_check:
        script = pathlib.Path(root) / "infra" / "scripts" / "check.sh"
        try:
            r = subprocess.run([str(script)], capture_output=True, text=True, timeout=1800, cwd=str(root))
            last = [ln for ln in r.stdout.splitlines() if ln.startswith("check.sh:")]
            text = last[-1] if last else f"check.sh produced no summary line (exit {r.returncode})"
        except (OSError, subprocess.SubprocessError) as ex:
            text = f"check.sh could not run: {ex}"
        d.mkdir(parents=True, exist_ok=True)
        f.write_text(text + "\n")
        return text
    try:
        return f.read_text().strip() or "not recorded"
    except OSError:
        return "not recorded (run deploy_receipt.py <sha> --run-check)"


def build_receipt(root, sha, run_check=False):
    root = pathlib.Path(root)
    entries = read_ledger(root / ".deploy-ledger.jsonl")
    mine = [x for x in entries if x.get("git_sha") == sha and not x.get("dry_run")]
    subject = _git(root, "log", "-1", "--format=%s", sha)
    when = _git(root, "log", "-1", "--format=%cI", sha)
    branch = (mine[-1].get("branch") if mine else "") or "unknown"
    label, commits = commit_range(root, previous_prod_sha(entries, sha), sha)
    summary = check_summary(root, sha, run_check)
    shots = collect_shots(root)
    out_dir = root / ".deploy-artifacts" / sha
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    tier_rows = []
    for tier in ("dev", "prod", "render"):
        hit = [x for x in mine if x.get("target") == tier]
        if not hit:
            continue
        x = hit[-1]
        digest = (x.get("image") or "").split("@")[-1]
        tier_rows.append(
            "<tr><th scope=\"row\">%s</th><td>%s</td><td class=\"mono\">%s</td><td class=\"mono\">%s</td>"
            "<td class=\"mono\">%s</td><td>%s</td></tr>" % (
                e(tier), e(x.get("time")), e(digest[:19] if digest else "none"),
                e(x.get("worker_version_id") or "none"),
                e((x.get("edge_code_hash") or "none")[:12]), e(x.get("action", "deploy"))))
    if not tier_rows:
        tier_rows.append("<tr><td colspan=\"6\" class=\"dim\">No ledger line for this commit yet.</td></tr>")

    cap_rows = []
    for name in sorted(set(shots["dev"]) | set(shots["prod"])):
        cells = []
        for tier in ("dev", "prod"):
            p = shots[tier].get(name)
            if p:
                rel = os.path.relpath(p, out_dir).replace(os.sep, "/")
                cells.append("<td><img src=\"%s\" alt=\"%s capture %s\" loading=\"lazy\"></td>" % (
                    e(urllib.parse.quote(rel)), e(tier), e(name)))
            else:
                cells.append("<td class=\"none\">no capture</td>")
        cap_rows.append("<tr><th scope=\"row\">%s</th>%s</tr>" % (e(name), "".join(cells)))
    if not cap_rows:
        cap_rows.append("<tr><td colspan=\"3\" class=\"dim\">No captures yet (DEPLOY.md step 2 writes .deploy-shots/dev and .deploy-shots/prod).</td></tr>")

    commit_items = "".join("<li class=\"mono\">%s</li>" % e(c) for c in commits) or "<li class=\"dim\">none</li>"
    return """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Deploy receipt %(short)s</title>
<style>%(css)s</style>
</head>
<body>
<main>
<h1>Deploy receipt %(short)s</h1>
<p class="dim">Generated %(now)s from the local ledger and git history. Nothing here was fetched from the network.</p>
<h2>Commit</h2>
<p><span class="mono">%(sha)s</span><br>%(subject)s<br><span class="dim">branch %(branch)s, committed %(when)s</span></p>
<h2>Shipped</h2>
<table><thead><tr><th>Tier</th><th>Recorded</th><th>Image digest</th><th>Worker version</th><th>Edge code hash</th><th>Action</th></tr></thead><tbody>%(tiers)s</tbody></table>
<h2>Commit range, %(label)s</h2>
<ul>%(commits)s</ul>
<h2>Checks</h2>
<p class="mono">%(summary)s</p>
<h2>Captures, dev and prod</h2>
<table><thead><tr><th>Page</th><th>Dev</th><th>Prod</th></tr></thead><tbody>%(caps)s</tbody></table>
</main>
</body>
</html>
""" % {
        "short": e(sha[:8]), "css": CSS, "now": e(now), "sha": e(sha), "subject": e(subject),
        "branch": e(branch), "when": e(when), "tiers": "".join(tier_rows), "label": e(label),
        "commits": commit_items, "summary": e(summary), "caps": "".join(cap_rows)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("git_sha")
    ap.add_argument("--run-check", action="store_true", help="run infra/scripts/check.sh and record its summary line")
    ap.add_argument("--out")
    ap.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    root = pathlib.Path(a.root)
    sha = _git(root, "rev-parse", "--verify", a.git_sha + "^{commit}")
    if not sha:
        print(f"deploy_receipt: {a.git_sha} is not a commit in {root}", file=sys.stderr)
        return 2
    text = build_receipt(root, sha, a.run_check)
    out = pathlib.Path(a.out) if a.out else root / ".deploy-artifacts" / sha / "receipt.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        out.rename(out.with_name(f"{out.stem}.{stamp}{out.suffix}"))
    out.write_text(text, encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
