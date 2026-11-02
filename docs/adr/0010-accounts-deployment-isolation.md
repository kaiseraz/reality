# ADR 0010 — Accounts, single-image deployment, configurable sandbox runtime

Status: accepted

## Context

The MVP ran as a single-user tool on a developer machine. The next step is running it for a
small team on one server. This requires accounts and per-account data, a deployable artifact,
and stronger isolation, because more than one person's code runs on the same host.

## Decisions

1. **Accounts in the trusted core, no external identity provider yet.** Passwords are hashed
   with scrypt (N=2^15, r=8, p=1, 16-byte salt). Sessions are random 256-bit tokens in an
   HttpOnly, SameSite=Lax cookie (Secure behind HTTPS), and only their SHA-256 is stored.
   Login failures are rate-limited per e-mail and client. An unknown e-mail costs the same
   hashing work as a wrong password, so timing does not reveal which accounts exist. The first
   account is created on first visit and becomes the admin. Admins add further accounts.
   There is no open sign-up.
2. **Ownership is enforced at the HTTP boundary, once.** A pre-handler resolves every
   `/api/tasks/:id`, `/api/workspaces/:id` and `/api/artifacts/:id` route to its task and
   answers 404 unless the session's account owns it. With 404, the IDs of other accounts'
   tasks are not confirmed. Task lists are filtered in SQL. Tasks created without accounts
   (`owner_id` NULL) are visible to admins only. State-changing requests with a foreign
   `Origin` are refused, in addition to SameSite cookies.
3. **`AUTH=off` stays available** for local development and the test suite. It is never the
   image default: the image sets `AUTH=on`.
4. **One image, server and web app together.** The server serves the built SPA with a strict
   path resolver, a Content Security Policy (`'unsafe-eval'` only for scripts, because Vega
   compiles chart expressions), `nosniff`, `DENY` framing and immutable caching for
   fingerprinted assets. No static-file dependency was added: the candidate package version
   had been published two days earlier.
5. **Sandboxes keep using the host engine.** The server container mounts the Docker socket
   and contains only the Docker CLI. Bind-mount sources are resolved by the host, so data,
   capability staging and run directories are mounted at identical paths (`RUN_DIR` was made
   configurable for this). The socket gives root-equivalent power to the server process. The
   deployment guide therefore requires a dedicated VM.
6. **Configurable OCI runtime for sandboxes.** `SANDBOX_RUNTIME=runsc` runs every sandbox under
   gVisor. The name is validated, and the server checks at startup that Docker actually has
   the runtime. If it is missing, analyses stop with a clear message. They never fall back to
   the default runtime.

## Consequences and known gaps

- gVisor support is implemented and tested for the failure path and with an explicit `runc`.
  A run under `runsc` itself has not been exercised: the development machine (Docker Desktop
  on Windows) has no gVisor.
- No password reset, e-mail verification, SSO or per-team sharing of tasks yet.
- The login rate limit is in memory. It resets on restart and is per process, which is
  adequate for one server process.
- Capabilities are a shared library across accounts. Their approval is still per task, by
  the task's owner.
