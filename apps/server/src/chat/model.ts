import type Anthropic from '@anthropic-ai/sdk';
import { asModelError, createClient, ModelCallError, type ModelConfig } from '../llm/structured.ts';

/**
 * One step of a bot's turn: the model sees the conversation and the tools and answers with
 * text and/or tool calls. Meta Muse Spark (Anthropic-compatible endpoint) and Claude use the
 * same request shape; tests use a scripted fake.
 */

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export type ToolResultPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/jpeg'; data: string } };

export interface ToolResult {
  type: 'tool_result';
  tool_use_id: string;
  /** Text, or text and a picture (a bot looking at its own screen). */
  content: string | ToolResultPart[];
  is_error?: boolean;
}

export type AgentMessage =
  { role: 'user'; content: string | ToolResult[] } | { role: 'assistant'; content: Block[] };

export interface TurnResult {
  content: Block[];
  /** tool_use: run the tools and call again; end: the turn is over. */
  /** cut: it ran out of room mid-answer, so a tool call in it may be incomplete. */
  stop: 'tool_use' | 'end' | 'cut';
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface AgentModel {
  readonly name: string;
  turn(req: { system: string; messages: AgentMessage[]; tools: ToolSpec[] }): Promise<TurnResult>;
}

export class SdkAgentModel implements AgentModel {
  private readonly client: Anthropic;

  constructor(private readonly config: ModelConfig) {
    this.client = createClient(config);
  }

  get name(): string {
    return this.config.model;
  }

  /**
   * One model call. Tolerant of endpoints that differ in small ways: tool arguments sent as a
   * JSON string, a tool call with the wrong stop reason, an empty tool list; and it retries a
   * call that failed for a passing reason (rate limit, server error, network).
   */
  async turn(req: { system: string; messages: AgentMessage[]; tools: ToolSpec[] }) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.client.messages.create({
          model: this.config.model,
          max_tokens: 16000,
          system: req.system,
          messages: req.messages as Anthropic.MessageParam[],
          ...(req.tools.length ? { tools: req.tools as Anthropic.Tool[] } : {}),
        });
        const content: Block[] = [];
        for (const b of res.content) {
          if (b.type === 'text') content.push({ type: 'text', text: b.text });
          else if (b.type === 'tool_use') {
            content.push({ type: 'tool_use', id: b.id, name: b.name, input: toolInput(b.input) });
          }
        }
        return {
          content,
          // A tool call means tools to run, whatever stop reason came with it.
          stop:
            res.stop_reason === 'max_tokens'
              ? ('cut' as const)
              : content.some((b) => b.type === 'tool_use')
                ? ('tool_use' as const)
                : ('end' as const),
          model: res.model,
          usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        };
      } catch (err) {
        const e = asModelError(err, this.config.provider);
        if (e instanceof ModelCallError && e.retryable && attempt < RETRIES.length) {
          await new Promise((r) => setTimeout(r, RETRIES[attempt]));
          continue;
        }
        throw e;
      }
    }
  }
}

/** Waits before the retries of a call that failed for a passing reason. */
const RETRIES = [800, 2500];

/** Tool arguments as an object, also when an endpoint sends them as a JSON string. */
function toolInput(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}
