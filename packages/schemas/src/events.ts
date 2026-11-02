import { z } from 'zod';
import { Actor, Id, Timestamp } from './common.ts';

export const TaskStatus = z.enum([
  'draft',
  'planning',
  'awaiting_approval',
  'running',
  'completed',
  'rejected',
  'failed',
  'budget_exceeded',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'completed',
  'rejected',
  'failed',
  'budget_exceeded',
];

export const EventType = z.enum([
  'task.created',
  'task.resumed',
  'plan.created',
  'plan.invalid',
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'step.started',
  'step.completed',
  'verification.completed',
  'task.completed',
  'task.rejected',
  'task.failed',
  'task.budget_exceeded',
  'workspace.created',
  'workspace.patched',
  'workspace.action',
  'artifact.added',
  'run.started',
  'run.completed',
  'capability.discovered',
  'capability.searched',
  'capability.inspected',
  'capability.installed',
  'capability.tested',
  'capability.enabled',
  'capability.rejected',
  'capability.reused',
  'check.completed',
]);
export type EventType = z.infer<typeof EventType>;

/** Append-only audit record. `id` is a global, monotonically increasing sequence. */
export const TaskEvent = z.object({
  id: z.number().int().positive(),
  taskId: Id,
  type: EventType,
  actor: Actor,
  payload: z.unknown(),
  createdAt: Timestamp,
});
export type TaskEvent = z.infer<typeof TaskEvent>;

export const TaskSummary = z.object({
  id: Id,
  request: z.string(),
  status: TaskStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** The bot working on this task, if one was assigned. */
  botId: Id.nullable().optional(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

export const ApprovalDecision = z.object({
  approved: z.boolean(),
  note: z.string().max(2000).optional(),
  /** Who decided. Set only by the server: API input is always recorded as the user. */
  by: z.enum(['user', 'policy']).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export const CreateTaskRequest = z.object({
  request: z.string().trim().min(1).max(10_000),
  /** false: create as draft (e.g. to attach data first), then POST /start. */
  start: z.boolean().default(true),
  /** Give the task to one of your bots. */
  botId: z.uuid().optional(),
});
