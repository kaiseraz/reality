# ADR 0004 — Docker containers as the MVP sandbox

Status: accepted

## Decision

- Untrusted code (agent-written analysis code and third-party packages) runs in Docker containers with: `--network none`, read-only root filesystem, non-root user, `--cap-drop ALL`, `no-new-privileges`, and CPU, memory, PID and wall-clock limits.
- Task data is mounted read-only. Results go to a dedicated output mount. Secrets are never passed in.
- Package installation happens in a separate, short-lived container whose only network access is to PyPI. Wheels only (`--only-binary=:all:`), so no install-time scripts run.

## Known limitation

Containers share the host kernel. They are **not** a strong boundary against deliberately malicious code. This is acceptable for a single-user local prototype with allowlisted sources. Production requires gVisor, Firecracker or microVM isolation (see the execution plan, section C).

## Note

Docker Desktop requires a paid subscription for larger organizations. Podman is a drop-in alternative under Apache-2.0.
