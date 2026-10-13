#!/usr/bin/env python3
"""Self-check for infra/scripts/bundle_manifest.py (MH-8).

Run: python3 api/scripts/test_bundle_manifest.py

The edge code hash must ignore everything that legitimately differs between
the dev bundle and the prod bundle of ONE commit (warmed mockup assets,
build.json, the dev-only robots.txt / missing sitemap.xml, the injected
noindex meta) and must change when any shipped code or font changes.
"""
import contextlib
import importlib.util
import io
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra" / "scripts" / "bundle_manifest.py"
spec = importlib.util.spec_from_file_location("bundle_manifest", SCRIPT)
bm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bm)  # FileNotFoundError until the script exists

NOINDEX = '\n  <meta name="robots" content="noindex, nofollow">'


def make_tree(base, *, dev=False, build="1", motion="export const a = 1;\n",
              warmed=b"thumb-1", font=b"font-1"):
    base = pathlib.Path(base)
    (base / "store").mkdir(parents=True)
    (base / "asset" / "default" / "mockups").mkdir(parents=True)
    (base / "asset" / "fonts").mkdir(parents=True)
    (base / "motion.js").write_text(motion)
    head = "<head>" + (NOINDEX if dev else "") + "<title>s</title></head>"
    (base / "store" / "index.html").write_text("<!doctype html><html>" + head + "<body></body></html>\n")
    (base / "asset" / "default" / "mockups" / "x.thumb.webp").write_bytes(warmed)
    (base / "asset" / "fonts" / "inter.woff2").write_bytes(font)
    (base / "build.json").write_text('{"sha": "x", "built_at": "%s"}' % build)
    (base / "robots.txt").write_text("User-agent: *\n" + ("Disallow: /\n" if dev else "Allow: /\n"))
    if not dev:
        (base / "sitemap.xml").write_text("<urlset/>\n")
    return base


def tmp():
    return tempfile.mkdtemp(prefix="bundle-manifest-")


def test_dev_and_prod_builds_of_one_commit_hash_alike():
    a = make_tree(tmp(), dev=True, build="1", warmed=b"w1")
    b = make_tree(tmp(), dev=False, build="2", warmed=b"w2")
    ha, _ = bm.code_hash(a)
    hb, _ = bm.code_hash(b)
    assert ha == hb, f"dev {ha[:12]} != prod {hb[:12]}: an excluded path leaked into the hash"
    assert len(ha) == 64 and all(c in "0123456789abcdef" for c in ha), ha


def test_one_byte_in_motion_js_changes_only_that_file():
    a = make_tree(tmp())
    c = make_tree(tmp(), motion="export const a = 2;\n")
    ha, fa = bm.code_hash(a)
    hc, fc = bm.code_hash(c)
    assert ha != hc, "a changed motion.js must change the overall hash"
    changed = {p for p in fa if fa[p] != fc.get(p)}
    assert changed == {"motion.js"}, f"changed files: {sorted(changed)}"


def test_fonts_count_as_code():
    a = make_tree(tmp())
    c = make_tree(tmp(), font=b"font-2")
    assert bm.code_hash(a)[0] != bm.code_hash(c)[0], "asset/fonts/ must be inside the hash"


def test_excluded_paths_are_absent_from_the_file_map():
    _, files = bm.code_hash(make_tree(tmp(), dev=True))
    bad = [p for p in files if p.startswith("asset/default/") or p in ("build.json", "robots.txt", "sitemap.xml")]
    assert not bad, f"excluded paths present: {bad}"
    assert "motion.js" in files and "asset/fonts/inter.woff2" in files, sorted(files)


def test_cli_files_and_diff():
    a = make_tree(tmp())
    c = make_tree(tmp(), motion="export const a = 2;\n")
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        rc = bm.main([str(a), "--files"])
    lines = out.getvalue().splitlines()
    assert rc == 0 and len(lines[0]) == 64, lines[:2]
    assert any(l.endswith("  motion.js") for l in lines[1:]), lines
    saved = pathlib.Path(tmp()) / "files.txt"
    saved.write_text(out.getvalue())
    out2 = io.StringIO()
    with contextlib.redirect_stdout(out2):
        rc2 = bm.main([str(c), "--diff", str(saved)])
    assert rc2 == 1 and "changed: motion.js" in out2.getvalue(), (rc2, out2.getvalue())
    with contextlib.redirect_stdout(io.StringIO()):
        rc3 = bm.main([str(a), "--diff", str(saved)])
    assert rc3 == 0, rc3


def test_missing_directory_exits_2():
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        rc = bm.main([str(pathlib.Path(tmp()) / "nope")])
    assert rc == 2 and "bundle_manifest:" in err.getvalue(), (rc, err.getvalue())


def main():
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("PASS", name)
        except Exception as ex:  # noqa: BLE001 - report every failure, then exit 1
            failed += 1
            print("FAIL", name, "-", type(ex).__name__, ex)
    if failed:
        print(f"test_bundle_manifest: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_bundle_manifest: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
