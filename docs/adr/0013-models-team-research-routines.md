# ADR 0013 — Model providers, bots, research, pages and routines

Status: accepted

## Context

For the Meta Global AI Developer Hackathon, Reality has to run on Meta models, and the v0.2
vision needs more than one-off tasks:

- a team that keeps working,
- answers to questions that come without data,
- results that are kept and improved,
- work that starts itself.

Several of these pieces existed in the earlier prototype Astra, as plain JavaScript with
JSON files. They were ported, not copied. Each piece runs through the existing task path,
with typed contracts and Postgres state. Each one is checked by the same verification as
every other result.

## Decisions

### 1. Model providers behind one structured-output contract

`StructuredModel` (`llm/structured.ts`) is the only place that talks to a model. Planner,
analyst, project planner and synthesizer all use it.

- **Claude** uses native structured outputs.
- **Meta Muse Spark** is reached through its Anthropic-compatible endpoint. It uses a forced
  single tool whose input schema is the Zod schema as JSON Schema, plus a JSON-in-text fallback.
- `PLANNER=auto` picks Meta when `META_MODEL_API_KEY` is set, then Claude, then rules.
- Every output is validated afterwards. Parsing is never trust.
- `eval/meta-probe.ts` checks a real key end to end.

### 2. Success criteria and evidence

A person can set criteria before a run, for example "trend per year between 1.4 and 2".
Planners never change these criteria, and they lock once the task runs. After the run, each
criterion is checked against numbered evidence (B1…) taken from step summaries. The verdict is
verified, partial, not verified, refuted, or no criteria. Numbers in AI-written step output that
do not appear in the evidence are flagged.

### 3. Bots as persistent team members

A bot is a name, a role and a colour. Its status (working, waiting, idle) is derived from its
tasks and never stored.

- Tasks can be given to a bot directly.
- A project's team shares the project queue: each free bot takes one task at a time.
- A bot whose plan waits for approval still holds its task. Without this rule, a fast
  rule-based planner handed a whole queue to one bot.

### 4. Research as a step type, outside the sandbox

`research-agent` steps run in the trusted server, because the sandbox has no network by design.
They only read, and they store what they found as a table with provenance.

- **Literature:** OpenAlex, free, without a key. The table holds refs S1…, with DOI, citations
  and abstract.
- **Knowledge:** the owner's own notes, web pages and text files, split into overlapping passages
  and ranked with BM25. Hits are stored as refs K1…. Web pages are fetched only from public
  addresses. Every redirect hop is resolved and checked against private, loopback and
  link-local ranges.
- **Synthesis:** an AI-written answer in which every claim cites one ref and quotes it verbatim.
  The server copies the cited source text next to the claim, never the model.
  - The `quotes_in_sources` check re-verifies every quote in the sandbox against that stored
    text, with its own normalization. A forged or paraphrased quote fails verification. In the
    tests this check caught such a quote.
  - Without a model, a question without data gets a research plan (literature plus knowledge)
    instead of an error. The plan says plainly that no answer is written.

### 5. Pages with versions

A page is a Markdown document that people, bots and routines write together.

- Every change is a new row in `page_versions`. Restoring a version is itself a new version.
- Saves carry `baseVersion` and are refused with 409 when someone saved in between, so a person
  and a routine cannot silently overwrite each other.
- Appending happens inside the transaction, so it is always safe.
- A finished task becomes a page section through `taskReport`. The section holds the question,
  findings, cited answer, sources, verification and failures. It is built only from stored
  results, never by a model.
- The web renders Markdown into React elements, never into HTML strings.

### 6. Routines

A routine is a request, a schedule and optional parts: data, a bot, a target page and safe
auto-approval. Schedules are daily, weekdays, weekly or interval (at least 15 minutes), in the
server's local time.

The scheduler is a loop over database state, like the project scheduler, every 15 seconds:

- It reschedules a due routine before starting it, so a failing start is not retried every pass.
- Missed runs (server off) are not made up.
- Each run is an ordinary task.
- With auto-approval, the deterministic project policy decides; a model never does. Anything
  the policy refuses waits in the inbox, with the reason.
- A finished run with a target page is appended to that page as a new version, with the task
  linked.

## Consequences

- Meta models and Claude are interchangeable for everything that writes plans, code or answers.
  Live use of Muse Spark depends on the key. The probe is ready; the tests use fakes.
- Research results are as checkable as data results: every claim points at a stored row, and
  every quote is re-checked independently.
- Unattended work is safe by construction. Policy decides only what is fully machine-checked,
  pages keep every version, and the inbox collects everything else.

## Known gaps

- The cited answer has not been seen live, because no Meta key was available. The path is
  covered by tests with a fake synthesizer.
- The knowledge search is lexical (BM25). Semantic search with embeddings, as in Astra, was not
  ported.
- Routine times use the server's time zone; there is no per-user time zone.
- DNS rebinding between the address check and the fetch is not prevented. The fetch is
  read-only, and the content is only searched, never executed.
