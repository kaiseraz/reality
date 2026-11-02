# ADR 0012 — Projects and persistent agents (M7)

Status: accepted

## Context

The v0.2 vision (execution plan, section A2) adds always-on agents. They work towards a
long-term goal, in parallel, in the background, and ask for approval only where it matters. The
MVP already ran each task on the server, with checkpoints in Postgres and recovery after a
restart. It had no notion of a goal larger than one task, no scheduling, no handoffs and no
autonomy beyond "ask for everything".

## Decisions

1. **A project is a tree of ordinary tasks.** Each project task is a normal Reality task, with
   its own plan, approvals, sandbox runs, verification and adaptive workspace. A
   `project_tasks` row adds its position, its dependencies (task ids) and the task whose
   result it receives. No second execution path exists. Everything proven for single tasks
   also holds for project tasks.
2. **Decomposition.**
   - With Claude, the goal is decomposed through structured output (`AnthropicProjectPlanner`,
     implemented and unit-tested through validation, not exercised live).
   - Without a model, the planner is deterministic. It creates one task per numbered or bulleted
     item, or per line. "Then …" or "using the result" makes a task depend on the previous one
     and receive its result. It never invents work.
   - Users can pass their own task list and add tasks later.
   - All plans are validated: indices in range, no cycles, within the task budget.
3. **The scheduler is a loop over database state.**
   - Every 2 seconds, and immediately after changes, one pass looks at each active project. It
     applies the policy, detects completion or a blocked state, and starts tasks whose
     dependencies are done, up to the project's parallelism.
   - Passes never overlap. A call during a pass queues exactly one more.
   - `started_at` is written before inputs are attached, so a restart never attaches them
     twice. Running tasks resume from their checkpoints as before.
   - It runs in the server process, independently of any browser. Multi-process scheduling is
     out of scope until there is more than one server process.
4. **Handoffs carry data, not text.** The upstream task's main result table, chosen by a fixed
   order (forecast, correlation, query, seasonality, breakdown, totals), is copied into the
   downstream task with `handoff` provenance and becomes its working dataset. If there is no
   result table, the log says so and the task uses the project data.
5. **Autonomy is decided by deterministic policy, never by a model.**
   - _ask-every-plan_ (default): every plan goes to the inbox.
   - _ask-critical_: a plan is approved by the policy only if it uses reviewed recipes or
     reviewed MCP tools exclusively, needs no new capability, has a machine check for every
     acceptance criterion, and the budget allows it.
   - Policy approvals are recorded with the actor `policy` and their reason. The API forces
     `by: 'user'`, so no caller can act as the policy.
   - The graph refuses capability installations approved by the policy, as defence in depth.
   - Each deferral is logged once, with its reason (deduplicated against the log, so also
     across restarts), and shown in the inbox.
6. **Budgets.** Each project has a task budget and a sandbox-minutes budget. Adding tasks beyond
   the task budget is refused. When the sandbox minutes are spent, the project stops starting
   work and says why.
7. **Inbox.** One list of every decision waiting for the account, across projects and single
   tasks, with the policy's reason. Plans can be approved from the inbox. Capability
   installations open the task, where the inspection report is. The count appears in the
   navigation and the browser tab title.

## Consequences

- Without an AI model, projects are limited to what the goal states line by line, and to the
  built-in recipes. With Claude, open-ended goals can be decomposed, but that path has not
  been run live.
- Notifications are in-app (inbox, tab title). E-mail, push and webhooks are not built.
- The scheduler polls. With hundreds of active projects, it should move to event-driven wake-ups
  or `LISTEN/NOTIFY`.
- Agents are still roles inside one task workflow. "Persistent runtimes" per agent (M8: a
  per-project sandbox for coding) are not part of M7.
