# Container image for the My Heliograph FastAPI origin (Fly.io target).
#
# Mirrors the Render native-Python runtime this app grew up on:
#   - python:3.12 (repo's committed bytecode is cpython-312; the vendored
#     sunkit-image wheel is py3-none-any). -slim is fine: every scientific
#     dep (sunpy[all]/scipy/numpy/matplotlib) ships manylinux wheels for
#     cp312, and matplotlib is forced to the headless Agg backend in code,
#     so no compiler or GUI system libs are needed.
#   - single uvicorn worker, NO --workers flag: the in-memory task registry,
#     heavy-render semaphore, per-IP rate buckets, and stats-file lock all
#     assume exactly one process. Do not "scale" this with workers.
#   - the process must start from the repo root: the module path is
#     api.main and requirements.txt references ./vendor/*.whl relatively.
#
# Durable state lives on the Fly volume mounted at /var/data (the code
# auto-detects a writable /var/data, same as Render); nothing in the image
# itself needs to survive a deploy.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependency layer first for build caching — vendor/ holds the committed
# fast-RHEF sunkit-image wheel that requirements.txt installs by path.
COPY requirements.txt ./
COPY vendor/ vendor/
RUN pip install -r requirements.txt

# App code (includes api/certs/*.pem — the NASA CA bundle merged at boot).
COPY api/ api/

EXPOSE 8080

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8080"]
