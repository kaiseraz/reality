# ADR 0006 — Workspace engine v1 (M2)

Status: accepted

## Decisions

1. **One engine, shared by server and browser.** `@reality/workspace` (pure TypeScript, no I/O) holds the component registry, patch application, inverse computation and templates. The server is authoritative: it applies patches under a row lock (`SELECT … FOR UPDATE`) with optimistic concurrency (`baseVersion` must equal the current version).
2. **The registry is the only source of UI.** Each component declares a Zod props schema (strict, so unknown props are rejected), typed inputs (`artifact` with accepted media types, or `task` with a fixed state path), its actions with payload schemas, and a default region. Chart props are a constrained, typed subset that we translate into Vega-Lite ourselves. Raw Vega-Lite specs are never accepted, which keeps data URLs and expressions out.
3. **Bindings are checked against real data.** Patches may only bind artifacts belonging to the same task, and Chart field references must exist as columns of the bound dataset.
4. **Every op has an exact inverse.** `updateProps` gained `replace` and `rebind` accepts `null`, so undo is lossless. Undo is a new version (append-only history in `workspace_patches`). It reverts the most recent content patch that hasn't been undone and skips layout-only patches. Redo is out of scope.
5. **Actions go through a router.** Components emit `ActionIntent`s. The server accepts one only if the instance exists, the instance declares the action, the registry defines it, and the payload validates. It logs `workspace.action` before dispatching (for now, `ApprovalQueue.approve/deny` → orchestrator). A registered action without a handler is an error, never silently ignored. Paging and sorting in DataTable are local view queries, not actions. The renderer test enforces that every button is either a declared action (`data-action`) or a local control (`data-local`).
6. **The renderer reconciles; it never regenerates.** Dockview panels are keyed by `instanceId`. A pure planner (`planPanels`) adds, removes or retitles, so surviving panels keep their React state across patches. Placement order anchors the side column first, so later splits don't span the whole width.
7. **Layout is persisted only after user input.** Dockview reports layout changes asynchronously, so automatic placement can't be told apart by a flag. A layout change is saved, as a `setLayout` patch attributed to the user, only within 1 s of pointer or keyboard input inside the dock.
8. **Minimal artifact store now, not in M3.** Components need real data, so CSV upload landed here. Files are content-addressed (SHA-256) under `.data/artifacts`, with metadata and inferred column types in Postgres, an integrity check on read, and limits of 20 MB and 200 columns. Duplicate headers are rejected (papaparse would otherwise silently rename them).
9. **Templates are the only composer in M2.** The template gives every task Plan, Approvals and Activity. Attaching a CSV adds a DataTable, plus a Chart only when the data really has a date column and a numeric column. Provenance (`template`, `user`, later `workspace-agent`) is stored on each instance. The LLM Workspace Agent (M6) will propose patches against the same engine.

## Deviations from the plan

- TanStack Table was not added. A server-paged HTML table covers M2's needs with no extra dependency.
- `packages/components` became `packages/workspace` (definitions and engine). React renderers live in `apps/web/src/workspace`.

## Known gaps

- Not verified in a real browser via automated tests (no Playwright yet). The renderer is covered by jsdom tests plus a manual browser walkthrough (create, attach CSV, chart, sort, approve via panel, undo, layout persistence across reload).
- In-memory parsed-CSV cache is unbounded per process. Fine for the MVP's dataset sizes; we'll revisit with M3's artifact work.
- No redo. Undo history can't cross a removed artifact (no artifact deletion exists yet).
- Bundle size: main chunk is about 700 kB minified (React, dockview, Zod). Vega (about 800 kB) is lazy-loaded only when a chart renders. Splitting further is deferred until load time matters.
