#!/usr/bin/env python3
"""Self-check: the Dockerfile bakes the build commit (MH-8, Dockerfile half).

Run: python3 api/scripts/test_dockerfile_git_sha.py

deploy.sh passes --build-arg GIT_SHA=<sha> on the dev image build; the image
must declare ARG GIT_SHA and ENV GIT_SHA after the pip layer so a new commit
does not invalidate the dependency cache. The reader of this variable
(/api/build-info in api/main.py) is a FREEZE file and lands separately.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]


def test_dockerfile_declares_git_sha_after_pip():
    lines = (ROOT / "Dockerfile").read_text().splitlines()
    pip = next((i for i, l in enumerate(lines) if l.startswith("RUN pip install")), None)
    arg = next((i for i, l in enumerate(lines) if l.strip() == "ARG GIT_SHA=unknown"), None)
    env = next((i for i, l in enumerate(lines) if l.strip() == "ENV GIT_SHA=$GIT_SHA"), None)
    assert arg is not None, "Dockerfile has no 'ARG GIT_SHA=unknown' line"
    assert env is not None and env > arg, "Dockerfile has no 'ENV GIT_SHA=$GIT_SHA' line after the ARG"
    assert pip is not None and arg > pip, "ARG GIT_SHA must come after the RUN pip install layer"


def test_deploy_sh_passes_the_build_arg_once():
    text = (ROOT / "infra" / "scripts" / "deploy.sh").read_text()
    n = text.count('--build-arg GIT_SHA="$GIT_SHA"')
    assert n == 1, f'deploy.sh has {n} --build-arg GIT_SHA="$GIT_SHA" (want 1, on the dev fly deploy)'


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
        print(f"test_dockerfile_git_sha: {failed} of {len(tests)} FAILED")
        return 1
    print(f"test_dockerfile_git_sha: {len(tests)} passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
