import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ModelConfig } from './llm/structured.ts';

/** <repo>/.data/artifacts — git-ignored, outside any package directory. */
const DEFAULT_ARTIFACT_DIR = fileURLToPath(new URL('../../../.data/artifacts', import.meta.url));
/** <repo>/.data/capabilities — staged wheels and isolated capability layers. */
const DEFAULT_CAPABILITY_DIR = fileURLToPath(
  new URL('../../../.data/capabilities', import.meta.url),
);

/** <repo>/samples — example datasets offered on the start screen. */
const DEFAULT_SAMPLES_DIR = fileURLToPath(new URL('../../../samples', import.meta.url));

/** Optional setting; an empty value (e.g. `VAR=` in compose) counts as unset. */
const optionalString = () =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional());

const ConfigSchema = z.object({
  SAMPLES_DIR: z.string().min(1).default(DEFAULT_SAMPLES_DIR),
  /**
   * on = accounts and login (the first account created becomes admin); each task belongs
   * to its creator. off = single-user mode without login, for local development and tests.
   */
  AUTH: z.enum(['on', 'off']).default('on'),
  /** Built web app to serve (production); unset in development, where Vite serves it. */
  WEB_DIST: optionalString(),
  /** Mark the session cookie Secure (set when serving over HTTPS). */
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  ARTIFACT_DIR: z.string().min(1).default(DEFAULT_ARTIFACT_DIR),
  CAPABILITY_DIR: z.string().min(1).default(DEFAULT_CAPABILITY_DIR),
  /** Optional: raises GitHub's limit when bots look for skills. Sent to api.github.com only. */
  GITHUB_TOKEN: z.string().min(1).optional(),
  /** Encrypts API keys people give tool servers. Without it, a key file in CAPABILITY_DIR is used. */
  SECRET_KEY: z.string().min(16).optional(),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  SERVER_HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * auto = Claude when an API key is configured, otherwise the built-in rule-based
   * planner. fake = a trivial planner for tests.
   */
  PLANNER: z.enum(['auto', 'anthropic', 'meta', 'rules', 'fake']).default('auto'),
  /** Meta Model API (Muse Spark): bearer token, sent only to META_BASE_URL. */
  META_MODEL_API_KEY: optionalString(),
  META_MODEL: z.string().min(1).default('muse-spark-1.3'),
  META_BASE_URL: optionalString(),
  /**
   * What model use costs, per million tokens in and out, in MODEL_PRICE_UNIT (for example
   * credits or €). Mission budgets are counted in this unit. Without prices, a call costs
   * its tokens in thousands ("k tokens").
   */
  MODEL_PRICE_INPUT: z.coerce.number().nonnegative().optional(),
  MODEL_PRICE_OUTPUT: z.coerce.number().nonnegative().optional(),
  MODEL_PRICE_UNIT: optionalString(),
  /** Literature search endpoint (default: the public OpenAlex API). */
  OPENALEX_URL: optionalString(),
  /** Optional contact address for OpenAlex's polite pool. */
  OPENALEX_MAILTO: optionalString(),
  SANDBOX_IMAGE: z.string().min(1).default('reality-sandbox-python:dev'),
  DOCKER_BIN: optionalString(),
  /** Each bot's own computer (open-source sandbox image, see README); off disables the feature. */
  COMPUTERS: z.enum(['on', 'off']).default('on'),
  COMPUTER_IMAGE: z.string().min(1).default('ghcr.io/agent-infra/sandbox:1.11.0'),
  /** Copies a chat's work to a folder on this machine; off on a server, where people are elsewhere. */
  PROJECT_FOLDERS: z.enum(['on', 'off']).default('on'),
  /** Where new project folders go (default: Reality in the person's documents). */
  PROJECTS_DIR: optionalString(),
  /**
   * Per-run working directories, bind-mounted into sandboxes (default: OS temp dir).
   * When the server itself runs in a container, this and CAPABILITY_DIR must be the
   * same paths inside the container and on the Docker host.
   */
  RUN_DIR: optionalString(),
  /**
   * OCI runtime for sandboxes. "runsc" (gVisor) puts a user-space kernel between untrusted
   * code and the host kernel; recommended for multi-user servers. Unset = Docker's default.
   */
  SANDBOX_RUNTIME: optionalString(),
  PLANNER_MODEL: z.string().default('claude-opus-5-5'),
  /** Test hook: artificial delay per executed step, to make crash/resume observable. */
  FAKE_STEP_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Fails fast on malformed configuration instead of discovering it mid-task. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export type PlannerKind = 'anthropic' | 'meta' | 'rules' | 'fake';

/**
 * auto: Meta's models when a Meta key is configured (the Meta hackathon requires them),
 * else Claude when an Anthropic key is configured, else the built-in rule-based planner.
 */
export function resolvePlannerKind(config: Config): PlannerKind {
  if (config.PLANNER !== 'auto') return config.PLANNER;
  if (config.META_MODEL_API_KEY) return 'meta';
  return config.ANTHROPIC_API_KEY ? 'anthropic' : 'rules';
}

/** The model behind the planner, analyst and project planner, or undefined without one. */
export function modelConfig(config: Config): ModelConfig | undefined {
  const kind = resolvePlannerKind(config);
  if (kind === 'meta' && config.META_MODEL_API_KEY) {
    return {
      provider: 'meta',
      model: config.META_MODEL,
      apiKey: config.META_MODEL_API_KEY,
      ...(config.META_BASE_URL ? { baseURL: config.META_BASE_URL } : {}),
    };
  }
  if (kind === 'anthropic' && config.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: config.PLANNER_MODEL, apiKey: config.ANTHROPIC_API_KEY };
  }
  return undefined;
}
