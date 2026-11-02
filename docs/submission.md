# Reality: the AI workspace that morphs to the task

**Meta Global AI Developer Hackathon · Indie track · built on Meta Muse Spark**

## In one sentence

You bring only the task; Reality acquires the tools it needs at runtime, shapes its workspace around the work, hires a team of bots that each get their own computer, and checks every result with code, so no bot can claim success it did not earn.

## The problem

AI agents can now browse, write code and run tools. Two things still keep them from real work:

1. **They are stuck with what they shipped with.** A data question needs a statistics library, a jet-engine design needs a CAD kernel, a chemistry question needs a cheminformatics toolkit. Today a person installs and wires these up, or the agent quietly works around what it lacks.
2. **You cannot trust what they report.** An agent that says "done, thrust is 250 kN" may have made the number up. Most tools show the claim, not the proof.

## What Reality does

**It morphs to the task.**

- _Capabilities:_ when a task needs something Reality does not have, it finds a candidate (a PyPI wheel, or an MCP server from PyPI, npm or the MCP registry), inspects it without running it (files, licence, known advisories), asks you once, installs it into an isolated layer, runs a requirement test, and then uses and reuses it. Shown end to end with statsmodels, DuckDB over MCP, RDKit and OpenCascade.
- _Workspace:_ the interface becomes what the task needs: data tables and charts, a lab view, a 3D CAD viewer with a cutaway and parts list, the live screens of the bots' computers.

**A lead that hires a team.** You talk to one bot, the lead. For a real job it proposes specialists on a card: mission, deliverable, budget, the web access and setup their computers need, and how the job will be checked. You hire the team once. Each specialist works under a contract, and code decides when the contract is met. Specialists rest between jobs with a record of met and failed contracts, so the lead hires proven ones again, and they save scripts that worked as team skills.

**Every bot has its own computer.** A persistent Linux machine with a browser, terminal and files. You watch all of them live as tiles beside the chat and click one to watch it large or take control. The computers have no internet except through Reality's gateway, which allows only the domains you approved.

**A real folder on your computer.** A chat's bots share one project folder in the sandbox, and Reality copies what they make to a folder of yours, created by itself or chosen. No bot computer ever has your folder mounted, only the server copies. A file you changed is not overwritten, the new version lands beside it, and nothing there is deleted.

**More than a computer.** When a picture says it better than words, a bot draws it: a diagram, a plan, a small interactive page opens beside the chat, like a shared whiteboard, and updates in versions. It runs in a closed frame that cannot read Reality's data or reach the network, and it is marked as drawn, not checked.

**Verification is the core, not an add-on.** Every analysis result is recomputed by an independent method before it is called verified. Simulation results are checked by a different method from the one that produced them. A CAD assembly's parts are recounted and its volumes recomputed from the meshes. Contracts and missions are judged by code over verified evidence. Numbers a bot writes that no tool produced are flagged in the chat.

## How we use Meta's models

Muse Spark is the brain, through Meta's Anthropic-compatible Model API:

- **Bots:** every bot turn is a Muse Spark call with Reality's tools: start a verified analysis or simulation, search literature and notes, run commands and browse on its own computer, ask for web access, write pages, manage the board. The lead additionally proposes teams, checks contracts and releases specialists; specialists hand in work.
- **Planner:** turns a request into a typed plan (steps, agents, checks) through structured output via a forced tool call; the plan is validated before anything runs.
- **Research:** writes cited answers whose quotes are then verified against the stored sources.

Reality keeps the model honest by design: the model proposes and acts, but approvals, policy and verdicts sit outside it. One command, `npm run check:model`, confirms in seconds that the configured Muse Spark model answers, calls tools and uses results, gives structured output, and accepts all of Reality's tool schemas. The client tolerates small endpoint differences and retries passing failures.

## Technical depth

- **TypeScript monorepo:** Fastify and Zod on the server, React and three.js on the web, LangGraph with Postgres checkpoints for durable, resumable runs, Postgres for everything else.
- **Isolation:**
  - Analysis code runs in Docker sandboxes with no network, read-only, non-root.
  - Capabilities are mounted read-only.
  - Bot computers sit on an internal network; a small gateway relays Reality's connection to them and forwards their traffic only to allowed public hosts on ports 80/443. It refuses private addresses, so an allowed name cannot be pointed at the host.
- **Live screens** of bot computers are proxied through Reality (HTTP and WebSocket), so access rules apply and the computer's key never reaches the browser.
- **CAD:**
  - The OpenCascade kernel is acquired on demand.
  - It builds a parametric two-spool turbofan of about 2,000 named solids and exports STEP and per-group meshes.
  - An independent check recounts parts, checks every solid and recomputes volumes from the meshes.
- **Design on the bot's desktop:**
  - The lab designs circuit boards (annealing placement, two-layer grid router, KiCad 8 files, Gerber and drill, part models) and rockets and assemblies by hierarchy; independent checks recompute clearances, connectivity and volumes.
  - A board is built live in the real KiCad on the bot's own desktop, with KiCad's 3D viewer beside it: the parts lie next to the board with their ratsnest, move onto it, and tracks appear net by net while KiCad's own counters run down. The bot's computer runs the same placer and router as the lab, and the board it arrives at is byte for byte the one that passed the independent check; if it ever differs, the checked board is what opens.
  - A turbofan builds in FreeCAD, about 1,900 parts one at a time in colour in under a minute.
  - The bot also operates the programs itself. Muse Spark sees its screen (a picture, plus OCR text with exact positions) and uses mouse and keyboard: it ran KiCad's Design Rules Checker from the menu, read 0 violations, and saved the board.
  - A hand-changed board counts only after `recheck_board`: the file as KiCad saved it goes through the same independent check, including whether any pad moved to another net.
  - Real-desktop tests (`npm run eval:desktop`, `eval:desktop-cad`, `eval:desktop-drive`) take pictures of the screen.
- **Tools and libraries on demand:**
  - When the reviewed catalog does not know what a bot needs, Reality searches: a model proposes names, keyword listings, the official MCP registry and conventional names ("mcp-server-time") add more, npm too, and code verifies every candidate (exists, 90 days old, widely used, installable, permissive licence).
  - The best one is inspected offline and installed into an isolated layer after one approval, as a library to import or as an MCP server whose tools the bot calls; the server lists its own tools. It runs in a sandbox without network, unless the person approved domains on the card; then the gateway is its only way out. Keys are typed on the card, stored encrypted, and bots never see them. Hosted servers work too, and the card says who gets the data.
  - Shown live with Muse Spark: a bot got `mcp-server-fetch` limited to example.com, read that page, was refused iana.org and said so, asked for it on a card, and read it after the click. A bot got the official Brave server: dependencies with known vulnerabilities were updated and the card said so; the real Brave API then refused a made-up test key, and the bot reported that. Candidates with an unfixable vulnerability were rejected and the next one taken.
  - Skills too, on request: a bot can get a written method from GitHub (pinned to a commit, read as text, licence and hidden instructions checked, approved on a card). They bring no rights.
  - People can attach files to a chat; a bot passes them to a tool, and what the tool produces comes back as a download.
  - For the jobs that come up all the time there is a reviewed list of servers (GitHub, arXiv, Wikidata, OSV, library documentation, documents, web search), each called against its real service before it is enabled.
  - Measured with 31 ordinary requests and no word about tools (`npm run eval:adapt`): where a server fits (7 requests) the bot used one in 6, up from 1 before the list; 23 of 24 checked answers held; 5 of 6 files came with a link. Skills did not make results better when measured blind (`npm run eval:skills`: landing page 5 wins to 11, MCP server 1 to 11, browser test 8 to 8), so bots fetch one only when a person asks.
- **Figures:**
  - Every bot is a blobatar (blobatar.dev, MIT) made from its name; its expression follows what it is doing.
  - A bot that joins a chat splits off the lead at the top of that chat: plain circles through a blur and a hard alpha cut, so the neck between them is real.
- **Evaluation and tests:**
  - 14 tasks, 6 synthetic with known ground truth and 8 on real public data (NOAA Mauna Loa CO₂, UCI Bike Sharing).
  - Reality gets 14/14 correct with 0 policy violations; the same system with a fixed tool set gets 7/14.
  - 389 automated tests, 27 of them opt-in end-to-end tests against real Docker containers and real package downloads.

## Impact

Reality is for people who need answers they can stand behind, without becoming tool experts: an engineer who needs a first CAD model, a researcher comparing a design with the literature, an analyst who must defend every number. The pattern of acquiring capabilities and verifying independently carries over to any field where a wrong confident answer is costly.

## Demo (3 minutes)

1. **Ask the lead:** "Design a small turbofan and compare it with real engines." The lead proposes three specialists with contracts. Hire them.
2. **Watch the team work:** three computer tiles light up. The researcher browses approved sources. The engineer's computer is prepared, and Reality acquires a CAD kernel after one approval.
3. **See the result:**
   - The engine appears in 3D: cut it open, search the parts list, download the STEP file.
   - The contract cards turn green only when code confirms them. A specialist that hands in too early is refused with the reason.
   - Open the engineer's computer: the turbofan builds in FreeCAD part by part, coloured, shell last. Ask for a small board: it opens in KiCad as placed, then routed, then in the 3D viewer. Then watch the bot run KiCad's own Design Rules Checker from the menu.
4. **Close with the trust panel:** what was checked, how, and by which independent method.

## Challenges

- Making "the AI must not certify itself" a hard property of the system: verdicts live in code paths the model cannot reach.
- Giving each bot a real computer without giving it the internet or the host: an internal network with an allowlisting gateway, tested against rebinding and host-name tricks.
- A face that reads as a character and stays calm: two eyes on a body that comes from the bot's name.

## What's next

- Muse Spark runs live (preflight 4/4 against the real endpoint). Next: measure it on the 14-task evaluation set and keep tuning prompts and tools to it.
- More engines and capability sources.
- Sharing teams and their skills between people.
- Running the bot computers under gVisor.

## Built with

Meta Muse Spark (Meta Model API) · TypeScript · Node.js · Fastify · Zod · React · Vite · three.js · LangGraph · PostgreSQL · Docker · AIO Sandbox (Apache 2.0) · OpenCascade (cadquery-ocp) · RDKit · statsmodels · DuckDB (MCP) · OpenAlex
