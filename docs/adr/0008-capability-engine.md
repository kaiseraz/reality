# ADR 0008 — Adaptive capability engine (M5)

Status: accepted

## Lifecycle

`discovered → inspected → (human approval) → tested → enabled → trusted`, or `rejected`. Transitions are enforced in code (`canTransition`) and every change is kept in the record's history. Agents cannot write the registry.

| Stage         | What happens                                                                                                                                                                                                                                                                                        | Where                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Discover      | An allowlisted catalog maps needs to candidate packages; live PyPI metadata is fetched; candidates are compared deterministically (hard requirements: compatible wheel, no copyleft license; score: fit, maintenance recency, dependency count).                                                    | Core                             |
| Download      | `pip download --only-binary=:all:` of the pinned version, the only step with network access. No package code runs.                                                                                                                                                                                  | Sandbox with egress              |
| Inspect       | Wheels are opened as data (zip): name, version, license, `.pth` start-up hooks, entry points, native libraries, hashes, and whether the package is already in the base image. OSV is queried for known vulnerabilities. Blocking findings (`.pth`, non-wheels, known vulnerabilities, size) reject. | Sandbox, offline                 |
| Approve       | The orchestrator interrupts with the full report (candidates compared, new packages, licenses, vulnerabilities, findings, permissions, requirement test). A denial applies to that task only.                                                                                                       | Human                            |
| Install       | Hashes are re-verified (no swap after approval). `pip install --no-index --no-deps --no-compile --target` into an isolated layer.                                                                                                                                                                   | Sandbox, offline                 |
| Test          | A requirement test proves what recipes rely on, e.g. STL recovers a known 52-week seasonality from synthetic data, loaded from the layer.                                                                                                                                                           | Sandbox, layer mounted read-only |
| Enable / use  | The layer is mounted read-only, only into runs whose recipe requires it.                                                                                                                                                                                                                            | Sandbox                          |
| Trust / reuse | After 3 successful uses the capability becomes trusted. Later tasks reuse it without a new download or approval.                                                                                                                                                                                    | Core                             |

## Why

- Discovering a package must never mean trusting it. Each stage produces evidence, and the human decides with that evidence in front of them.
- Wheels only: source distributions run build scripts at install time, before any test could.
- An allowlisted catalog instead of open search: the engine's mechanics are general; widening the sources is a policy decision, not a code change.

## Known gaps

- npm packages are not a capability source yet. MCP servers are (ADR 0009).
- Native code in wheels (e.g. compiled extensions) runs inside the sandbox; its safety relies on container isolation.
- `trusted` is based on successful use, not on an independent review.
