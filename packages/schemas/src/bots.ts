import { z } from 'zod';
import { Id, Timestamp } from './common.ts';
import { TaskStatus } from './events.ts';

/**
 * Bots: named, persistent team members (in the spirit of Grok Bot, adapted from Astra).
 * Each bot works on one task at a time. Its status follows from its tasks; nothing about a
 * bot can approve or run anything by itself. The role describes what it is for.
 */
export const BotRole = z.enum(['analyst', 'researcher', 'engineer', 'reviewer', 'lead']);
export type BotRole = z.infer<typeof BotRole>;

/** The shape of a bot's animated figure. */
export const BotFigure = z.enum(['orb', 'cube', 'pill', 'cloud']);
export type BotFigure = z.infer<typeof BotFigure>;

export const CreateBotRequest = z.object({
  name: z.string().trim().min(1).max(40),
  role: BotRole,
  /** How the bot talks and works, in a few sentences. */
  persona: z.string().trim().max(600).optional(),
  figure: BotFigure.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type CreateBotRequest = z.infer<typeof CreateBotRequest>;

/** Changing how a bot presents itself (its figure or colour), from the chat menu. */
export const UpdateBotRequest = z.object({
  figure: BotFigure.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type UpdateBotRequest = z.infer<typeof UpdateBotRequest>;

export const BotView = z.object({
  id: Id,
  name: z.string(),
  role: BotRole,
  color: z.string(),
  persona: z.string(),
  figure: BotFigure,
  createdAt: Timestamp,
  /** working: a task of it is planning or running; waiting: one waits for a person. */
  status: z.enum(['working', 'waiting', 'idle']),
  current: z.object({ taskId: Id, request: z.string(), status: TaskStatus }).nullable(),
  done: z.number().int(),
  /** The lead every person has from the start; it hires the specialists. */
  isMain: z.boolean(),
  /** Not on a job: kept with its record and skills until the lead hires it again. */
  resting: z.boolean(),
  /** Contracts this bot fulfilled or failed, as judged by code, never by a bot. */
  record: z.object({ met: z.number().int(), failed: z.number().int() }),
});
export type BotView = z.infer<typeof BotView>;
