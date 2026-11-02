# Deploying Reality on a server

One Linux host with Docker runs three things: Postgres, the Reality server (API and web
app in one image), and short-lived sandbox containers that the server starts for every
analysis step.

## Read this first: what the server can do on the host

The server starts sandboxes through the host's Docker engine, so it mounts
`/var/run/docker.sock`. **Access to that socket is equivalent to root on the host.** The
server only ever starts containers with the restrictions in ADR 0004 (no network, read-only
root, non-root user, all capabilities dropped, limits), but a compromise of the server
process would be a compromise of the host. Therefore:

- Use a **dedicated VM** for Reality, with nothing else of value on it.
- Install **gVisor** and set `SANDBOX_RUNTIME=runsc`. Untrusted code then runs against a
  user-space kernel instead of the host kernel. If the runtime is configured but missing,
  the server refuses to run analyses rather than fall back silently.
- Put Reality behind a **TLS reverse proxy** (Caddy, nginx, Traefik). Keep
  `COOKIE_SECURE=true` and bind the port to localhost.

## Steps

```bash
git clone <your repository> reality && cd reality
docker build -t reality-sandbox-python:dev sandbox/python
cd deploy
cp .env.example .env
```

Fill in `deploy/.env`:

- `POSTGRES_PASSWORD`: long and random, e.g. `openssl rand -base64 32`.
- `DOCKER_GID`: `getent group docker | cut -d: -f3`.
- `SANDBOX_RUNTIME=runsc` after installing gVisor (https://gvisor.dev/docs/user_guide/install/).
- `ANTHROPIC_API_KEY`: optional, enables the Claude planner.

Create the data directory and start:

```bash
sudo mkdir -p /srv/reality && sudo chown 1000:1000 /srv/reality
docker compose up -d --build
```

Open the site through your proxy. The first visitor creates the **administrator account**,
so do this right after starting. The administrator adds further accounts on the Team page.
Each account only sees its own tasks, data and results. The capability library is shared.

Example Caddy configuration (automatic HTTPS):

```
reality.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

## Operations

- Health: `GET /api/health` (also the container health check).
- Backups: the `pgdata` volume (tasks, audit log, accounts) and `/srv/reality`
  (uploaded and derived data). Capability layers are Docker volumes named
  `reality-cap-*`. They can be rebuilt by approving the capability again.
- Updates: `git pull && docker compose up -d --build`. Database migrations run at startup.
- Logs: `docker compose logs -f reality`.

## Why the same path inside and outside

Sandboxes get their input through bind mounts, which the **host** engine resolves. The data
directory is therefore mounted at the same path in the server container
(`REALITY_DATA:REALITY_DATA`), and `ARTIFACT_DIR`, `CAPABILITY_DIR` and `RUN_DIR` point into it.
