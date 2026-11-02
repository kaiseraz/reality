import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';

/**
 * What model use costs, call by call. Every model call (a bot's turn, the planner, research
 * answers, analysis code) reports its tokens here; the call's scope says which chat, bot and
 * task it was for, so a mission can add up everything done on its behalf and stop at its
 * budget. Costs are in the configured unit (credits, €), or in thousands of tokens.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface Pricing {
  /** The unit costs are counted in, as people read it: "credits", "€", "k tokens". */
  unit: string;
  /** Cost per million tokens sent to the model. */
  inputPerMillion: number;
  /** Cost per million tokens the model wrote. */
  outputPerMillion: number;
}

/** Prices from the configuration; without them, a call costs its tokens in thousands. */
export function pricingOf(cfg: {
  MODEL_PRICE_INPUT?: number | undefined;
  MODEL_PRICE_OUTPUT?: number | undefined;
  MODEL_PRICE_UNIT?: string | undefined;
}): Pricing {
  if (cfg.MODEL_PRICE_INPUT === undefined && cfg.MODEL_PRICE_OUTPUT === undefined) {
    return { unit: 'k tokens', inputPerMillion: 1000, outputPerMillion: 1000 };
  }
  return {
    unit: cfg.MODEL_PRICE_UNIT ?? 'credits',
    inputPerMillion: cfg.MODEL_PRICE_INPUT ?? 0,
    outputPerMillion: cfg.MODEL_PRICE_OUTPUT ?? 0,
  };
}

export const costOf = (p: Pricing, u: Usage) =>
  (u.inputTokens * p.inputPerMillion + u.outputTokens * p.outputPerMillion) / 1_000_000;

/** Who a model call is for. */
export interface UsageScope {
  chatId?: string;
  botId?: string;
  taskId?: string;
}

const scope = new AsyncLocalStorage<UsageScope>();

/** Runs fn with model calls inside it counted for this chat, bot or task. */
export function withUsageScope<T>(s: UsageScope, fn: () => Promise<T>): Promise<T> {
  return scope.run({ ...scope.getStore(), ...s }, fn);
}

export const currentUsageScope = (): UsageScope => scope.getStore() ?? {};

/** The model calls of each chat and task, with what they cost. */
export class UsageLedger {
  constructor(
    private readonly pool: pg.Pool,
    readonly pricing: Pricing,
    private readonly log?: { error: (obj: unknown, msg?: string) => void },
  ) {}

  /** Records one call in the current scope. Never fails the call it counts. */
  record(model: string, usage: Usage): Promise<void> {
    const s = currentUsageScope();
    const cost = costOf(this.pricing, usage);
    return this.pool
      .query(
        `INSERT INTO model_usage (chat_id, bot_id, task_id, model, input_tokens, output_tokens, cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          s.chatId ?? null,
          s.botId ?? null,
          s.taskId ?? null,
          model,
          usage.inputTokens,
          usage.outputTokens,
          cost,
        ],
      )
      .then(
        () => undefined,
        (err: unknown) => this.log?.error({ err }, 'model usage not recorded'),
      );
  }

  /** Everything spent for a chat: its bots' turns and the tasks they started. */
  async spentForChat(chatId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(cost), 0) AS total FROM model_usage
        WHERE chat_id = $1 OR task_id IN (SELECT task_id FROM chat_runs WHERE chat_id = $1)`,
      [chatId],
    );
    return Number(rows[0]?.total ?? 0);
  }

  /** What each bot of a chat spent (tasks count for the bot that started them). */
  async byBot(chatId: string): Promise<{ botId: string | null; cost: number; calls: number }[]> {
    const { rows } = await this.pool.query<{
      bot_id: string | null;
      cost: string;
      calls: string;
    }>(
      `SELECT COALESCE(u.bot_id, r.bot_id) AS bot_id, SUM(u.cost) AS cost, COUNT(*) AS calls
         FROM model_usage u
         LEFT JOIN chat_runs r ON r.task_id = u.task_id AND r.chat_id = $1
        WHERE u.chat_id = $1 OR r.chat_id = $1
        GROUP BY 1 ORDER BY 2 DESC`,
      [chatId],
    );
    return rows.map((r) => ({ botId: r.bot_id, cost: Number(r.cost), calls: Number(r.calls) }));
  }
}
