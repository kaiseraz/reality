# Base execution image for untrusted analysis code (see docs/adr/0004).
# Deliberately minimal: anything beyond this set must be acquired through the
# capability engine, so capability gaps in the MVP are real, not staged.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Shared system libraries that compiled scientific wheels link against (OpenGL and font
# runtimes, e.g. the OpenCascade CAD kernel). Libraries only: no compilers, no Python
# packages; those are still acquired through the capability engine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libgl1 libglu1-mesa libxrender1 libxext6 libx11-6 libfontconfig1 libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --only-binary=:all: -r /tmp/requirements.txt && rm /tmp/requirements.txt

# Non-root user; the runner additionally applies --read-only, --network none,
# --cap-drop ALL, no-new-privileges, and cpu/memory/pids/time limits.
# /layer is the mount point for capability layers (Docker volumes). A fresh volume
# mounted here inherits this ownership, so the unprivileged installer can write to it.
RUN useradd --create-home --uid 10001 sandbox \
    && mkdir /layer && chown sandbox:sandbox /layer
USER sandbox
WORKDIR /work

CMD ["python", "--version"]
