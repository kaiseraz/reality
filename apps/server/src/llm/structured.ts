import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

/**
 * One way to ask a model for structured output, whichever provider runs it.
 *
 * - anthropic: Claude through the Anthropic API, with native structured outputs, adaptive
 *   effort and server-side fallback.
 * - meta: Meta's models (Muse Spark) through the Meta Model API, which speaks the Anthropic
 *   Messages format. Only the widely supported subset is used: a forced tool call whose input
 *   is the structured result. No thinking, no betas, no server tools. The Meta key goes only
 *   to Meta, as a bearer token; the Anthropic key is never sent there. The live endpoint
 *   supports only `tool_choice: "auto"` (named and "any" get a 400), so the forcing
 *   degrades gracefully along that chain and remembers which form worked. It also thinks
 *   before answering (several hundred thinking tokens even on trivial prompts), so the
 *   Meta path enforces a token floor and tells the model to answer through the tool.
 *
 * Either way, the result is validated by the caller's schema; nothing is trusted unparsed.
 */
export type Provider = 'anthropic' | 'meta';

export interface ModelConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  /** Meta only: the API base URL (default https://api.meta.ai). */
  baseURL?: string;
  /** Told about every call's tokens, to count what model use costs. */
  onUsage?: (model: string, usage: { inputTokens: number; outputTokens: number }) => void;
}

export const META_BASE_URL = 'https://api.meta.ai';

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface StructuredResult {
  /** The model's structured output, not yet validated by the caller. */
  value: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export function createClient(cfg: ModelConfig): Anthropic {
  return cfg.provider === 'meta'
    ? // apiKey: null keeps an ANTHROPIC_API_KEY from the environment out of Meta requests.
      new Anthropic({ baseURL: cfg.baseURL ?? META_BASE_URL, apiKey: null, authToken: cfg.apiKey })
    : new Anthropic({ apiKey: cfg.apiKey });
}

/** JSON schema for a tool input: an object schema without the $schema marker. */
export function toolSchema(schema: z.ZodType): Record<string, unknown> {
  const json = { ...(z.toJSONSchema(schema) as Record<string, unknown>) };
  delete json.$schema;
  return json;
}

/** The live Meta endpoint thinks before it answers; smaller budgets truncate the tool call. */
const META_MIN_MAX_TOKENS = 2048;

export class StructuredModel {
  readonly client: Anthropic;
  /** The tool_choice form this endpoint last accepted; tried first on the next call. */
  private workingChoice: Anthropic.ToolChoice | undefined;

  constructor(
    readonly config: ModelConfig,
    client?: Anthropic,
  ) {
    this.client = client ?? createClient(config);
  }

  get name(): string {
    return this.config.model;
  }

  get provider(): Provider {
    return this.config.provider;
  }

  async call(req: {
    system: string;
    user: string;
    schema: z.ZodType;
    /** Tool name used for providers without native structured outputs. */
    toolName: string;
    toolDescription: string;
    maxTokens?: number;
  }): Promise<StructuredResult> {
    try {
      const res =
        this.config.provider === 'meta' ? await this.viaTool(req) : await this.native(req);
      this.config.onUsage?.(res.model, res.usage);
      return res;
    } catch (err) {
      throw asModelError(err, this.config.provider);
    }
  }

  private async native(req: Parameters<StructuredModel['call']>[0]): Promise<StructuredResult> {
    const response = await this.client.beta.messages.parse({
      model: this.config.model,
      max_tokens: req.maxTokens ?? 16000,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { effort: 'high', format: betaZodOutputFormat(req.schema) },
      // Server-side fallback: on a policy refusal the API retries on a suitable model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    stopCheck(response.stop_reason);
    return {
      value: response.parsed_output,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private async viaTool(req: Parameters<StructuredModel['call']>[0]): Promise<StructuredResult> {
    // Strongest forcing first, then the form that worked last time. An endpoint that
    // refuses one form (the live Meta API supports only "auto") is retried with the next
    // weaker one; with a single tool offered, the instruction below pins the shape.
    const all: Anthropic.ToolChoice[] = [
      { type: 'tool', name: req.toolName },
      { type: 'any' },
      { type: 'auto' },
    ];
    const choices = this.workingChoice
      ? [this.workingChoice, ...all.filter((c) => c.type !== this.workingChoice?.type)]
      : all;
    let response: Anthropic.Message | undefined;
    for (const [i, tool_choice] of choices.entries()) {
      try {
        response = await this.client.messages.create({
          model: this.config.model,
          max_tokens: Math.max(req.maxTokens ?? 16000, META_MIN_MAX_TOKENS),
          // "auto" cannot force the tool, so the contract is stated in words.
          system: `${req.system}\n\nReturn the result by calling the "${req.toolName}" tool. Do not answer in text.`,
          messages: [{ role: 'user', content: req.user }],
          tools: [
            {
              name: req.toolName,
              description: req.toolDescription,
              input_schema: toolSchema(req.schema) as Anthropic.Tool.InputSchema,
            },
          ],
          tool_choice,
        });
        this.workingChoice = tool_choice;
        break;
      } catch (err) {
        if (i === choices.length - 1 || !isUnsupportedToolChoice(err)) throw err;
      }
    }
    if (!response) throw new ModelCallError('The model returned no structured result.', true);
    stopCheck(response.stop_reason);
    const call = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === req.toolName,
    );
    let value: unknown = call?.input;
    if (value === undefined) {
      // Some endpoints answer in text despite the forced tool: accept a JSON object there.
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const json = /\{[\s\S]*\}/.exec(text)?.[0];
      try {
        value = json ? (JSON.parse(json) as unknown) : undefined;
      } catch {
        value = undefined;
      }
    }
    if (value === undefined) {
      throw new ModelCallError('The model returned no structured result.', true);
    }
    return {
      value,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

/** A 400 that names `tool_choice`: this endpoint does not support that forcing form. */
function isUnsupportedToolChoice(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { status, message } = err as { status?: unknown; message?: unknown };
  return status === 400 && typeof message === 'string' && /tool_choice/i.test(message);
}

function stopCheck(reason: string | null) {
  if (reason === 'refusal') throw new ModelCallError('The model declined this request.', false);
  if (reason === 'max_tokens') throw new ModelCallError('The model output was truncated.', true);
}

export function asModelError(err: unknown, provider: Provider): Error {
  if (err instanceof ModelCallError) return err;
  const who = provider === 'meta' ? 'Meta Model API' : 'Claude API';
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
    return new ModelCallError(`${who} temporarily unavailable: ${err.message}`, true);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ModelCallError(`${who} unreachable: ${err.message}`, true);
  }
  if (err instanceof Anthropic.APIError) {
    return new ModelCallError(`${who} error ${err.status}: ${err.message}`, false);
  }
  return err instanceof Error ? err : new Error(String(err));
}
