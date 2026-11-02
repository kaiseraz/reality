# ADR 0005 — Orchestrator, planner and persistence (M1)

Status: accepted

## Decisions

1. **LangGraph.js for orchestration, without LangChain model wrappers.** The graph (`plan → approve → execute* → verify`) runs on `@langchain/langgraph` with the Postgres checkpointer in its own `langgraph` schema. Claude is called through the official `@anthropic-ai/sdk`, not `@langchain/anthropic`. That gives direct access to current API features (structured outputs via `betaZodOutputFormat`, effort, server-side refusal fallback) with one less abstraction layer.
2. **The model proposes, validation decides.** The planner returns a flat `TaskSpecDraft` (structured output). The orchestrator then validates it with the stricter `TaskSpec` (unique ids, valid dependencies). Validation errors go back to the model for another attempt, bounded by a model-call budget (default 3).
3. **Human approval is a real graph interrupt.** `interrupt()` persists the paused run. Approval resumes with `Command({ resume })`, even from a different process after a restart.
4. **One step per graph super-step.** Every plan step is its own checkpoint, so a crash re-runs at most the interrupted step. This is verified by an end-to-end test that SIGKILLs the server mid-execution.
5. **Plain `pg` + forward-only SQL migrations instead of Drizzle.** Two tables (`tasks`, `events`) don't justify an ORM yet. We'll revisit when the schema grows (M5 capability registry).
6. **Events: append-only table + SSE.** Live fan-out is in-process. Clients resume via `Last-Event-ID`, replayed from Postgres, so nothing depends on in-memory state surviving a restart.
7. **No fabricated results.** Until executors (M3) and checkers (M4) exist, steps are recorded as `not_executed` and criteria as `unverified`. The offline `FakePlanner` (used when no API key is set) is labelled in the health endpoint, the logs and the UI.

## Consequences / known gaps

- Status updates and event appends are not in one transaction with the checkpoint write. A crash between them can leave a stale `tasks.status`. `recover()` re-derives state from the checkpoint at startup, which covers the cases tested so far.
- In-process SSE fan-out means a single server instance. Multi-instance needs Postgres `LISTEN/NOTIFY`.
- The 20-prompt TaskSpec evaluation against the real model is pending until an API key is configured.
- `langsmith` is a transitive dependency of `@langchain/core`. Tracing stays off unless `LANGSMITH_TRACING` is set, which we don't do.
