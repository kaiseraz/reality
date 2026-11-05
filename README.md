# Reality: the AI workspace that morphs to the task

**Reality is an open-source AI workspace that turns one sentence into a checked result: a team of AI bots, each with its own Linux computer, builds the work, and independent code verifies every number before it is shown.**

**Built during the Meta Global AI Developer Hackathon (November 2026) on Meta's Muse Spark.** Licensed under Apache 2.0.

You bring only the task. Reality brings the rest: it **acquires the capabilities** the task needs at runtime (a statistics library, a SQL engine, a chemistry toolkit, a CAD kernel), **shapes its workspace** around the work (data, lab, 3D CAD, a bot's live computer), and puts a **team of bots** on it, each with its own Linux computer. What makes it different: **every result is checked by code, independently**. No bot, not even the lead, can declare its own work done.

Built for the Meta Global AI Developer Hackathon, on Meta's Muse Spark.

- Submission text: [docs/submission.md](docs/submission.md)
- Plan and architecture: [docs/execution-plan.md](docs/execution-plan.md) · Decisions: [docs/adr/](docs/adr/)
- Evaluation: [docs/eval/report.md](docs/eval/report.md)

## What it does

**One lead, a team it hires.** Everyone starts with one bot, the lead "Reality". Ask it something small and it answers. Give it a real job and it proposes a team on a card: specialists with a mission, a deliverable, a budget, the web domains and setup their computers need, and how code will check the job. You hire the team once. Each specialist then works under a **contract**: it hands in its work, and code decides whether it is met (a command on its computer exits 0, a file exists with the right content, a Reality task passes verification, or you accept it). Late or unproven work fails. Released bots rest with their **record** of met and failed contracts, and the lead hires proven ones again. Bots save scripts that worked as **team skills** for others to reuse.

**Every bot has its own computer.** A persistent Linux machine per bot (the open-source [AIO Sandbox](https://github.com/agent-infra/sandbox), Apache 2.0) with a browser, a terminal and a home folder that survives restarts. Bots run commands, write files and browse; you watch all computers live as tiles on the right and click one to watch it large or take control. The computers sit on a Docker network **without internet**; Reality's gateway lets each one reach only the domains you allowed, only public addresses on ports 80/443, and logs every decision. Blocked domains turn into Allow/Deny cards.

**A real folder on your computer.** The bots in a chat share one project folder inside the sandbox, and Reality copies what they make to a folder of yours (by default under Reality in your documents; choose another in the Files tab). No bot computer ever has your folder mounted. A file you changed is not overwritten, the new version lands beside it, and nothing there is deleted. On a server, set `PROJECT_FOLDERS=off`.

**More than a computer.** When a picture says it better than words, a bot draws it with `show_visual`: a diagram, a plan or a small interactive page opens beside the chat and updates in versions. It runs in a closed frame without access to Reality's data or the network, and is marked as drawn, not checked.

**It acquires what it lacks.** When a task needs something the sandbox does not have, Reality finds a candidate (a PyPI wheel, or an MCP server from PyPI, npm or the MCP registry), inspects it without running it (files, licence, OSV advisories), asks you once, installs it into an isolated layer, runs a requirement test, then uses and reuses it. Shown live: statsmodels (seasonality), DuckDB via MCP (SQL), RDKit (molecules), OpenCascade (CAD).

**Lab and engineering.** Simulations for thin films, ring resonators, tolerance stacks, quantum circuits, molecules and crystals, each re-checked by an independent method. Ask for a jet engine and Reality acquires a CAD kernel and builds a **turbofan of about 2,000 named solids**, exports **STEP** for any CAD program and shows it in 3D: orbit, cut it open, hide groups, search the parts list. An independent check recounts the parts and recomputes volumes from the meshes. No Fusion, no Python on your machine.

**Design you can watch.** The lab also designs **circuit boards** (placement, a two-layer router with vias and 45° tracks, KiCad 8 board files, Gerber and drill files, part models) and **rockets and assemblies by hierarchy**, each re-checked by an independent method (the board by recomputing clearances and connectivity from the file itself). A bot's result then **opens in the real program on its own desktop**: a board in KiCad first as placed with the ratsnest, then routed, then in KiCad's 3D viewer with the part models; a jet engine in FreeCAD, about 1,900 parts built one at a time in under a minute, coloured by group, shell last and see-through. The web view shows the same boards in physically based 3D, with a build you can replay.

**Bots that operate the programs themselves.** A bot looks at its screen (a picture, plus the text on it read with OCR and its exact position) and uses mouse and keyboard, one action at a time: Muse Spark has opened KiCad's Inspect menu, run the Design Rules Checker, read the result, closed it and saved the board with its own keystrokes. Someone who changes a board by hand (the bot, or you after taking over its desktop) asks for `recheck_board`: the file as KiCad saved it goes through the same independent check, including whether any pad moved to another net.

**Data analysis with proof.** Reality plans, you approve, it runs in a locked-down sandbox, and every number is re-computed independently before it is shown as verified. Numbers a bot writes that no tool produced are flagged in the chat. Evaluation: 14 tasks (6 synthetic with known truth, 8 on NOAA Mauna Loa CO₂ and UCI Bike Sharing): **14/14 correct, 0 policy violations**; a fixed-tool baseline gets 7/14.

**Missions overnight.** Give a team a goal, criteria and a budget; it works until done. The verdict comes from code over fully verified evidence, with a report page.

**And:** research with citations checked against the source (OpenAlex, your notes), versioned pages, routines on a schedule, projects with dependencies and budgets, accounts.

**The interface.** A dark, calm workspace: the sidebar folds with Ctrl+B, the chat in the middle, the bots' computers on the right. Each bot is a [blobatar](https://blobatar.dev/) made from its name, so the same name is the same creature everywhere, and its face shows what it is doing (thinking, searching, working, waiting for you, done). The lead wears the interface's own white; a bot that joins a chat splits off it at the top of that chat, the way the two dots in the logo pull apart.

## Meta Muse Spark

Reality talks to Muse Spark through Meta's Anthropic-compatible Model API. It drives the **bots' conversations and tool use**, the **planner** (structured output via a forced tool call) and **research answers**. `PLANNER=auto` picks Meta whenever `META_MODEL_API_KEY` is set, then Claude, then built-in rules. Without any key, Reality still runs fully with deterministic planners.

Check a key in seconds:

```bash
npm run check:model
```

It verifies that the model answers, calls a tool and uses its result, gives structured output, and accepts all of Reality's bot tools, and says what to fix when a step fails. The bot model tolerates small endpoint differences (string tool arguments, odd stop reasons) and retries passing failures.

## Trust model

- **Verification by code.** Results, contracts and missions are judged by independent checks; a bot's own claim counts for nothing.
- **Sandboxes.** Analysis code runs in containers without network, read-only, non-root. Capabilities are mounted read-only after inspection and your approval.
- **Bot computers.** Isolated network, allowlisted egress through a gateway, no host mounts, resource limits, idle shutdown, a full log. Their screens reach your browser only through Reality, so the computer's key never does.
- **You decide.** Installations, plans with custom code, hiring a team and web access are approvals; a deterministic policy auto-approves only fully machine-checked plans that use reviewed analyses.
- **Tool servers.** Every server a bot gets runs in a sandbox with no network, unless you approved domains for it; then the gateway is its only way out and every other host is refused and named. A hosted server is reached over https only, and its card says who receives what a bot sends.
- **Skills from GitHub, when you ask.** Written methods a bot can get, pinned to a commit, read as text, checked for licence and hidden instructions, and usable once you approved what they say. They bring no rights: their scripts run only on the bot's own computer.
- **Secrets.** Reality's own keys stay in the server and never enter sandboxes or computers. A key you type on a tool server's approval card is stored encrypted, goes only to that server, works only for your bots, and is cut out of whatever comes back. No API returns it and bots never see it.

## Quick start

On Windows, double-click `Start.bat`: it checks Node and Docker, starts Docker Desktop if needed, installs and builds what is missing on the first run (the bot computers are a one-time download of about 9 GB), starts Reality and opens http://localhost:5173.

Or by hand:

```bash
npm install
npm run setup   # Postgres + sandbox images (Docker must be running)
npm run dev     # API on :8787, UI on http://localhost:5173
```

As a desktop app instead of a browser tab: `npm run desktop` opens Reality in its own
window, starts the server if it is not running, and asks for a chat's project folder
in the system's own file explorer, with real paths.

Copy `.env.example` to `.env` and set `META_MODEL_API_KEY` (and optionally `META_MODEL`). The bots' computers need their image once (about 9 GB):

```bash
docker pull ghcr.io/agent-infra/sandbox:1.11.0
```

Results open in KiCad 8 and FreeCAD 0.21 on the bot desktops. `Start.bat` builds that image once by itself (about 2.5 GB on top), since `.env.example` sets `COMPUTER_IMAGE=reality-computer:dev`; by hand it is:

```bash
docker build -t reality-computer:dev sandbox/computer
```

`npm run eval:desktop` and `npm run eval:desktop-cad` run a board and a turbofan through a real bot desktop and take pictures of the screen. `npm run eval:desktop-drive` has the configured model operate KiCad itself (real model calls, a little credit).

On first visit, create your account (the first one is the administrator). For a single-user setup without login, set `AUTH=off`.

## Layout

```
apps/server        Trusted core: API, orchestrator (LangGraph), planners, sandbox runner, capability
                   engine, verifier, lab and CAD, chat engine, team and contracts, bot computers
apps/server/eval   Evaluation suite, Meta probe, lab and CAD smoke tests
apps/web           React SPA: chat, workbench, figures (three.js), lab and CAD views, studio
packages/schemas   Zod contracts shared by server and web
packages/workspace Component registry, patch engine, templates
samples/           Datasets with known ground truth; samples/real: real public data
sandbox/python     Base image for untrusted analysis code
docs/              Execution plan, ADRs, evaluation report, submission
```

## Commands

```bash
npm run check          # typecheck + lint + format check + tests (needs Docker + Postgres)
npm run check:model    # is the configured model (Muse Spark or Claude) ready for Reality?
npm run eval           # evaluation suite → docs/eval/report.md (needs network)
npm run dev:server     # http://127.0.0.1:8787/api/health
npm run dev:web        # http://localhost:5173
npm run desktop        # Reality as a desktop app (Electron), with the system's folder explorer
npm run sandbox:build  # sandbox image only
```

Opt-in tests: `RUN_NETWORK_TESTS=1` (real capability acquisition, CAD kernel), `RUN_COMPUTER_TESTS=1` (a real bot computer behind the gateway). Tests use their own databases; your data is untouched.

## API (selection)

| Method           | Path                                                                   | Purpose                                                    |
| ---------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| POST / GET       | `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/approval`              | Tasks, their state and approval gates                      |
| GET              | `/api/tasks/:id/events`                                                | Live events (SSE)                                          |
| GET              | `/api/capabilities`                                                    | Capability registry with lifecycle and tests               |
| GET / POST       | `/api/bots`, `/api/bots/:id/chat`                                      | Bots (the lead is created on first use) and their chat     |
| GET / POST       | `/api/chats`, `/api/chats/:id/messages`, `/api/chats/:id/answers/:mid` | Chats; answers to questions, access, team and review cards |
| GET / POST       | `/api/missions`, `/api/missions/:id/stop`                              | Missions with goal, criteria, budget and verdict           |
| GET / POST       | `/api/bots/:id/computer`, `/start`, `/stop`, `/access`                 | A bot's computer: status, files, log, allowed domains      |
| GET              | `/api/computers`, `/api/bots/:id/computer/thumb`                       | Which computers are on; a screen picture for the overview  |
| GET              | `/api/bots/:id/computer/screen/*`                                      | The live screen (noVNC and its WebSocket, proxied)         |
| GET              | `/api/files/:id`                                                       | Binary results (STEP, STL)                                 |
| GET / POST / PUT | `/api/pages`, `/api/routines`, `/api/projects`, `/api/knowledge`       | Pages, routines, projects, knowledge                       |
| GET / POST       | `/api/auth/me`, `/api/auth/setup`, `/login`, `/logout`, `/users`       | Accounts (when `AUTH=on`)                                  |

## Status and known gaps

- Muse Spark runs live: `npm run check:model` passes 4/4 against the real endpoint, and bot teams have planned, hired specialists and completed code-checked contracts on it. The 14/14 evaluation was measured with the rule-based planner; a Muse Spark run of that set is still to come.
- Results on the bot desktop are tested on a real computer: board in KiCad (placed, routed, 3D), turbofan in FreeCAD (part by part, under a minute for ~1,900 parts), and Muse Spark operating KiCad (DRC from the menu, save, re-check). On a desktop without a graphics card several parts can land in one repaint late in the build. Screen text comes from OCR: small or unusual labels can be misread, then the bot aims by the picture, which is less exact. The re-check after a hand edit does not judge copper zones and arcs: it says so and the board does not pass. Custom footprints get a generic body with pins, not the real shape of the part.
- Bot computers relax seccomp for the browser (as the AIO Sandbox documents) and give the bot `sudo` inside; isolation rests on the network, no host mounts and limits.
- Not yet: gVisor in a real run, password reset and SSO.

## License and credits

Reality's own code is Apache License 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).

It stands on open source and public data. What it uses and under which licenses:

| Component                                                                                                                                                                                                | Used for                                                              | License                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [AIO Sandbox](https://github.com/agent-infra/sandbox) — `ghcr.io/agent-infra/sandbox`                                                                                                                    | the base image for a bot's own computer                               | Apache-2.0                                                                                |
| [Blobatar](https://blobatar.dev/) — `@blobatar/react`                                                                                                                                                    | the bots' animated figures                                            | MIT                                                                                       |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) (`@langchain/langgraph`)                                                                                                                     | the orchestrator's graphs, checkpoints and interrupts                 | MIT                                                                                       |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)                                                                                                          | tool protocol for acquired capability servers                         | MIT                                                                                       |
| Fastify, Zod, React, Vite, three.js, dockview, xterm                                                                                                                                                     | server framework, contracts, UI and its parts                         | MIT (each component's own)                                                                |
| [statsmodels](https://www.statsmodels.org/), [RDKit](https://www.rdkit.org/), [DuckDB](https://duckdb.org/), [OpenCascade](https://github.com/Open-Cascade-SAS/OCCT) via `cadquery-ocp`                  | capabilities a bot can acquire for statistics, molecules, SQL and CAD | BSD-3 (statsmodels, RDKit), MIT (DuckDB), LGPL-2.1 with the Open CASCADE exception (OCCT) |
| [OpenAlex](https://openalex.org/)                                                                                                                                                                        | the public API behind research steps                                  | public API                                                                                |
| [NOAA GML Mauna Loa CO₂ monthly means](https://gml.noaa.gov/ccgg/trends/data.html) (Dr. Xin Lan, NOAA/GML, and Dr. Ralph Keeling, Scripps Institution of Oceanography)                                   | real public data in `samples/real/co2_mm_mlo.csv`                     | public domain (U.S. Government work; NOAA asks for citation)                              |
| [UCI Bike Sharing Dataset](https://doi.org/10.24432/C5W894), Fanaee-T, H. & Gama, J. (2013), _Event labeling combining ensemble detectors and background knowledge_, Progress in Artificial Intelligence | real public data in `samples/real/bike_day.csv`                       | CC BY 4.0                                                                                 |

> This folder is inside OneDrive. If syncing `node_modules` causes slowness or file locks, move the repo outside OneDrive or exclude `node_modules` from sync.
