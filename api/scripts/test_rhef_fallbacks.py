#!/usr/bin/env python3
"""Self-check: no RHEF fallback retries rhef() on a bare ndarray (RH-9).

Run: python3 api/scripts/test_rhef_fallbacks.py

sunkit_image.radial.rhef needs a sunpy Map (it reads smap.wcs), so an
`except` branch that calls rhef(smap.data) can only raise a second, less
useful error (AttributeError: 'numpy.ndarray' object has no attribute 'wcs').
Every handler around an rhef() call must log and re-raise, or return an
unfiltered image marked with meta["rhef_failed"] (default_filter does).
Static check (ast): it never imports api.main or the science stack.
"""
import ast
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MAIN = os.path.join(ROOT, "api", "main.py")


def _calls_rhef(nodes):
    for node in nodes:
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call):
                f = sub.func
                name = f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", "")
                if name == "rhef":
                    yield sub


def _handlers():
    tree = ast.parse(open(MAIN, encoding="utf-8").read(), filename=MAIN)
    for node in ast.walk(tree):
        if isinstance(node, ast.Try) and any(True for _ in _calls_rhef(node.body)):
            for h in node.handlers:
                yield h


def test_no_handler_retries_rhef():
    bad = [c.lineno for h in _handlers() for c in _calls_rhef(h.body)]
    assert not bad, "rhef() called again inside an except branch at api/main.py lines %s" % bad


def _labelled(handler):
    """True when the branch marks its output as unfiltered (meta["rhef_failed"])."""
    return any(isinstance(n, ast.Constant) and n.value == "rhef_failed" for n in ast.walk(handler))


def test_every_rhef_handler_reraises_or_labels():
    handlers = list(_handlers())
    assert len(handlers) >= 4, "expected at least 4 RHEF try blocks, found %d" % len(handlers)
    silent = [h.lineno for h in handlers
              if not _labelled(h) and not any(isinstance(s, ast.Raise) and s.exc is None for s in h.body)]
    assert not silent, "RHEF except branch that neither re-raises nor sets rhef_failed at api/main.py lines %s" % sorted(silent)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok  %s" % name)
    print("all rhef-fallback checks passed")
