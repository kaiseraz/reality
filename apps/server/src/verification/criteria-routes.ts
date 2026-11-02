import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { StepResult } from '../orchestrator/graph.ts';
import type { TaskService } from '../tasks/task-service.ts';
import {
  checkCriterion,
  Criterion,
  evidenceFrom,
  RESULT_FIELDS,
  unbackedNumbers,
  verdictOf,
} from './criteria.ts';

const MAX_CRITERIA = 20;

/** Criteria a person set for a task, stored apart from the plan so no planner can change them. */
export class CriteriaStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(taskId: string): Promise<{ id: string; criterion: Criterion }[]> {
    const { rows } = await this.pool.query<{ id: string; criterion: Criterion }>(
      'SELECT id, criterion FROM task_criteria WHERE task_id = $1 ORDER BY position',
      [taskId],
    );
    return rows;
  }

  async add(taskId: string, criterion: Criterion): Promise<string> {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT COALESCE(MAX(position), 0) AS n FROM task_criteria WHERE task_id = $1',
      [taskId],
    );
    const position = Number(rows[0]?.n ?? 0) + 1;
    const id = `K${position}`;
    await this.pool.query(
      'INSERT INTO task_criteria (task_id, id, position, criterion) VALUES ($1, $2, $3, $4)',
      [taskId, id, position, JSON.stringify(criterion)],
    );
    return id;
  }

  async remove(taskId: string, id: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM task_criteria WHERE task_id = $1 AND id = $2', [
      taskId,
      id,
    ]);
    return (r.rowCount ?? 0) > 0;
  }
}

/**
 * GET returns the criteria with their verdict computed from the evidence right now.
 * POST and DELETE only work before the task runs: the goal must not move to fit a result.
 */
export function registerCriteriaRoutes(
  app: FastifyInstance,
  deps: { tasks: TaskService; criteria: CriteriaStore },
) {
  const Params = z.object({ id: z.uuid() });

  const state = async (taskId: string) => {
    const task = await deps.tasks.get(taskId);
    if (!task) return undefined;
    const results = (task.state?.stepResults ?? []) as StepResult[];
    const pending = task.pendingApproval as { kind?: string } | null;
    // Open for changes while the plan is being made or waits for its first approval.
    const locked = !(
      task.status === 'draft' ||
      task.status === 'planning' ||
      (task.status === 'awaiting_approval' && pending?.kind === 'plan-approval')
    );
    return { task, results, locked };
  };

  app.get('/api/tasks/:id/criteria', async (req, reply) => {
    const { id } = Params.parse(req.params);
    const s = await state(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const evidence = evidenceFrom(s.results);
    const criteria = (await deps.criteria.list(id)).map((c) =>
      checkCriterion(c.criterion, c.id, evidence),
    );
    // Value names a person can choose from: those of the recipes in the plan.
    const recipes = new Set(
      (s.task.state?.spec?.workflow ?? []).map((w) => w.recipe?.name).filter(Boolean),
    );
    const fields = Object.entries(RESULT_FIELDS)
      .filter(([recipe]) => recipes.has(recipe))
      .flatMap(([recipe, list]) => list.map((f) => ({ ...f, recipe })));
    // AI-written steps (no recipe): numbers in their output must have evidence.
    const aiSteps = new Set(
      (s.task.state?.spec?.workflow ?? [])
        .filter((w) => w.agent === 'analysis-agent' && !w.recipe && !w.tool)
        .map((w) => w.id),
    );
    const unbacked = Object.fromEntries(
      s.results
        .filter((r) => aiSteps.has(r.stepId) && r.status === 'done')
        .map((r) => [r.stepId, unbackedNumbers(r.detail, evidence, s.task.request)])
        .filter(([, list]) => (list as string[]).length > 0),
    );
    return {
      locked: s.locked,
      verdict: verdictOf(criteria),
      criteria,
      evidence,
      fields,
      unbacked,
    };
  });

  app.post('/api/tasks/:id/criteria', async (req, reply) => {
    const { id } = Params.parse(req.params);
    const s = await state(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (s.locked) {
      return reply.code(409).send({
        error: 'locked',
        message:
          'Criteria are fixed once the task runs, so the goal cannot move to fit the result.',
      });
    }
    const criterion = Criterion.parse(req.body);
    if ((await deps.criteria.list(id)).length >= MAX_CRITERIA) {
      return reply
        .code(422)
        .send({ error: 'rejected', message: `At most ${MAX_CRITERIA} criteria.` });
    }
    const cid = await deps.criteria.add(id, criterion);
    return reply.code(201).send({ id: cid });
  });

  app.delete('/api/tasks/:id/criteria/:cid', async (req, reply) => {
    const { id, cid } = z
      .object({ id: z.uuid(), cid: z.string().regex(/^K\d{1,3}$/) })
      .parse(req.params);
    const s = await state(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    if (s.locked) {
      return reply
        .code(409)
        .send({ error: 'locked', message: 'Criteria are fixed once the task runs.' });
    }
    return (await deps.criteria.remove(id, cid))
      ? { ok: true }
      : reply.code(404).send({ error: 'not_found' });
  });
}
