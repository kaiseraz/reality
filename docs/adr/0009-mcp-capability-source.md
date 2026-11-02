# ADR 0009 — MCP servers as a capability source

Status: accepted

## Decision

MCP servers are a second kind of capability, next to Python libraries, with the **same lifecycle and the same human approval** (ADR 0008). The difference is how they are used: a library is mounted into analysis code; an MCP server runs as its own sandboxed process and Reality calls it as an MCP client.

| Stage    | MCP server specifics                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover | Catalog entries of kind `mcp-server` carry a **reviewed launch configuration**: entry point, arguments and the **allowed tools**. A server without one is ineligible.                                                                                   |
| Inspect  | Same wheel inspection, OSV lookup and policy as libraries. The approval shows the allowed tools and the launch configuration.                                                                                                                           |
| Install  | Same offline installation, into a **Docker volume**; precompiled to bytecode.                                                                                                                                                                           |
| Test     | The server is started from its layer in the sandbox (no network, read-only, non-root, limits), Reality connects over stdio with the official TypeScript SDK, checks that the approved tool exists, calls it on known data and compares the result.      |
| Use      | Plan steps carry `tool: { capability, name, args }`. Only approved tools are called. Each call starts a fresh sandboxed server with the task's CSV mounted read-only; the result is stored as an artifact with provenance and appears in the workspace. |

## First source: SQL over the task's data

`mcp-server-motherduck` (MotherDuck, maintained, read-only by default) provides `execute_query`. The task CSV is a view `data` in an in-memory DuckDB inside the container. Extension auto-install and auto-load are disabled, and there is no network.

- **Defence in depth:** before a call, a guard accepts only a single `SELECT` or `WITH … SELECT` statement without side-effect keywords. The server is the second line (in-memory, discarded with the container, data mounted read-only), the sandbox the third.
- **Independent verification:** the `sql_result_matches` check re-runs the same SQL with SQLite (Python standard library) on the raw CSV and compares the rows (order-insensitive unless `ORDER BY`). Queries that SQLite cannot run, e.g. DuckDB-only functions, are reported as **not verified** with the reason, never as passed.

## Candidates considered

- `mcp-server-time` (official reference server): rejected for data analysis. Its `convert_time` always uses today's date, so historical timestamps across a DST change would be converted wrongly.
- `holidays-mcp`: needs network at runtime and depends on an advertising package (`lulu-ads`); not added.
- `mcp-server-duckdb`, `mcp-server-sqlite`: listed as candidates without a reviewed launch configuration, so they are ineligible (and shown as such in the approval).

## Engineering finding: Docker volumes for layers

On Windows (and macOS), bind mounts from the host filesystem into Docker's VM are slow for many small files. Importing the MCP server (about 7,600 files) took 16 s from a bind mount and 2.9 s from a Docker volume. Capability layers therefore live in Docker volumes (`reality-cap-<id>-<version>`). The image's `/layer` directory is owned by the sandbox user, so a fresh volume is writable by the unprivileged installer. Older host-directory layers keep working.

## Known gaps

- Each tool call starts a new server (about 5–10 s). A pooled session per task would be faster but holds a process across steps.
- The tool descriptions a server reports are shown as untrusted text and are not given to the planner.
- Only stdio servers distributed as Python wheels are supported. Remote (HTTP) MCP servers, which need network and often credentials, are deliberately out of scope.
