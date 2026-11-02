# ADR 0001 — TypeScript modular monolith with npm workspaces

Status: accepted

## Context

The WorkspaceSpec and TaskSpec contracts are Reality's core IP. Both the orchestrator, which produces and validates them, and the renderer, which consumes them, depend on these contracts.

## Decision

- The trusted core uses a single language, TypeScript on Node 24. Python runs only inside sandboxes.
- One repository holds `apps/server` (API, orchestrator, engines), `apps/web` (React SPA) and `packages/schemas` (Zod contracts shared by both).
- We use npm workspaces, which ship with Node, instead of pnpm. That's one less global tool to install.
- `@reality/schemas` is consumed as TypeScript source with no build step. Vite, Vitest and tsx all handle `.ts` imports directly.
- TypeScript is pinned to 6.0.x. TypeScript 7 (native compiler) is not yet supported by typescript-eslint (peer range `<6.1.0`).

## Consequences

- Schema changes surface as type errors in both apps at the same time.
- If LangGraph.js lags behind Python on a feature we need, we revisit this decision. Escape hatch: put a Python orchestrator worker behind the same schemas (exported as JSON Schema).
- `packages/components` (the component registry) is created in M2, when it has real content.
