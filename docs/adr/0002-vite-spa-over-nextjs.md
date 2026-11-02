# ADR 0002 — Vite React SPA + Fastify instead of Next.js

Status: accepted

## Context

The original brief suggested Next.js. The workspace is a long-lived, stateful application, not a content site. The orchestrator runs multi-minute tasks with checkpoints and human approvals.

## Decision

- The UI is a React 19 single-page app built with Vite.
- The API is a Fastify server, which also hosts the orchestrator process. Live updates go over SSE.

## Consequences

- No SSR or React Server Components complexity, and no serverless request-time limits on agent runs.
- Next.js can still be added later for a marketing site or hosted multi-tenant deployment. It isn't needed to prove the concept.
