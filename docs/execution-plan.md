# Reality — Execution Plan v0.2

Status: v0.1 approved and implemented as the MVP (M0–M6, plus real-data
testing, accounts and deployment). v0.2 adds the full vision: always-on agents
working towards long-term goals (section A2) and the roadmap M7–M10 (section F).

---

## A. The concept, restated

Reality is a workspace that rebuilds itself around the task. The user states a goal. Reality turns it into a structured task, and then changes two things about itself to fit that task:

1. **What it can do (adaptive capabilities).** If the task needs a tool Reality doesn't have, Reality notices the gap and goes through a fixed sequence: find candidates, compare them, inspect one, install it in isolation, test it against stated requirements, use it, and record where it came from. A capability earns reuse by passing tests. Finding it is not enough. Every acquired capability is in one of these states: _discovered → inspected → sandbox-tested → enabled for this task → trusted for reuse_. Each step up requires evidence, and some steps also require human approval.

2. **How the human works with it (adaptive workspace).** Reality doesn't always show a chat window. It composes a working environment from a registry of typed, tested components, such as a data table, chart, editor, terminal, 3D viewer or evidence panel. It wires them to real task data and changes the arrangement as the task evolves, without losing state. The layout is described by a declarative **WorkspaceSpec**. The AI proposes changes to that spec. It doesn't write arbitrary frontend code.

These two adaptations are coupled, and specialized agents connect them. They share one structured task state. An orchestrator plans and delegates. Analysis, research and coding agents do the work. A capability agent fills gaps. A workspace agent reshapes the UI. A verification agent checks results against acceptance criteria. A deterministic policy layer, which is not an LLM, decides what each actor may do. When the capability engine acquires a new ability, the workspace engine can show it. When the user acts in the workspace, the plan changes. That loop is the product. A chatbot with plugins doesn't have it.

---

## A2. The full vision (v0.2): three systems

Reality is an adaptive AI platform with a team of persistent, autonomous agents. They work
around the clock towards the user's goals, extend their own capabilities under control, and
shape the whole working environment to those goals.

1. **Always-on agents.** Persistent, specialised agents take on work on their own, also while
   the user is offline. They work in parallel, hand work to each other, move shared projects
   forward and ask for approval when it is needed.
2. **Adaptive capability engine** (section D.5). The agents are not limited to a fixed tool
   set. Reality detects missing capabilities, finds suitable tools and open-source components,
   integrates them under control and keeps what worked for later tasks.
3. **Adaptive workspace engine** (section D.4). The working environment is built for the task
   and changes during the work: an IDE for programming, sources and analysis for research,
   visualisation and simulation tools for engineering.

**How they work together**, for a long-term goal such as "build a working prototype of my new
product":

1. Reality breaks the goal into tasks and a plan (a project).
2. Specialised agents take on research, architecture, programming and tests in parallel.
3. They keep working in persistent runtimes instead of stopping after one answer.
4. When an agent lacks a tool, the capability engine tries to acquire one safely.
5. The workspace shows the state of the project, running work, code, results and open
   decisions.
6. Agents verify their results, coordinate dependencies and continue while useful work
   remains. Critical decisions go to the user.

The user sets the goal, steers the direction and steps in where judgement is needed. They no
longer trigger every step or wire tools together.

**What does not change.** Persistence and autonomy raise the stakes of problems 1, 2 and 4 in
section B. Rules that therefore stay fixed:

- A deterministic policy layer, not a model, decides what runs without asking.
- Installing a capability always needs a person.
- Every result shows how it was verified.
- Budgets bound what a project may consume.
- Autonomy is widened only where verification is machine-checkable.

Open-ended goals such as the prototype example need an AI planner. The rule-based planner
cannot decompose them. The infrastructure is built and tested without one, but the end-to-end
claim is only true once the Claude path has been exercised live.

## B. The five hardest problems, ranked

| #   | Risk                                                     | Kind                                                           | Why it's hard                                                                                                                                                                                                                                                                                                                                                                                                                         | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Safely acquiring third-party capabilities at runtime** | Partly **unsolved**                                            | Sandboxing itself is established engineering (containers, microVMs, seccomp, network policy). _Deciding automatically_ that an unknown package or MCP server is safe and correct is not a solved problem. An LLM reading source code is not a security guarantee. Install-time code (`setup.py`, npm `postinstall`) runs before any test does. MCP servers are long-running processes that often want network access and credentials. | Discovery only from a small set of allowlisted sources. Wheels only, with no install scripts. Pinned hashes. Vulnerability and license checks. Install and run in separate, isolated sandboxes. Human approval before enabling anything. Trust is scoped by capability state, and the policy layer is deterministic code. In the MVP we limit acquisition to **pure-compute Python packages**. MCP servers come later. |
| 2   | **Verifying agent outputs**                              | **Unsolved in general**, tractable in narrow domains           | "Did the agent succeed?" has no general answer. Verification works only where acceptance criteria can be checked by a machine: recomputation, schema checks, tests, invariants. An LLM-as-judge is a weak signal and must be labeled as one.                                                                                                                                                                                          | Pick an MVP domain where most criteria are checkable. Verification is a separate step with its own inputs: it re-runs computations independently and doesn't trust the agent's report. The UI shows _what was verified and how_.                                                                                                                                                                                       |
| 3   | **Workspace composition quality and state continuity**   | Mechanism **established**, quality **uncertain**               | Schema-constrained JSON generation and component registries are well understood. Whether an LLM reliably picks _useful_ layouts and correct data bindings, and whether incremental updates preserve user state, has to be measured. It can't be assumed.                                                                                                                                                                              | Typed spec with Zod validation. Changes are patches, not regenerations. Components own their own UI state and are keyed by stable IDs. A deterministic fallback template exists for each task type. Evaluate against a fixed-workspace baseline.                                                                                                                                                                       |
| 4   | **Multi-agent reliability, latency and cost**            | Orchestration **established**, agent reliability **uncertain** | Errors compound across hand-offs. Multi-agent setups often cost more and perform worse than one well-prompted agent. Long runs need durable checkpoints, retries and resumption.                                                                                                                                                                                                                                                      | Agents are separated where the separation buys something measurable: isolated context, different permissions, or independence for verification. Otherwise a role is a plain workflow node. LangGraph checkpoints in Postgres. Per-task budgets. Measure against a single-agent variant.                                                                                                                                |
| 5   | **The breadth promise ("any task") vs. depth**           | Product **risk**, partly speculative                           | Engineering simulation, CAD and scientific work each need deep integration with domain tools such as FEM solvers and CAD kernels. Generic discovery won't produce physically valid simulation. There's a real risk of building a shallow layer that does everything badly.                                                                                                                                                            | Prove the architecture on one domain with real depth. New domains are added by registering components, capabilities and verification checks. The core doesn't change. Label every visualization honestly: illustrative vs. computed vs. validated.                                                                                                                                                                     |

Honorable mentions, all of them established engineering: prompt injection through task data (a CSV cell that says "ignore previous instructions"), secret handling, and the quality of tool search when registry metadata is thin.

---

## C. Open-source landscape (verified against the versions listed)

Versions and licenses marked ✅ were checked against the npm registry. Claims marked ⚠️ come from secondary sources and must be re-checked before adoption.

### Recommended for the prototype (minimal stack)

| Dependency                                                          | Solves                                                                                      | Why it fits                                                                                                                                                                                                                           | Alternatives considered                                                                                                                                                                                                                                                                    | License / limits                                                                                                                                                                                                                                                          | Needed in MVP? |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| **TypeScript (Node 24)** across server and UI                       | One language for the orchestrator, the WorkspaceSpec schema and the renderer                | The WorkspaceSpec and TaskSpec are our core IP. Sharing _one_ typed schema between the agent side and the renderer removes a whole class of drift bugs. Python stays inside the sandbox, where data and science tooling lives anyway. | Python backend (FastAPI + LangGraph Python, the more mature LangGraph) plus a TS frontend. Rejected for now: two languages and duplicated schemas. Revisit if LangGraph.js parity becomes a real blocker.                                                                                  | —                                                                                                                                                                                                                                                                         | Yes            |
| **LangGraph.js** `@langchain/langgraph` 1.5.1 ✅                    | Stateful agent graphs, checkpoints, `interrupt()` for human approval, resume after crash    | Matches the needs for pause, resume, retry and human-in-the-loop directly. Postgres checkpointer available.                                                                                                                           | Vercel AI SDK 6 (Apache-2.0, has an `Agent` loop, but no durable graph or checkpoint model); Temporal (excellent durability, heavy for an MVP); hand-rolled state machine.                                                                                                                 | MIT ✅. The JS version trails Python on features. ⚠️ A 2026 advisory reports that the Postgres _store_ matches namespaces by prefix (`LIKE`), so namespaces must not be used as security boundaries.                                                                      | Yes            |
| **@langchain/langgraph-checkpoint-postgres**                        | Durable checkpoints                                                                         | Same Postgres as everything else                                                                                                                                                                                                      | SQLite checkpointer (dev only)                                                                                                                                                                                                                                                             | MIT ⚠️ (confirm current JS version)                                                                                                                                                                                                                                       | Yes            |
| **PostgreSQL 16+**                                                  | Tasks, events, workspace specs, capability registry, checkpoints                            | One durable store. JSONB covers specs. `LISTEN/NOTIFY` covers live updates.                                                                                                                                                           | SQLite (simpler, but weak for concurrent workers)                                                                                                                                                                                                                                          | PostgreSQL License                                                                                                                                                                                                                                                        | Yes            |
| **Drizzle ORM** + **Zod**                                           | Typed DB access; runtime validation of every LLM output and spec patch                      | Zod schemas _are_ the contract between agents and UI                                                                                                                                                                                  | Prisma (heavier codegen), Kysely                                                                                                                                                                                                                                                           | Apache-2.0 / MIT                                                                                                                                                                                                                                                          | Yes            |
| **Claude models via `@langchain/anthropic`**                        | LLM reasoning                                                                               | Strong at tool use and structured output. Model per agent set in config (e.g. `claude-sonnet-5-5` for workers, `claude-opus-5-5` for planning and verification, `claude-haiku-5-5` for cheap classification).                         | Any provider behind the same interface                                                                                                                                                                                                                                                     | Commercial API                                                                                                                                                                                                                                                            | Yes            |
| **Docker Engine / Docker Desktop (WSL2)** or **Podman**             | Sandboxed Python execution and capability installation                                      | Mature and scriptable. Supports `--network none`, read-only rootfs, `--cap-drop ALL`, memory, CPU and PID limits, non-root user.                                                                                                      | microsandbox (Apache-2.0, libkrun microVMs, stronger isolation, ⚠️ still beta); E2B (Apache-2.0 SDK, hosted runtime); gVisor/Firecracker (production hardening on Linux); Pyodide in Deno (WASM isolation, limited packages). Daytona: ⚠️ reportedly went closed source in 2026, so avoid. | Docker Desktop requires a paid licence for larger companies; Podman is Apache-2.0. **Containers are not a strong boundary against deliberately malicious code.** That's acceptable for a single-user local MVP with curated sources. Production needs gVisor or microVMs. | Yes            |
| **React 19 + Vite** (SPA) + **Fastify** API                         | Workspace UI and API/SSE server                                                             | The workspace is an app, not a content site. SSR and React Server Components add complexity and buy nothing here. A long-running orchestrator fits better in a plain Node process than in Next.js route handlers.                     | **Next.js**, which the brief suggests. I recommend against it for the MVP for the reasons above. Easy to adopt later for a marketing site or multi-tenant hosting.                                                                                                                         | MIT                                                                                                                                                                                                                                                                       | Yes            |
| **dockview** 8.6.0 ✅                                               | IDE-style docking: tabs, splits, floating panels, serializable layout (`toJSON`/`fromJSON`) | Its serializable layout maps directly onto the WorkspaceSpec layout. Zero runtime dependencies.                                                                                                                                       | FlexLayout, react-grid-layout (dashboard grid, not docking), golden-layout                                                                                                                                                                                                                 | MIT ✅                                                                                                                                                                                                                                                                    | Yes            |
| **Vega-Lite** (via `react-vega`)                                    | Charts                                                                                      | Charts are _declarative JSON specs_. An agent can produce one, Zod and Vega's own schema can validate it, and it can be stored and diffed. That fits our architecture unusually well.                                                 | ECharts (Apache-2.0, also declarative), Recharts (JSX, not spec-driven), Plotly                                                                                                                                                                                                            | BSD-3                                                                                                                                                                                                                                                                     | Yes            |
| **TanStack Table + Virtual**                                        | Large data grid                                                                             | Headless, fast, MIT                                                                                                                                                                                                                   | AG Grid Community (MIT, heavier)                                                                                                                                                                                                                                                           | MIT                                                                                                                                                                                                                                                                       | Yes            |
| **Python sandbox image**: python 3.12-slim + pandas, numpy, pyarrow | Analysis execution                                                                          | The standard data stack                                                                                                                                                                                                               | Polars (could be added later as a capability)                                                                                                                                                                                                                                              | BSD / Apache-2.0                                                                                                                                                                                                                                                          | Yes            |
| **OSV.dev API** + PyPI JSON API                                     | Vulnerability lookup and package metadata for the capability engine                         | Free, open, machine-readable                                                                                                                                                                                                          | Snyk, Socket (commercial)                                                                                                                                                                                                                                                                  | Free API                                                                                                                                                                                                                                                                  | Yes            |
| **Vitest + Playwright**                                             | Unit, integration and end-to-end tests                                                      | Standard                                                                                                                                                                                                                              | Jest, Cypress                                                                                                                                                                                                                                                                              | MIT / Apache-2.0                                                                                                                                                                                                                                                          | Yes            |

### Deliberately deferred

| Project                                                                                                                                                                                                                                              | Role later                                                                                                                                                                                                                                | Why not now                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP TypeScript SDK** `@modelcontextprotocol/sdk` 1.32.1 ✅ (MIT). The spec's current revision is **2026-07-28**, its largest change so far: stateless core, Tasks, stricter OAuth, Roots/Sampling/Logging deprecated (⚠️ per secondary summaries). | The capability source and tool protocol for external integrations. Internally, capabilities already use MCP-compatible tool schemas (name, JSON-Schema input, typed result), so adopting MCP later is a transport change, not a redesign. | Running third-party MCP servers safely (long-lived processes that need network access and credentials) is risk #1 at full strength. Pure-compute packages prove the lifecycle first. MCP-registry discovery is milestone M7. |
| **MCP Apps** (`io.modelcontextprotocol/ui`, `ui://` resources in a sandboxed iframe, stable 2026-01-26)                                                                                                                                              | The controlled escape hatch for _third-party or generated UI_: render it isolated in a sandboxed iframe with CSP, outside our trusted registry                                                                                            | Not needed while every component comes from our own registry                                                                                                                                                                 |
| **A2UI** (Google, v0.8 ⚠️) / **AG-UI** (CopilotKit)                                                                                                                                                                                                  | Possible interoperability formats: A2UI as a declarative UI spec, AG-UI as an agent↔UI event transport                                                                                                                                    | Both are young and moving. The WorkspaceSpec is our core IP, so we own it and keep it convertible. Plain SSE carries events for now.                                                                                         |
| **OpenHands** (MIT except `enterprise/` ⚠️; Software Agent SDK, MLSys 2026)                                                                                                                                                                          | Reference design for the coding agent and sandbox runtime, and possibly a dependency for a future coding workspace                                                                                                                        | The MVP isn't a coding workspace                                                                                                                                                                                             |
| Monaco / CodeMirror 6, xterm.js, three.js / react-three-fiber, CadQuery / build123d                                                                                                                                                                  | Components for the coding and engineering workspaces                                                                                                                                                                                      | Out of MVP scope. The registry design accommodates them.                                                                                                                                                                     |
| Temporal, Kubernetes, gVisor, Firecracker                                                                                                                                                                                                            | Production-grade durability and isolation                                                                                                                                                                                                 | Overkill before the concept is proven                                                                                                                                                                                        |

---

## D. Architecture

### D.1 Shape: a modular monolith with one isolation boundary

```
┌──────────────────────────── Browser (React SPA) ────────────────────────────┐
│  Workspace Renderer  ← WorkspaceSpec (validated)  ← SSE event stream        │
│   dockview layout · Component Registry (DataTable, Chart, Plan, Approvals,  │
│   Evidence, CapabilityCard, …)                                              │
│   Components emit typed ActionIntents ─────────────────────────────┐        │
└──────────────────────────────────────────────────────────────────┬─┼────────┘
                                                                   │ │ HTTP
┌──────────────────────── Reality Core (Node, trusted) ────────────▼─▼────────┐
│  API (Fastify) ── Action Router ── Policy Engine (deterministic)            │
│        │                                │                                   │
│  Orchestrator (LangGraph.js graph, Postgres checkpoints)                    │
│   ├─ Planner/Orchestrator  ├─ Analysis Agent   ├─ Capability Agent          │
│   ├─ Workspace Agent       └─ Verification Agent                            │
│        │                                                                    │
│  Task State Store · Event Log · Artifact Store · Capability Registry        │
│  Workspace Engine (spec validation, patch application, versioning)          │
│  Sandbox Manager ───────────────────────────────────────┐                   │
└─────────────────────────────────────────────────────────┼───────────────────┘
                                                          │ docker API
┌──────────── Untrusted zone (containers, no secrets) ────▼───────────────────┐
│  Exec sandbox: --network none, read-only rootfs, non-root, cpu/mem/pid/time │
│  Install sandbox: egress to PyPI only, wheels only, then discarded          │
│  Mounts: /input (ro, task data) · /output (rw, artifacts) · /caps (ro)      │
└─────────────────────────────────────────────────────────────────────────────┘
          PostgreSQL: tasks, events, checkpoints, specs, capabilities
```

### D.2 Trust zones

1. **Platform core** (trusted): API, policy engine, orchestrator runtime, workspace engine, registry. Only this zone holds secrets (LLM API key).
2. **LLM outputs** (untrusted _data_): every plan, spec patch, tool call and code string is validated with Zod and checked by policy before anything acts on it. An LLM can propose. It can't authorize.
3. **Sandboxes** (untrusted _code_): agent-written code and third-party packages. No secrets, no network by default, resource-limited, ephemeral.
4. **User content** (untrusted _input_): uploaded files may contain prompt injection. It's passed to models as data, delimited, and it never selects tools or permissions.

An untrusted component can't modify policy, the registry's trust states, or its own permissions. Those tables are written only by core code paths, never by an agent tool.

### D.3 Shared task state (the backbone)

All agents read and write **one typed TaskState** (Zod schema, persisted through LangGraph checkpoints, with an append-only `events` table as the audit log):

```ts
TaskState {
  taskId, version
  spec: TaskSpec {              // Layer 2 output, revisable
    goal, constraints[], requiredOutputs[], resources[] (artifact refs),
    risks[], acceptanceCriteria[] { id, description, checkType: 'recompute'|'schema'|'test'|'llm-judge'|'human' },
    workflow: PlanStep[] { id, agent, dependsOn[], status },
    missingCapabilities[] { need, status }, candidateWorkspaces[]
  }
  artifacts: ArtifactRef[]      // dataset, result tables, charts; content-addressed, with provenance
  capabilities: CapabilityUse[] // which registry entries are enabled for this task
  workspace: { specVersion, specId }
  approvals: ApprovalRequest[]  // pending/granted/denied, with actor and timestamp
  verification: CheckResult[]   // per acceptance criterion, with evidence refs
  budget: { tokens, usd, wallClock, used }
}
```

Agents communicate by **writing typed fields and artifacts**, not by passing chat transcripts. Each agent sees only the slice of state it needs.

### D.4 Workspace engine (core IP)

```ts
WorkspaceSpec {
  id, version, taskId, workspaceType: 'data-analysis' | ...,
  layout: DockviewSerializedLayout,                  // regions, tabs, sizes
  components: {
    [instanceId]: {
      type: 'DataTable' | 'Chart' | 'PlanView' | ...,  // must exist in registry
      typeVersion: semver,
      props: <validated by the component's own Zod schema>,
      bindings: { [prop]: { artifact: ArtifactRef, select?: Query } },  // real data only
      actions: ActionId[],                            // which typed actions it may emit
      permissions: Permission[],
      provenance: { proposedBy: 'workspace-agent'|'template'|'user', verified: boolean }
    }
  }
}
```

- **Component registry**: each entry has `{type, version, propsSchema, bindableInputs, emittedActions, requiredPermissions, testSuite}`. Only registered, tested components render.
- **Updates are patches** (`addComponent`, `removeComponent`, `updateProps`, `rebind`, `moveRegion`). They're validated against the registry, applied by the engine, versioned, and undoable. User-modified layout and component-local state are keyed by `instanceId` and survive patches.
- **Actions**: components never call tools. They emit `ActionIntent {instanceId, actionId, payload}`. The router validates it against the spec and the policy engine, then either executes a direct operation (filter, sort) or feeds it to the orchestrator as new user input, for example "add constraint", "re-run with parameter".
- **Capability → UI coupling**: a capability's registry record can declare `presentsWith: [componentType]`. When the capability becomes enabled, the Workspace Agent is prompted with that option. That's the concrete link between the two forms of adaptation.

### D.5 Capability engine (core IP)

Each capability is a registry record:

```
Capability { id, name, kind: 'python-package'|'mcp-server'|'skill'|'builtin',
  source { registry, package, version, sha256[] }, license, interface (tool schemas),
  permissions { network, fs, cpu, mem, timeout }, state: discovered|inspected|tested|enabled|trusted|rejected,
  inspection { osvFindings, licenseOk, wheelOnly, maintainers, lastRelease, notes },
  tests [{ id, description, result, logRef }], knownLimitations[], presentsWith[], history[] }
```

Lifecycle:

1. **Detect**: the planner records `missingCapabilities` when no registry tool matches a plan step.
2. **Discover**: query the allowlisted sources (MVP: PyPI JSON API plus a curated seed list).
3. **Compare**: score candidates on relevance, license compatibility, maintenance (release recency), adoption, dependency footprint and known vulnerabilities. The LLM ranks relevance. The other factors are computed deterministically.
4. **Inspect**: resolve the full dependency closure with hashes. Reject sdist-only packages (no install-time code execution). Check OSV and licenses for every dependency.
5. **Approve**: a human approval gate showing the inspection report (LangGraph `interrupt`).
6. **Install**: in an install sandbox with egress limited to PyPI, into a content-addressed layer under `/caps/<id>`.
7. **Test**: the Capability Agent writes _requirement tests_ against synthetic data with known answers. They run in the no-network exec sandbox. The tests are reviewed and stored.
8. **Enable** for the task if the tests pass. **Trust for reuse** after N successful uses with no failures, or explicit user promotion.
9. **Record** provenance and test results, and show them in the workspace's CapabilityCard.

### D.6 Agents (MVP set)

| Agent                  | Implementation                                                                             | Why separate                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Orchestrator / Planner | LLM node producing `TaskSpec` and plan revisions; graph router                             | Owns the plan                                                                  |
| Analysis Agent         | LLM tool loop writing Python and running it in the sandbox                                 | Different permissions (sandbox exec)                                           |
| Capability Agent       | Constrained workflow; LLM only for relevance ranking and test authoring                    | Different permissions (install); must not see task data unnecessarily          |
| Workspace Agent        | LLM producing spec _patches_ constrained by the registry; deterministic template fallback  | Isolated context (UI vocabulary)                                               |
| Verification Agent     | Mostly deterministic re-computation and checks; LLM-judge only for criteria marked as such | **Independence**: it must not share the producer's context or trust its claims |
| Policy layer           | Plain code, not an agent                                                                   | Must not be persuadable                                                        |

Research, Coding and Engineering agents are out of MVP scope, but they plug into the same graph and state.

### D.7 Verification and observability

- Each acceptance criterion maps to a check type. `recompute` checks run _separate_ code (written by the Verification Agent or taken from a template) on the same inputs and compare within tolerance.
- Every LLM call, tool call, sandbox run, approval and spec patch is an event with `{taskId, actor, inputHash, outputHash, cost, latency}`.
- The workspace always shows the agent activity, pending approvals, and the verification status of each result: _verified / unverified / failed / judged-by-LLM_.

---

## E. MVP: the adaptive data-analysis workspace

### Why this use case

- **Verification is tractable**: numbers can be recomputed. Coding is a crowded space (OpenHands, Claude Code, Cursor) and is hard to differentiate. Engineering can't be verified credibly at prototype stage. Research verification is mostly subjective.
- **Both adaptations show up naturally**: the workspace really changes shape (table → profile → charts → decomposition panel), and real capability gaps are easy to create honestly.
- **The capability gap is real, not staged**: the base sandbox image ships only pandas, numpy and pyarrow. Time-series decomposition, seasonality tests or forecasting (e.g. `statsmodels`) are _genuinely absent_ and have to be acquired through the full lifecycle.

### User journey (target demo)

1. The user uploads `sales_2022_2025.csv` and types: _"Is there a seasonal pattern in weekly revenue, and which regions drive it? I need numbers I can trust."_
2. **Plan**: the Orchestrator creates a TaskSpec. Goal; required outputs (seasonality finding with strength, per-region breakdown); acceptance criteria, for example _AC1: weekly aggregation totals match raw totals exactly; AC2: seasonal period identified and its strength reported; AC3: decomposition reconstructs the series (trend+seasonal+resid ≈ observed, tol 1e-6); AC4: regional contributions sum to the total_. Missing capability: `time-series decomposition`.
3. **Workspace v1** (in about 2 seconds, from a template plus Workspace Agent props): DataTable (real rows), Dataset Profile, Plan view, Agent activity.
4. **Analysis** runs profiling and weekly aggregation in the sandbox. A line chart is added _by patch_. The table keeps its scroll and sort state.
5. **Capability gap**: the Capability Agent finds candidates (statsmodels, pmdarima, prophet) and scores them. It inspects statsmodels: wheels available, BSD license, dependency closure, OSV clean. A **CapabilityCard** with the report appears, along with an **approval request**.
6. The user approves. Install happens in the install sandbox. The Capability Agent runs requirement tests: on a synthetic series with a known 52-week period and known amplitude, STL must recover the period and amplitude within tolerance. The results appear on the card. State changes to `enabled`.
7. Analysis runs STL decomposition. The Workspace Agent adds a **Decomposition panel** (stacked trend/seasonal/residual charts), as declared by the capability's `presentsWith`.
8. **Verification** runs AC1–AC4 independently. The Evidence panel shows each check with its inputs and result.
9. **User steers**: the user clicks "Exclude 2022" in the table filter → `ActionIntent` → the plan is revised → recompute → charts update → re-verification. Or they type "compare North vs South", and a grouped chart is added while the existing panels stay put.
10. A **second task** on a different dataset reuses statsmodels without a new install (registry hit, state `trusted` after promotion).

### Required components (MVP registry)

DataTable, DatasetProfile, Chart (Vega-Lite), DecompositionPanel (composite Chart), PlanView, AgentActivity, ApprovalQueue, CapabilityCard, EvidencePanel, ChatInput (conversation is one input among several, not the frame).

### MVP acceptance criteria

1. The journey above runs end to end on 3 different datasets without manual intervention, apart from approvals.
2. Every number shown in the workspace traces back to an artifact produced by sandbox execution (no LLM-stated numbers).
3. The capability lifecycle is fully recorded (discovered → … → enabled) and visible. A rejected capability is never executed.
4. Workspace patches preserve component state, and the user can undo a patch.
5. Killing the server mid-task and restarting it resumes from the last checkpoint.
6. Zero policy violations across the security test suite.

### Test cases (excerpt)

| ID  | Test                                                                                            | Expected                                                                   |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| T1  | Happy path on a synthetic dataset with a known seasonality                                      | Correct period recovered; AC1–4 pass                                       |
| T2  | Dataset with no seasonality                                                                     | Reports "no significant seasonality"; doesn't invent a pattern             |
| T3  | CSV cell containing a prompt-injection string                                                   | Treated as data; no tool or permission change                              |
| T4  | Fixture "malicious" package (sdist with `setup.py` network call) offered as top candidate       | Rejected at inspection (sdist-only); never installed                       |
| T5  | Package whose requirement tests fail (fixture with wrong output)                                | State stays `tested-failed`; not enabled; alternative tried or human asked |
| T6  | Sandbox code attempts network / reads `/etc` outside mounts / forks 10k processes / runs 10 min | Blocked or killed; event logged; task continues                            |
| T7  | Approval denied                                                                                 | Plan revises (e.g. reports results without decomposition) and says why     |
| T8  | Second task needing same capability                                                             | No re-install; registry reuse logged                                       |
| T9  | Server killed during capability install                                                         | Resume; no half-registered capability                                      |
| T10 | Invalid spec patch from Workspace Agent (unknown component, bad props)                          | Rejected by validator; fallback applied; logged                            |

---

## F. Staged roadmap

Each milestone ends with passing automated tests. Nothing is "done" on the basis of a demo alone.

### M0 — Foundations (≈1 week)

- **Deliverable**: monorepo (`apps/web`, `apps/server`, `packages/schemas`, `packages/components`, `sandbox/`), Postgres via container, CI (typecheck, lint, test), ADR folder with initial decisions.
- **Dependencies**: Node 24 (present), git, a container runtime.
- **Tests**: CI green; schema package shared by server and web.
- **Risks**: Windows tooling friction (Docker/WSL2, OneDrive file-sync on `node_modules`).
- **Out of scope**: auth, deployment.

### M1 — Task spec and durable orchestrator (≈1–2 weeks)

- **Deliverable**: LangGraph graph (plan → execute (stub) → verify (stub)), TaskSpec via structured output, Postgres checkpoints, `interrupt()` approvals, events table, SSE stream, minimal UI listing task state.
- **Tests**: TaskSpec validation on 20 prompts; kill-and-resume; approve/deny flow; budget cutoff.
- **Risks**: LangGraph.js feature gaps vs Python.
- **Out of scope**: real tools, real workspace.

### M2 — Workspace engine v1 (≈2 weeks)

- **Deliverable**: component registry, WorkspaceSpec schema, patch engine with versioning and undo, dockview renderer, components DataTable, Chart, PlanView, AgentActivity, ApprovalQueue; ActionIntent router.
- **Tests**: spec fixtures render (Playwright snapshots); invalid patches rejected; component state survives 10 sequential patches; every rendered button maps to a registered action (no dead controls).
- **Risks**: layout and state continuity edge cases.
- **Out of scope**: LLM-proposed layouts (templates only in this milestone).

### M3 — Sandboxed execution + Analysis Agent (≈1–2 weeks)

- **Deliverable**: Sandbox Manager (docker API, limits, mounts, artifact capture), base Python image, Analysis Agent tool loop, artifact store with provenance; real data in DataTable and Chart.
- **Tests**: T6 security suite; deterministic outputs for fixed code; no secrets in container env.
- **Risks**: Windows container performance; cold-start latency.
- **Out of scope**: package installation.

### M4 — Verification (≈1 week)

- **Deliverable**: acceptance-criterion → check mapping, recompute checks, EvidencePanel, verification status on every result.
- **Tests**: seeded wrong answers are detected; AC check coverage reported.
- **Risks**: Verification Agent copying the producer's mistakes. Mitigate with separate context and separately written code.
- **Out of scope**: LLM-judge for subjective criteria beyond labeling.

### M5 — Capability engine v1 (≈2–3 weeks) — _core innovation_

- **Deliverable**: registry and lifecycle states, PyPI discovery, deterministic scoring, inspection (wheel-only, hashes, OSV, licenses), approval gate, install sandbox, requirement tests, provenance, reuse, CapabilityCard.
- **Tests**: T4, T5, T8, T9; registry trust states writable only by core code paths.
- **Risks**: dependency-resolution complexity; flaky installs; quality of requirement tests.
- **Out of scope**: MCP servers, npm packages, self-authored tools.

### M6 — Integrated adaptive slice + evaluation (≈2 weeks)

- **Deliverable**: Workspace Agent (LLM patches with template fallback), `presentsWith` coupling, the full journey from section E, an eval harness, and a baseline.
- **Tests**: the full T1–T10 suite; eval report (section G metrics) vs. baseline.
- **Risks**: workspace relevance may not beat the baseline. That's an honest result and a reason to iterate.
- **Out of scope**: polish, multi-user.

### Done beyond M6

- MCP servers as a capability source (ADR 0009).
- Testing on real public data.
- Correlation and forecasting recipes (ADR 0011).
- Accounts and per-account data.
- Single-image deployment and an optional gVisor sandbox runtime (ADR 0010).

### M7 — Projects and persistent agents (v0.2, ADR 0012)

A **project** is a long-term goal with a tree of tasks. Each task is an ordinary Reality task,
with its own plan, approvals, sandbox runs, verification and workspace.

- **Decomposition.** A project planner turns the goal into tasks with dependencies. With
  Claude, this uses structured output validated like task plans. Without a model it is
  deterministic: one task per line or numbered item of the goal. Each task gets the project's
  data. The user can add tasks and dependencies at any time.
- **Workers.** A scheduler runs tasks whose dependencies are done, up to a parallelism limit,
  independently of any browser. State lives in Postgres, so a restart continues where it
  stopped. Running tasks resume from their checkpoints, as before.
- **Handoffs.** A task can depend on another task's result. The upstream task's main result
  table becomes the downstream task's input data, with provenance.
- **Policy, not a model, decides about autonomy.**
  - _Ask for every plan_ (default): every plan waits in the inbox.
  - _Ask only for critical decisions_: plans that use only reviewed recipes or reviewed tools,
    within budget and with no capability to acquire, are approved automatically. The approval
    is recorded with its reason. AI-written code, capability installations and anything
    outside the policy always wait for a person.
- **Budgets per project**: maximum number of tasks and sandbox minutes. When a budget is
  reached, nothing new starts and the project says why.
- **Inbox**: one place for every decision waiting on the user, across projects and tasks, with
  a count in the navigation and the browser tab.
- **Project workspace**: the goal, progress, a board of tasks (waiting, running, needs you,
  done, failed), dependencies, budget use and an activity log. Each task opens its own adaptive
  workspace.
- **Acceptance**:
  - A project of several tasks with a dependency runs to completion with at most the
    configured parallelism.
  - The handoff carries the upstream result.
  - Policy approvals happen only for allowed plans and are recorded.
  - Budgets stop new work.
  - A server restart mid-project resumes.
  - Accounts see only their own projects.

### Rocket lab (done)

Five lab engines take a bot from "a rocket that puts 15 t in orbit" to numbers it can
defend. Each one is checked independently, with no shared code or libraries.

- **Rocket engine** (`rocket_engine`).
  - What it does: chemical equilibrium with Cantera, the way NASA CEA does it. It uses 72 C/H/O/N species from the NASA thermo database and CEA propellant enthalpies.
  - It covers shifting-equilibrium nozzle flow, Isp, an O/F sweep, sizing, an 80 % bell contour and the Bartz throat heat flux.
  - Cantera is acquired as the `combustion` capability, after the user approves. Its requirement test reproduces two textbook flame temperatures.
  - Check: a mass balance (O/F from the composition); energy and mass flow conserved at every station; a sonic throat; an ideal-rocket model as a second opinion.
  - Reference points:

    | Engine | Reality | Reference |
    | ------ | ------- | --------- |
    | SSME   | 463 s   | ~465 s    |
    | Raptor | 371 s   | 371 s     |
    | Merlin | 337 s   | 337 s     |

- **Staging** (`launch_vehicle`).
  - What it does: the rocket equation with structural fractions, recovery reserves and the delta-v split that gives the lowest liftoff mass.
  - Check: numerical integration, mass bookkeeping and optimality against 10 m/s moves.
- **Ascent** (`ascent_trajectory`).
  - What it does: a point-mass flight over a rotating Earth with the 1976 standard atmosphere, Mach-dependent drag, throttling, staging and fairing jettison. The pitch program is optimised; trajectories that dive back into the air are ruled out.
  - Check: every second is re-flown with an independently written force model and integrator.
  - Reference point: a Falcon-9-class vehicle reaches max-Q of 40 kPa at 67 s and cuts off its booster at 148 s.
- **Tanks** (`rocket_tanks`).
  - What it does: pressure plus hydrostatic head, yield and ultimate factors, and NASA SP-8007 buckling, with walls thickened until they hold.
  - Check: slice integration of the tank profiles.
- **Vehicle CAD** (`rocket_cad`).
  - What it does: the stages, tanks and domes, engine clusters, interstage, grid fins, legs and an ogive fairing, exported as STEP and meshes.
  - Check: the CAD check.

Task pages now draw lab results as the chat does: nozzle contour, trajectory, stage masses, tank masses and CAD.

Limits:

- No CFD and no finite-element shells; the tanks are unstiffened.
- The ascent is planar.
- These numbers support a preliminary design, not a build.

### Design by hierarchy (done)

The idea behind engineering world models such as Skyfall's SKY-001: do not write one long
CAD script, plan the object part by part. Reality does it with a spec instead of code
(`design_assembly`):

- **Spec.** Assemblies with placements that compose down a tree. Parts built from 13 primitives
  (box, cylinder, tube, cone, sphere, torus, extrude, revolve, plate, flange, bracket, bolt,
  gear) with cut/add features and linear, grid and polar patterns. Materials by name or density.
  Constraints (touch, gap) and requirements (mass, size, part count).
- **Builder.** A deterministic builder turns the spec into B-rep solids on OpenCascade, in the
  order given, and measures the result: mass, centre of mass, extents, every pair of parts
  tested for interference, distances between parts. STEP and meshes are exported.
- **Checks, two per design.** The CAD check (parts, closed meshes, volumes from triangles) and a
  design check (masses from volume and density, totals, extents, centre of mass, and the
  interference, constraint and requirement verdicts re-judged against the part boxes).
- **Why a spec.** A model plans a small, schema-checked document, not code. A bad spec fails
  validation before anything runs; a bad design is measured, not argued about.

Limits: the design check cannot redo the kernel's intersections and distances; it re-derives
everything else and bounds those two by the part boxes. No sketch constraints, no assembly
mates solver, no sheet-metal or surfaces.

### Circuit boards (done)

`pcb_design` takes parts (footprints), nets and rules and returns a placed, routed two-layer board.

- **Footprints.** Chip parts 0402 to 1206, SOIC, TSSOP, SOT-23, DIP, pin headers, mounting
  holes, test points, or any footprint given as pads.
- **Placement.** Simulated annealing on wire length with parts kept apart and connectors pinned
  to an edge; parts can also be fixed by hand.
- **Routing.** A* on a grid, both layers, 45-degree tracks, vias, power nets wider and necking
  down at tight pads, rip-up and retry with a time budget. Unrouted nets are reported, never
  hidden.
- **Output.** A KiCad 8 board file, Gerber copper (top, bottom) and outline, an Excellon drill
  file and a bill of materials. The table behind the drawing is the verified artifact.
- **Check.** It does not use the router's grid or distances: every copper item becomes a signed
  distance function and each clearance is measured by sampling one against the other;
  connectivity is rebuilt from touching copper; widths, vias, annular rings, the board edge and
  part overlaps are re-judged; the exported board file is parsed and its tracks, vias,
  footprints, pads and track length are compared with the table. Falsified boards (a short, a
  deleted track, a wrong length) fail.
- **Tested** on a 555 timer board and a 16-part, 12-net board with a SOT-23-5 and SOIC parts.

- **KiCad as a third opinion.** The exported boards load in KiCad 8.0.9 (`kicad-cli`, official
  Docker image `kicad/kicad:8.0`). Its own design-rule check finds no errors and no unconnected
  nets on the 555 board and the 16-part board; the only notes are about the missing footprint
  library "Reality" (the footprints are embedded). Opt-in test: `RUN_KICAD_TESTS=1`.

Limits: no copper pours or planes, no impedance control, no parts on the bottom side, no
schematic. Reference designators sit on the fabrication layer, not the silkscreen, so they never
collide with pads.

### Bots that design (done)

The lab engines are the hands; the model (Muse Spark through the bots) writes the specs. The
loop is the one Astra's demos show, with the check that its demos lack:

1. The bot reads the engine (`list_engines` with a name gives the full description and the
   parameter schema; without a name it lists one line per engine).
2. It writes the spec as parameters and runs it (`run_simulation`).
3. It reads the checked result in the chat: every number and the lists a redesign depends on
   (parts that intersect, unrouted nets, missed constraints and requirements). Before this
   change a bot saw only scalar values and could not tell what to fix.
4. It changes exactly those things and runs again. Missions run this unattended and judge by
   code: a design counts only when the criteria are met by an independently checked result.

Tests: a scripted model runs the loop end to end (a board walled in by mounting holes cannot
be routed, the bot sees `unrouted=["A"]`, fixes the spec, the second run passes, the mission is
verified). `npm run eval:design [pcb|assembly|rocket] [minutes]` runs three real design
missions with the configured model in a scratch database; it needs the model key and has not
been run yet, so how well Muse Spark writes these specs is still open.

### Boards you can watch (done)

What a design looks like matters as much as whether it is right, so the board has a real 3D
view and the desktop shows the real program.

- **Part bodies.** The engine describes every part as a few bodies (size, colour, material):
  chips with leads and pin-1 marks, chip resistors with end caps, ceramic capacitors, LEDs that
  glow, pin headers with gold pins, DIP packages. They go to `scene.json` for the web view and
  to one VRML model per distinct part for KiCad.
- **3D view (three.js, nothing loaded from outside).** Soldermask over FR4 with drilled holes,
  gold pads and vias, copper under the mask, silkscreen and chip markings on textures,
  reflections from a room environment, soft shadows on a lit stage. Top, bottom, exploded and
  full-screen views. The build plays like the work happened: the board slides in, parts drop
  on, the ratsnest glows, tracks grow, the check badge lands; scrub or replay.
- **KiCad's own viewer.** The board file references the models as `${KIPRJMOD}/model_*.wrl` with
  the 1/2.54 scale KiCad expects. Checked with `kicad-cli` 8.0.9: the VRML export loads them
  (colours present, a header pin comes out 0.64 x 0.64 x 11 mm at the right place). The CLI
  exports models only for STEP, so the on-screen look in KiCad's viewer itself is not checked.
- **Lab to desktop.** A finished lab result is copied to the bot's computer (text files only)
  and opened in the real program: a board in KiCad, first as it stood after placement with the
  ratsnest of what is still to connect, then routed; an assembly in FreeCAD. It happens by
  itself when the bot's computer is already running; the tool `open_lab_result` starts the
  computer and shows it. Tested on a real bot computer.
- **The image.** `sandbox/computer` builds `reality-computer:dev`: KiCad 8.0.9 (project PPA) and
  FreeCAD 0.21.2 (maintainers' PPA; the Ubuntu 22.04 versions are KiCad 6 and FreeCAD 0.19 and
  cannot read what the lab writes), xdotool, CadQuery. The home is not built from /etc/skel, so
  the start command copies KiCad and FreeCAD settings and empty library tables in; without them
  both programs ask configuration questions in front of every file.
- **KiCad on the desktop.** `pcbnew` opens the placed board (Unrouted 15 in the status bar),
  waits on the window title until the file has loaded, fits the view (Home), closes it, opens the
  routed board (Unrouted 0), opens the 3D viewer (Alt+3), makes it fill the screen and tilts the
  board with a stepped mouse drag (one instant jump is ignored; the X/Z keys turned it edge-on).
- **FreeCAD on the desktop.** The engine writes all parts once into one BREP file (`parts.brep`,
  the kernel's own format) with names and colours in `build.json`. A script reads it and makes
  each part its own object, inside to outside (shafts, fan, compressor, combustor, turbine,
  exhaust, accessories, then casing and nacelle at 72% transparency), shaded with a metal
  material on a dark background, the camera fixed on the finished size. About 1,900 parts in
  under a minute. STEP files per group were the first try: importing them took four minutes and
  froze the screen during each import, and `recompute` after each took longer than the build.
  `live.log` on the desktop shows progress.
- **A bot's eyes and hands.** `computer_screen` returns a picture, the window list and the text
  on screen with exact positions (scrot, ImageMagick x3, tesseract). `computer_input` is one
  xdotool action per call and returns the new screen; `click_text` finds a label and clicks it.
  Muse Spark reads pictures through the Anthropic-compatible API, but its aim from a picture
  alone was up to 200 px off on small buttons: three times it missed Run DRC, and once reported
  "0 violations" from a list that was empty because nothing had run. With OCR positions it
  hits first time, and what it reports matches the screen. Those steps have their own allowance
  in a turn (a click per step used up the ten steps), only the newest picture stays in the
  conversation, and a turn that acted on the desktop is asked to look at the result before it
  ends. Nobody operates the desktop while a result is being brought onto it, and asking again
  for a result already open does not reopen it, which would lose hand edits.
- **After a hand edit.** `recheck_board` reads the file from the computer. Engine `pcb_recheck`
  parses it with an S-expression parser (KiCad reformats files it saves), measures with analytic
  distances and writes the same table as the design engine; check `pcb_recomputed` measures
  again and also compares every pad's net with the original file. Copper zones and arcs fail
  the board with a message: they are not judged. The fixture
  `test/fixtures/board-saved-by-kicad8.kicad_pcb` is a board KiCad itself saved.
- **CUSTOM footprints in 3D.** A generic moulded body over the pads, gold pins through
  through-hole pads, silver leads on surface pads and a pin-1 mark. Not the real shape.
- **Checks.** `npm run eval:desktop`, `eval:desktop-cad` and `eval:desktop-drive` (real model)
  run on a real computer and keep pictures of the screen.

- **Through the real interface (browser, Muse Spark).** Board, DRC from the menu, take over, a
  track deleted by hand, hand back, re-check: "6 of 7 nets routed, VCC unrouted"; then the turbofan
  growing live in the panel. This found what the API tests could not: results were reachable from
  nowhere since the workbench became computers only (now a Results tab that appears once there are
  results, computers stay in front); the automatic show closed KiCad during a take-over; a board
  could open twice; and installs in chats always failed.
- **Installs in chats wait for a person.** The chat approved installs by policy, but the
  orchestrator refuses a policy's yes for third-party code, so every install failed and the task
  still read "completed", and the bot started it again and again. Now an install comes as one card
  to approve, and a failed step's reason is in the result. Decided: this stays. A person
  approves every install, also for packages the inspection finds clean.

Not done: KiCad's own DRC result is read from the screen by the model, so it is a report, not a
verified result; the verified result is `recheck_board`. Ctrl+S did not reach KiCad through the
remote screen in the test pane (the Save icon did); not tried in a plain Chrome.

### Open-ended capability search (done)

The reviewed catalog (five entries matched by keyword) was all Reality could acquire; ADR 0007
kept open-ended search out of scope. Now what the catalog does not know is searched for.

- **Sources.** PyPI's own search page is behind a bot challenge and `pypi.org/search` returns a
  3 KB challenge page, so it is not used. Used instead: (1) a model proposes up to 8 package names
  (Muse Spark when configured), (2) ecosyste.ms keyword listings for the need's key words, (3) the
  official MCP registry's free-text search, (4) a package the request names (`[package: x]`). Each
  source can be down or wrong: the search goes on, and says what failed (`notes`).
- **Nothing a source says is believed.** Code looks every name up on PyPI: it must exist, have
  been first published at least 90 days ago, have at least 5,000 downloads last month (pypistats),
  ship a compatible wheel, carry a permissive licence, and say something about the need on its own
  PyPI page (unless a person named it). A name a model invented is not on PyPI and drops out; one
  registered recently to catch such names is too young and too unused. Measured live: the model
  proposed `cowsay` (GPL) and `astropy` (no cp312 wheel), both refused with the reason.
- **Ranking.** What it is for counts most (the match with the need, a small bonus for agreeing
  sources and the model's own order), recency and use only tip a close call; an unreviewed
  package never rates as high as a reviewed one. Live results: "turn text into ASCII art banners"
  puts `pyfiglet` first, "parse and render gerber files" puts `pygerber` first, "seasonal
  decomposition" finds `statsmodels` (from the catalog). MCP servers from the registry are listed
  and never offered, since each needs a reviewed launch configuration.
- **Then the old road, unchanged.** The best candidate gets the same offline inspection (wheels
  only, `.pth` files, OSV vulnerabilities, size), the same one approval by a person and the same
  isolated read-only layer. Its test is generic: its own modules must load from the layer
  (`loads-from-layer`); that it does what you need shows in use, and after three uses without
  failure it becomes trusted. The approval card says "Found by search, not from the reviewed
  list" and how many names were considered.
- **For bots.** `get_library` (a sentence about what it must do, optionally a package) starts a
  one-step plan; `run_python` takes `libraries: [id]` and mounts them read-only on the path. A
  library already installed is used at once.
- **Known limits.** The model proposer is only as good as its knowledge of PyPI (it knows
  popular packages, rarely niche ones); the keyword source finds niche ones but with noise that
  the filters mostly remove. A need whose best package has no wheel for CPython 3.12 (astropy at
  the time) finds nothing for it. Libraries run only in the sandbox without network; a library
  that needs data from the internet cannot work.

#### Tools from MCP servers found by search

A library is something code imports; what a bot also needs is _tools_. Until now the only MCP
server Reality could run was one entry of the reviewed catalog (DuckDB), because a server needs a
reviewed launch configuration: how to start it and which tools may be called. That is now derived
instead of reviewed, with the same rule as above: nothing a source says is believed.

- **Asking.** `get_mcp_server` (a sentence, optionally a package) is the same one-step plan with
  `[mcp]` in the need. Candidates come from a model that is asked for MCP servers published on
  PyPI that work offline, and from the official registry's search; each is verified on PyPI (it
  exists, 90 days old, at least 1,000 downloads a month, a compatible wheel, a permissive licence,
  and it calls itself an MCP server). A server that needs a secret, is hosted, or is a Node or
  container package cannot run here, and the person is told how many of those were found, not
  offered them.
- **How it starts.** Read from the server's own wheel at inspection: the console script
  (`name = module:function`) named like the package, else one that says mcp or server. Only
  plain literal arguments from the registry are passed on. A server without such a script is
  rejected: Reality has one way to start a server.
- **Which tools.** After the one approval and the install, the server is started in the sandbox
  (no network, read-only, non-root, limits) and _lists its own tools_; it must offer at least one
  (test `starts-and-lists-tools`). Those names are the only ones that can be called, stored with
  the test. Descriptions are the server's words: shown as data, never used as instructions, and
  what a tool returns is labelled as third-party data when a bot gets it.
- **Using it.** `mcp_tools` lists them, `mcp_call` calls one; each call starts the server fresh and
  tears it down.
- **Measured live** (real PyPI, real Docker, the real `mcp-server-time`, 589,169 downloads a
  month): found, inspected, approved, installed, started; it listed `get_current_time` and
  `convert_time`; a call returned the time in Europe/Berlin; a tool it did not list is refused.
- **Node servers.** Found on npm and in the registry. `npm install` runs with install scripts off,
  in its own volume, in the same locked-down sandbox plus Node (`sandbox/node`); nothing from the
  package runs before approval. The tree is read as data (names, licences, sizes, native addons,
  which packages wanted install scripts) and hashed; the hash must match at install. How it starts
  comes from the package's own `bin`, inside the package.
- **Known vulnerabilities.** On a Node package, fixes in the same major version are installed as
  npm overrides and everything is judged again; the card says what was changed and that it is not
  what the authors shipped. Measured: `@brave/brave-search-mcp-server` came in with the MCP SDK
  1.30.0 and zod 4.3.6, both with HIGH advisories; with 1.32.0 and 4.6.6 it started and worked. What
  has no such fix (`zod` 3 today) no longer rejects a tool server found by search: the person's
  decision. A clean candidate of about the same fit goes first; otherwise the
  advisories stand on the card with their severity and the button says "Approve despite these".
  Files that run code at start-up still reject, and libraries and the reviewed catalog keep the old
  rule.
- **Network.** None by default. A bot lists the domains a server needs; the person sees them on the
  card. The server then runs on `reality-tools`, an internal network apart from the computers', and
  its only way out is the gateway's proxy, with an allowlist for that container's name, for that
  call. A host it tries beyond that is refused and reported; `mcp_allow` puts a card to the person.
  A server that ignores the proxy simply has no network.
- **Keys.** A bot names the variable, never the value. The person types it on the card; it goes to
  `capability_secrets`, AES-256-GCM (`SECRET_KEY`, or a key file in `CAPABILITY_DIR`), only names the
  server declared, none that change how a program runs (`PATH`, `LD_*`, `NODE_*`, proxies). It reaches
  the container through the docker client's environment, not the command line. It is cut out of
  what comes back, and a server holding one person's key refuses other people's bots.
- **Hosted servers.** From the registry, 30 days listed, active, plain https. Nothing runs here. The
  address must resolve to public addresses, checked on every request, same host only, no redirects.
  They rank below anything that runs here, and the card says who receives the data.
- **What this is not.** A server cannot be vouched for beyond starting and listing tools: what a tool
  does shows in use, as with a library. A key in a server's environment is in reach of that
  server's code, which is why it can reach only the domains on its card. Tool containers on
  `reality-tools` could reach each other while two run at once; each lives for one call. OAuth is
  not built: a hosted server that needs a browser sign-in cannot be used.
- **Found by testing in the real interface, then fixed.** The search proposed the `mcp` SDK (a model
  said it could fetch pages; huge numbers, right words): a model's reason no longer counts as what a
  server says about itself, and what builds servers is not a server. A rejected candidate ended the
  search and the bot retried forever: the next one now gets its turn, and a chat can start four
  searches in ten minutes. An installed server turned up in a search for something else and was
  reused: only one about as good as the best is. "Brave search" got Notion and then a test server:
  names now count, each word is searched alone, and a fallback must be about as good as the best.

- **Measured without a word about tools** (`npm run eval:adapt`: 31 ordinary requests through the
  real chat with Muse Spark; the script approves everything and has no API keys). The first version
  of 20: no MCP server at all, the bot's computer nearly always, an IBAN turn ended in silence, and
  "for download" meant a file only on its computer. Now, in the last full run: 0 of 5 requests that
  need nothing started a search; 24 of 24 answers with a check held; 6 of 6 files came with a
  download link; no silent end; 4 of 4 craft jobs used a skill, and it was the fitting one. Most
  checks only test that an answer contains the right thing; live values (weather, exchange rate,
  stars) were not checked independently; one run proves less than it looks, since a bot's choices
  vary between runs.
- **The reviewed list of servers** (`capabilities/servers.ts`). Searching for each job lost to the
  computer: of 7 requests where a server fits, one used one. So the jobs that come up all the time
  now have a server known to work: GitHub (read only), arXiv, Wikidata, OSV, library documentation,
  documents to text, web search with or without a key, reading pages, time zones. Each was started
  and called against its real service, and must pass that call again before it is enabled; a search
  is skipped, a person still approves, and files are still inspected. `npm run eval:servers` checks
  them all, since services change. Checks had to be hard: `wikipedia-mcp` passed one because its "no
  results" message repeated the query, and it was off the list once that was seen (it could not
  reach Wikipedia from the sandbox). Two servers needed Node 24, so the image moved. Known vulnerabilities
  remain on two of them (`server-github` also is no longer developed by its authors): the card says so.
- **Measured.** All 31 requests, with the list: a server was used in 6 of the 7 requests where one
  fits (before: 1), 23 of 24 checked answers held, 5 of 6 files came, 3 of 4 craft jobs used a skill
  (the fourth got stuck on an SDK version and said so), no silent end. But a question about tomorrow's
  weather cost the person cards too, and one request that needs nothing started a search. So reading
  one page and time zones are no longer named to bots unasked, though the list still serves them. A
  run of the 13 requests this touches, after that: 12 of 12 checked answers held, all 3 server jobs
  used one, the request that needs nothing started no search. That is the last prompt on 13 requests,
  not on all 31. The answers' checks stay rough, and a bot's choices vary between runs. The SQLite job
  stays on the computer: a server here starts fresh for each call and could not keep a database.
- **Files.** A person can attach a file to a chat (up to 25 MB), stored as theirs. A bot passes files to
  a tool (`files` on `mcp_call`: a file of this chat, a path on its computer, an example dataset);
  the server sees them read-only at /input. Whatever the server writes to /output, or returns as an
  image or embedded file, goes to the person as a download, under a cleaned name. `take_file` puts a
  chat file on the bot's computer. Hosted servers get no files: that would hand them to a third party.
  Measured: a bot got MarkItDown by itself and read an attached PDF (a small one made for the test;
  scanned or complicated ones are not tried); a CSV was totalled and came back as a download, that
  time on its computer; SQL over an attached CSV writing to /output is an end-to-end test. A server
  still starts fresh for each call, so nothing a tool writes elsewhere survives.
- **Fixes from that test.** Bots had 4,000 tokens per step: a big file was cut off mid-call and the
  turn ended on "building it now". They now have 16,000, and a cut answer is told to go again in
  parts. Steps per turn went from 10 to 20. A turn that worked and ends without words is asked once
  to say what came of it, or says it stopped; a promise with no call behind it is held to its word
  (by phrasing, so not every time). `share_file` hands a file over in pieces, checked by hash (3 MB
  measured). A model can rule out servers and skills whose description is for something else ("search
  recent" made an issue tracker fit arXiv; "database" made DuckDB fit OSV), and cannot bring one in. A
  server that would not start is not put before a person again, unless it now gets a key.
- **Skills** (`capabilities/skills.ts`, tools `get_skill`, `read_skill`). Know-how from GitHub: a folder
  with a SKILL.md and perhaps scripts. Reality looks through `anthropics/skills`, `obra/superpowers`
  and repositories found by search, pins a commit, and reads everything as text. Floors: 100 stars,
  90 days old, not archived, a licence that allows it (the skill's own first: `pdf`, `docx` and the
  like in `anthropics/skills` are proprietary and refused). Invisible characters and text telling a
  bot to ignore its rules or hide things reject it; piped downloads, credential files and the like
  go on the card, with its scripts, the addresses it mentions and what it tells a bot to do. Only an
  approved skill can be read, by its owner's bots. Its text reaches a bot marked as third-party, only
  when it asks; its scripts land on the bot's computer. GitHub's API allows 60 requests an hour
  without a token and the tests used them up, so the commit comes from git's endpoint and the file
  list from jsDelivr (`GITHUB_TOKEN` raises the limit).
- **What skills are not.** The scan catches crude attacks, not a clever text; what limits that is that
  a skill brings no keys or rights, and the computer holds none. But a skill's text does steer a bot,
  and a script on the computer can reach what the computer can.
- **Do skills make results better? Measured: no** (`npm run eval:skills`). Four craft jobs, four runs
  with the skill approved and four with it denied, compared pairwise by a model that did not know
  which was which, sides swapped at random, pages by a rendered picture. Skill wins to losses: landing
  page 5 to 11, MCP server 1 to 11, browser test 8 to 8. Generative art could not be judged: in those
  runs the bot fetched no skill. The MCP server's reasons were consistent: the skill's version wraps
  one number in a Pydantic model and returns JSON, for a brief that said small. Run for real, all
  seven servers converted correctly under the SDK before 2.0, and all seven failed on import under
  the current 2.3, with or without the skill (`mcp.server.fastmcp` was renamed). What this does not
  show: four runs per side are few, the pairs of one job are not independent, there was one judge
  (a second, independent model was planned, but no key for it is configured), and the first judging
  was unfair and redone: the page render had blocked web fonts, which hurt the design skill, and
  allowing them moved the score only from 4 to 5. So bots no longer fetch a skill by themselves; it
  costs the person a card for no shown gain. They still can when a person asks.
- **Code a bot hands over must run today.** All seven MCP servers from the skill comparison failed on
  import under the current SDK: bots wrote the API they remembered and only compiled it. Bots are now
  told to install the current release, run the program as its user would and use it once, and to say
  the version. Measured by starting the delivered file in a fresh sandbox with the newest SDK and
  speaking the protocol to it: 5 of 5 ran and returned 212 for 100 (`npm run eval:adapt`, job
  `buildserver`). Steps per turn went to 30, since real testing takes them. This was measured on this
  one job, and it is a rule in a prompt rather than a gate in code.
- **Last full run, all 33 requests:** 27 of 27 answers with a check held, 7 of 7 files came with a
  link, a server was used in 6 of the 7 requests where one fits, none of the 5 that need nothing
  started a search, no silent end, no skill fetched unasked. One run, and the checks stay rough.
- **A slow machine no longer fails a right result.** Independent checks had 60 seconds; under load a
  correct design was reported as failed. They now have five minutes.

### M8 — Coding workspace

Monaco editor, a terminal into a persistent per-project sandbox, git, and tests as the
verification criterion. Needs the AI analyst to write code; infrastructure testable without
it.

### M9 — Research workspace

Collect sources, extract claims, verify quotes verbatim against the fetched source, and write a
report where every statement links to its evidence.

### M10 — Self-authored capabilities

An agent writes a tool, writes its tests, and runs both in the sandbox. A person approves the
tool, which then joins the capability library through the same lifecycle as acquired
packages.

Later: MCP registry search, MCP Apps for isolated third-party UI, simulation and CAD tools,
microVM isolation, external notifications.

**Rough total to MVP: 10–13 weeks for one experienced engineer working with AI assistance.** This is an estimate, not a commitment.

---

## G. Evaluation

**Prototype metrics (kept to a small set):**

1. **Correctness vs acceptance criteria**: share of ACs passed across the task suite.
2. **Verification coverage**: share of displayed results with a machine check.
3. **Capability integration success**: correct candidate chosen, installed and passing its tests / gaps encountered.
4. **Security policy violations**: must be 0 on the red-team suite.
5. **End-to-end latency and cost per completed task.**
6. **Workspace usefulness**: blind rating by 3–5 people (adaptive vs. baseline), plus time-to-answer for scripted follow-up questions.

**Baseline**: the same models and agents, with a fixed chat-plus-table UI and a fixed tool set (no discovery). If the adaptive version doesn't win on (1), (6) or time-to-answer, the adaptive machinery hasn't earned its cost yet, and we should know that early.

**Task suite**: 15–20 analysis tasks over 5 datasets (synthetic with known ground truth, plus 2–3 public real-world datasets), each with written acceptance criteria. Version the suite and re-run it on every milestone.

---

## H. Open questions

**Essential (they block or reshape M0–M3):**

1. **Container runtime on the dev machine.** Docker, git and Python are not currently installed here. Can we install Docker Desktop (WSL2) or Podman? If not, the fallback is Pyodide-in-Deno sandboxing, which works but caps package choice.
2. **LLM provider and budget.** Assumed: Anthropic Claude API, with the key held only by the core service.
3. **Confirm the MVP domain** (data analysis) over the alternatives (coding, engineering).

**Assumed unless told otherwise:** single-user local prototype, no auth; English only; proprietary licence for Reality itself, so we avoid AGPL dependencies in the core; the project folder stays where it is (consider moving it out of OneDrive to avoid sync issues with `node_modules` and Postgres data).

---

## Sources

- npm registry: [@langchain/langgraph](https://registry.npmjs.org/@langchain/langgraph/latest), [@modelcontextprotocol/sdk](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest), [dockview](https://registry.npmjs.org/dockview/latest)
- LangGraph checkpointer: [Arch package](https://www.archlinux.org/packages/extra/any/python-langgraph-checkpoint-postgres), [GitLab advisories](https://advisories.gitlab.com/pkg/pypi/langgraph-checkpoint-postgres/), [release notes](https://releasebot.io/updates/langchain-ai/langgraph)
- MCP: [versioning](https://modelcontextprotocol.io/docs/learn/versioning), [2026-07-28 changes](https://www.developersdigest.tech/blog/mcp-2026-07-28-breaking-changes), [MCP Apps overview](https://www.morphllm.com/mcp-apps), [MCP Apps spec 2026](https://mcp.directory/blog/mcp-apps-spec-2026-when-should-your-server-render-ui)
- OpenHands: [GitHub org](https://github.com/orgs/OpenHands/repositories), [SDK paper (MLSys 2026)](https://proceedings.mlsys.org/paper_files/paper/2026/hash/8ae9cf363ea625161f885b798c1f1f78-Abstract-Conference.html), [rywalker summary](https://rywalker.com/research/openhands)
- Sandboxes: [Helix self-hosted comparison](https://helix.ml/blog/self-hosted-agent-sandboxes), [Agent37 Daytona alternatives](https://www.agent37.com/blog/daytona-alternative), [Morph E2B vs Daytona](https://www.morphllm.com/comparisons/e2b-vs-daytona)
- Generative UI protocols: [CopilotKit AG-UI generative UI specs](https://docs.copilotkit.ai/ag-ui/concepts/generative-ui-specs), [A2UI guide](https://dev.to/czmilo/the-a2ui-protocol-a-2026-complete-guide-to-agent-driven-interfaces-2l3c)
- Vercel AI SDK 6: [announcement](https://vercel.com/blog/ai-sdk-6), [licenses.dev](https://licenses.dev/npm/ai/6.0.235)
- Data: [DuckDB-Wasm](https://duckdb.org/library/duckdb-wasm/), [DuckDB in Pyodide](https://duckdb.org/2024/10/02/pyodide)
- Layout: [dockview docs](https://dockview.dev/docs/overview/introduction)
