# ADR 0003 — Contracts are Zod schemas; LLM output is untrusted data

Status: accepted

## Decision

- Every structure crossing a trust boundary is defined once in `@reality/schemas` and validated at runtime. That covers TaskSpec, WorkspaceSpec, WorkspacePatch, ActionIntent and capability records.
- LLMs can only _propose_. A proposal takes effect only after schema validation and the deterministic policy check.
- Workspaces change through typed patch operations, never by regeneration and never by executing generated frontend code. Unknown operations are rejected.
- Capability lifecycle transitions are enforced in code (`canTransition`). Discovery never implies trust.

## Consequences

- Malformed or adversarial model output fails closed.
- Adding a new workspace component or patch operation is a deliberate, reviewed schema change.
