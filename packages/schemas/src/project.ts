import { z } from 'zod';
import { Id, Timestamp } from './common.ts';
import { TaskStatus } from './events.ts';

/** Long-term goals: a project is a tree of ordinary tasks run by the scheduler (M7). */
export const ProjectStatus = z.enum(['active', 'paused', 'completed', 'failed', 'budget_exceeded']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/**
 * ask-every-plan: every plan waits for the user.
 * ask-critical: plans that use only reviewed recipes or tools, need no new capability and fit
 * the budget are approved by the deterministic policy; everything else waits for the user.
 */
export const Autonomy = z.enum(['ask-every-plan', 'ask-critical']);
export type Autonomy = z.infer<typeof Autonomy>;

export const ProjectTaskDraft = z.object({
  title: z.string().trim().min(1).max(200),
  request: z.string().trim().min(1).max(10_000),
  /** Indices of tasks (in the same list) that must complete first. */
  dependsOn: z.array(z.number().int().nonnegative()).max(20).default([]),
  /** Index of a task whose main result becomes this task's input data. */
  useResultOf: z.number().int().nonnegative().optional(),
});
export type ProjectTaskDraft = z.infer<typeof ProjectTaskDraft>;

export const ProjectBudget = z.object({
  maxTasks: z.number().int().min(1).max(200).default(20),
  maxSandboxMinutes: z.number().int().min(1).max(10_000).default(60),
});
export type ProjectBudget = z.infer<typeof ProjectBudget>;

export const CreateProjectRequest = z.object({
  goal: z.string().trim().min(1).max(10_000),
  autonomy: Autonomy.default('ask-every-plan'),
  maxParallel: z.number().int().min(1).max(4).default(2),
  budget: ProjectBudget.default({ maxTasks: 20, maxSandboxMinutes: 60 }),
  /** Explicit tasks; without them the project planner decomposes the goal. */
  tasks: z.array(ProjectTaskDraft).max(50).optional(),
  /** Bots that work on the project; the scheduler gives each free bot one task at a time. */
  team: z.array(z.uuid()).max(10).default([]),
  /** false: create paused (e.g. to upload data first), then POST /resume. */
  start: z.boolean().default(true),
  /** Example datasets (samples) every task receives. Uploaded files are added separately. */
  samples: z.array(z.string().max(40)).max(5).default([]),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const ProjectTask = z.object({
  taskId: Id,
  position: z.number().int(),
  title: z.string(),
  request: z.string(),
  dependsOn: z.array(Id),
  inputFrom: Id.nullable(),
  status: TaskStatus,
  botId: Id.nullable(),
  /** Scheduler view: waiting (dependencies open), blocked (a dependency failed), or the task status. */
  board: z.enum(['waiting', 'blocked', 'running', 'needs_you', 'done', 'failed']),
  startedAt: Timestamp.nullable(),
});
export type ProjectTask = z.infer<typeof ProjectTask>;

export const ProjectSummary = z.object({
  id: Id,
  goal: z.string(),
  status: ProjectStatus,
  autonomy: Autonomy,
  maxParallel: z.number().int(),
  budget: ProjectBudget,
  team: z.array(Id),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  counts: z.object({ total: z.number(), done: z.number(), needsYou: z.number() }),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;
