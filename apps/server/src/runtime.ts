import { join } from 'node:path';
import { ProjectFolders } from './projects/folders.ts';
import { createHash } from 'node:crypto';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { ModelAnalyst } from './analysis/model-analyst.ts';
import { StructuredModel, type ModelConfig } from './llm/structured.ts';
import { pricingOf, UsageLedger } from './llm/usage.ts';
import { AuthService } from './auth/auth-service.ts';
import {
  ModelProjectPlanner,
  RuleProjectPlanner,
  type ProjectPlanner,
} from './projects/project-planner.ts';
import { ProjectService } from './projects/project-service.ts';
import { CriteriaStore } from './verification/criteria-routes.ts';
import { BotService } from './bots/bots.ts';
import { KnowledgeStore } from './research/knowledge.ts';
import { PageStore } from './pages/pages.ts';
import { RoutineService } from './routines/routines.ts';
import { ChatEngine } from './chat/engine.ts';
import { SdkAgentModel, type AgentModel } from './chat/model.ts';
import { ChatStore } from './chat/store.ts';
import { LabAwarePlanner, LabPresets } from './lab/plan.ts';
import { MissionService } from './missions/missions.ts';
import { ModelSynthesizer, type Synthesizer } from './research/research-step.ts';
import { findSample, readSample } from './samples.ts';
import { BotComputers } from './computer/computers.ts';
import { TeamService } from './team/team.ts';
import { resolveDockerBin } from './sandbox/docker-runner.ts';
import {
  createExecutor,
  primaryDataset,
  type Analyst,
  type CapabilityResolver,
} from './analysis/executor.ts';
import { RunStore } from './analysis/run-store.ts';
import { SandboxService } from './analysis/sandbox-service.ts';
import { ArtifactStore } from './artifacts/artifact-store.ts';
import { FileStore } from './artifacts/file-store.ts';
import { modelConfig, resolvePlannerKind, type Config } from './config.ts';
import { migrate } from './db/migrate.ts';
import { EventLog } from './events/event-log.ts';
import { buildGraph, type CapabilityAgent, type Verifier } from './orchestrator/graph.ts';
import { ModelPlanner } from './planner/model-planner.ts';
import { FakePlanner } from './planner/fake-planner.ts';
import type { Planner } from './planner/planner.ts';
import { RuleBasedPlanner } from './planner/rule-planner.ts';
import { validatePlan } from './planner/semantics.ts';
import { DockerRunner, SandboxUnavailableError } from './sandbox/docker-runner.ts';
import { TaskRepo } from './tasks/task-repo.ts';
import { TaskService } from './tasks/task-service.ts';
import { CapabilityEngine, type ToolAccess } from './capabilities/engine.ts';
import { SecretStore } from './capabilities/secrets.ts';
import { SkillService } from './capabilities/skills.ts';
import { ModelProposer } from './capabilities/search.ts';
import { CapabilityStore } from './capabilities/store.ts';
import { createVerifier } from './verification/verifier.ts';
import { WorkspaceService } from './workspaces/workspace-service.ts';

export interface Runtime {
  planner: Planner;
  events: EventLog;
  tasks: TaskService;
  workspaces: WorkspaceService;
  artifacts: ArtifactStore;
  runs: RunStore;
  sandbox: SandboxService;
  capabilities: CapabilityStore;
  /** The engine that finds, inspects, installs and mounts capabilities. */
  capabilityEngine: CapabilityAgent & CapabilityResolver;
  auth: AuthService;
  /** Binary step results (STEP, STL). */
  files: FileStore;
  /** Persistent team members (bots). */
  bots: BotService;
  /** Success criteria a person set for tasks. */
  criteria: CriteriaStore;
  /** A person's own knowledge sources, searched by research steps. */
  knowledge: KnowledgeStore;
  /** Versioned pages people and bots write together. */
  pages: PageStore;
  /** Scheduled tasks (call routines.start() to run the scheduler in the background). */
  routines: RoutineService;
  /** Chats with bots (call chats.engine.start() to report task results in the background). */
  chats: { store: ChatStore; engine: ChatEngine };
  folders: ProjectFolders | null;
  /** Research missions worked on by a team in a chat, judged by code. */
  missions: MissionService;
  /** Projects and their scheduler (call projects.start() to run it in the background). */
  projects: ProjectService;
  /** The lead's team: hiring, contracts judged by code, resting bots, skills. */
  team: TeamService;
  /** Each bot's own computer; null when switched off or Docker is missing. */
  computers: BotComputers | null;
  /** null when Docker/the image is available; otherwise why runs will fail. */
  sandboxProblem: string | null;
  close(): Promise<void>;
}

export function createPlanner(config: Config, metered: Metered = (m) => m): Planner {
  const kind = resolvePlannerKind(config);
  if (kind === 'fake') return new FakePlanner();
  if (kind === 'rules') return new RuleBasedPlanner();
  const model = metered(modelConfig(config));
  if (!model) {
    throw new Error(
      kind === 'meta'
        ? 'PLANNER=meta requires META_MODEL_API_KEY.'
        : 'PLANNER=anthropic requires ANTHROPIC_API_KEY.',
    );
  }
  return new ModelPlanner(new StructuredModel(model));
}

export interface RuntimeOverrides {
  planner?: Planner;
  log?: { error: (obj: unknown, msg?: string) => void };
  /** Wire the M5 capability engine and M4 verifier (factories receive the runtime parts). */
  capabilities?: (parts: Parts) => CapabilityAgent & CapabilityResolver;
  verifier?: (parts: Parts) => Verifier;
  /** Decomposes project goals. Default: the configured model, else one task per line. */
  projectPlanner?: ProjectPlanner;
  /** Writes code for steps without a recipe. Default: the configured model (Meta or Claude). */
  analyst?: Analyst | null;
  /** Writes cited answers in research steps. Default: the configured model. */
  synthesizer?: Synthesizer | null;
  /** Lets tests serve knowledge pages from localhost. */
  allowPrivateUrls?: boolean;
  /** The model bots converse with. Default: the configured model; null: built-in rules. */
  chatModel?: AgentModel | null;
}

/** A model configuration whose calls are counted (for mission budgets). */
type Metered = (m: ModelConfig | undefined) => ModelConfig | undefined;

function createAnalyst(config: Config, metered: Metered): Analyst | undefined {
  const model = metered(modelConfig(config));
  return model ? new ModelAnalyst(new StructuredModel(model)) : undefined;
}

export interface Parts {
  pool: pg.Pool;
  config: Config;
  events: EventLog;
  artifacts: ArtifactStore;
  runs: RunStore;
  sandbox: SandboxService;
  capabilities: CapabilityStore;
  files: FileStore;
}

/** Wires the trusted core: database, checkpointer, orchestrator, sandbox, workspaces. */
export async function createRuntime(
  config: Config,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
  await migrate(pool);
  const usage = new UsageLedger(pool, pricingOf(config), overrides.log);
  const metered: Metered = (m) => m && { ...m, onUsage: (name, u) => void usage.record(name, u) };

  const checkpointer = new PostgresSaver(pool, undefined, { schema: 'langgraph' });
  await pool.query('CREATE SCHEMA IF NOT EXISTS langgraph');
  await checkpointer.setup();

  const labPresets = new LabPresets(pool);
  // Lab simulations started by bots get their fixed plan; everything else goes to the planner.
  const planner = new LabAwarePlanner(
    overrides.planner ?? createPlanner(config, metered),
    labPresets,
  );
  const events = new EventLog(pool);
  const artifacts = new ArtifactStore(pool, config.ARTIFACT_DIR);
  const files = new FileStore(pool, config.ARTIFACT_DIR);
  const runs = new RunStore(pool);
  const runner = new DockerRunner(config.SANDBOX_IMAGE, {
    ...(config.DOCKER_BIN ? { dockerBin: config.DOCKER_BIN } : {}),
    ...(config.RUN_DIR ? { workRoot: config.RUN_DIR } : {}),
    ...(config.SANDBOX_RUNTIME ? { runtime: config.SANDBOX_RUNTIME } : {}),
  });
  let sandboxProblem: string | null = null;
  try {
    await runner.check();
  } catch (err) {
    if (!(err instanceof SandboxUnavailableError)) throw err;
    sandboxProblem = err.message;
  }
  const sandbox = new SandboxService(runner, runs, events);
  const capabilityStore = new CapabilityStore(pool);
  const parts: Parts = {
    pool,
    config,
    events,
    artifacts,
    runs,
    sandbox,
    capabilities: capabilityStore,
    files,
  };
  // Computers come up after the engine; tool servers ask for the gateway when they start.
  let toolAccess: ToolAccess | null = null;
  const capabilityEngine =
    overrides.capabilities?.(parts) ??
    new CapabilityEngine({
      store: capabilityStore,
      sandbox,
      events,
      runs,
      dir: config.CAPABILITY_DIR,
      secrets: new SecretStore(pool, join(config.CAPABILITY_DIR, '.secret-key'), config.SECRET_KEY),
      toolAccess: () => toolAccess,
      // What the reviewed catalog does not know is searched for; a model, if there is one,
      // proposes names that code then verifies. Without a model the search still runs.
      search: (() => {
        const searchModel = metered(modelConfig(config));
        if (!searchModel) return {};
        const proposer = new ModelProposer(new StructuredModel(searchModel));
        return {
          propose: (need: string, want?: 'library' | 'mcp-server') => proposer.propose(need, want),
          ruleOut: (need: string, servers: { package: string; says: string }[]) =>
            proposer.ruleOut(need, servers),
        };
      })(),
    });
  const verifier = overrides.verifier?.(parts) ?? createVerifier(parts);

  // Late-bound: the workspace service needs the task service, which needs the graph.
  const late: { workspaces?: WorkspaceService } = {};
  const analyst =
    overrides.analyst === null ? undefined : (overrides.analyst ?? createAnalyst(config, metered));
  const model = metered(modelConfig(config));
  const synthesizer =
    overrides.synthesizer === null
      ? undefined
      : (overrides.synthesizer ??
        (model ? new ModelSynthesizer(new StructuredModel(model)) : undefined));
  const knowledge = new KnowledgeStore(pool, {
    ...(overrides.allowPrivateUrls ? { allowPrivateUrls: true } : {}),
  });
  const executeStep = createExecutor({
    sandbox,
    artifacts,
    runs,
    files,
    capabilities: capabilityEngine,
    research: {
      knowledge,
      ...(synthesizer ? { synthesizer } : {}),
      ...(config.OPENALEX_URL ? { openAlexUrl: config.OPENALEX_URL } : {}),
      ...(config.OPENALEX_MAILTO ? { mailto: config.OPENALEX_MAILTO } : {}),
      ownerOf: async (taskId: string) =>
        (
          await pool.query<{ owner_id: string | null }>(
            'SELECT owner_id FROM tasks WHERE id = $1',
            [taskId],
          )
        ).rows[0]?.owner_id ?? null,
    },
    ...(analyst
      ? {
          analyst,
          goalOf: async (taskId: string) =>
            (
              await pool.query<{ request: string }>('SELECT request FROM tasks WHERE id = $1', [
                taskId,
              ])
            ).rows[0]?.request ?? '',
        }
      : {}),
    onArtifact: async (taskId, meta) => {
      await events.append(taskId, 'artifact.added', 'analysis-agent', {
        artifactId: meta.ref.id,
        filename: meta.filename,
        rows: meta.rowCount,
        provenance: meta.provenance,
      });
      await late.workspaces?.onDatasetAdded(taskId, meta);
    },
  });

  const graph = buildGraph({
    planner,
    events,
    checkpointer,
    executeStep,
    context: async (taskId) => {
      const dataset = await primaryDataset(artifacts, taskId);
      return {
        datasets: dataset
          ? [
              {
                filename: dataset.filename,
                rowCount: dataset.rowCount,
                columns: dataset.columns,
                ...(dataset.provenance.kind === 'prepared'
                  ? { notes: dataset.provenance.notes }
                  : {}),
              },
            ]
          : [],
        availableCapabilities: (await capabilityEngine.enabledIds?.()) ?? [],
      };
    },
    validateSpec: validatePlan,
    capabilities: {
      prepare: async (need, taskId) => {
        await late.workspaces?.onCapabilityActivity(taskId);
        return capabilityEngine.prepare(need, taskId);
      },
      install: (proposal, taskId) => capabilityEngine.install(proposal, taskId),
      reject: (proposal, taskId, note) => capabilityEngine.reject(proposal, taskId, note),
    },
    verifier,
    ...(config.FAKE_STEP_DELAY_MS ? { stepDelayMs: config.FAKE_STEP_DELAY_MS } : {}),
  });
  const tasks = new TaskService(graph, new TaskRepo(pool), events, overrides.log);
  const ws = new WorkspaceService(pool, events, artifacts, tasks);
  late.workspaces = ws;
  tasks.onCreate((taskId) => ws.createForTask(taskId));
  const projectPlanner =
    overrides.projectPlanner ??
    (() => {
      const model = metered(modelConfig(config));
      return model ? new ModelProjectPlanner(new StructuredModel(model)) : new RuleProjectPlanner();
    })();
  const sampleFile = async (id: string) => {
    const sample = findSample(id);
    if (!sample) return undefined;
    return {
      filename: sample.file.split('/').pop() ?? sample.file,
      text: await readSample(config.SAMPLES_DIR, sample),
    };
  };
  const projects = new ProjectService({
    pool,
    tasks,
    artifacts,
    events,
    workspaces: ws,
    planner: projectPlanner,
    dataDir: config.ARTIFACT_DIR,
    readSample: sampleFile,
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const pages = new PageStore(pool);
  const chatStore = new ChatStore(pool);
  const bots = new BotService(pool);
  const chatModel =
    overrides.chatModel === null
      ? null
      : (overrides.chatModel ?? (model ? new SdkAgentModel(model) : null));
  const missions = new MissionService({ pool, store: chatStore, tasks, pages, bots, usage });
  // The bots' turns are counted by the chat engine (it knows the chat and bot of each).
  const computers =
    config.COMPUTERS === 'on' && !sandboxProblem
      ? new BotComputers(pool, {
          namespace: createHash('sha256')
            .update(config.DATABASE_URL ?? 'default')
            .digest('hex')
            .slice(0, 8),
          dockerBin: resolveDockerBin(config.DOCKER_BIN),
          image: config.COMPUTER_IMAGE,
          gatewayImage: config.SANDBOX_IMAGE,
        })
      : null;
  toolAccess = computers;
  // Adopt computers that survived a server restart, in the background: the gateway
  // comes up and re-registers them instead of the next bot turn wiping their session.
  // One retry: at boot the Docker daemon can still be busy, and a failed first pass
  // must not silently leave every computer "off" until someone starts one by hand.
  if (computers) {
    void computers.warmUp().catch(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(
            () =>
              void computers
                .warmUp()
                .catch(() => undefined)
                .then(resolve),
            5_000,
          ),
        ),
    );
  }
  const team = new TeamService({
    pool,
    bots,
    store: chatStore,
    tasks,
    computers,
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  const folders =
    computers && config.PROJECT_FOLDERS === 'on'
      ? new ProjectFolders({
          pool,
          store: chatStore,
          computers,
          files,
          dataDir: config.ARTIFACT_DIR,
          ...(config.PROJECTS_DIR ? { root: config.PROJECTS_DIR } : {}),
          ...(overrides.log ? { log: overrides.log } : {}),
        })
      : null;
  const routines = new RoutineService({
    pool,
    tasks,
    artifacts,
    events,
    workspaces: ws,
    pages,
    readSample: sampleFile,
    ...(overrides.log ? { log: overrides.log } : {}),
  });

  const chatEngine = new ChatEngine({
    team,
    routines,
    computers,
    folders,
    missions,
    store: chatStore,
    files,
    tasks,
    artifacts,
    events,
    workspaces: ws,
    pages,
    knowledge,
    sandbox: sandboxProblem ? null : sandbox,
    presets: labPresets,
    libraries: capabilityEngine,
    skills: new SkillService(pool, {
      ...(config.GITHUB_TOKEN ? { githubToken: config.GITHUB_TOKEN } : {}),
      ...(() => {
        const skillModel = metered(modelConfig(config));
        if (!skillModel) return {};
        const proposer = new ModelProposer(new StructuredModel(skillModel));
        return {
          ruleOut: (need: string, skills: { package: string; says: string }[]) =>
            proposer.ruleOut(need, skills),
          best: (need: string, skills: { package: string; says: string }[]) =>
            proposer.best(need, skills),
        };
      })(),
    }),
    readSample: sampleFile,
    ...(config.OPENALEX_URL ? { openAlexUrl: config.OPENALEX_URL } : {}),
    bots,
    model: chatModel,
    usage,
    ...(overrides.log ? { log: overrides.log } : {}),
  });
  return {
    planner,
    events,
    tasks,
    workspaces: ws,
    artifacts,
    runs,
    sandbox,
    capabilities: capabilityStore,
    capabilityEngine,
    auth: new AuthService(pool),
    criteria: new CriteriaStore(pool),
    knowledge,
    files,
    bots,
    chats: { store: chatStore, engine: chatEngine },
    folders,
    missions,
    projects,
    pages,
    routines,
    sandboxProblem,
    computers,
    team,
    async close() {
      projects.stop();
      routines.stop();
      chatEngine.stopTimer();
      await chatEngine.shutdown();
      await tasks.settleAll();
      await computers?.close();
      await pool.end();
    },
  };
}
