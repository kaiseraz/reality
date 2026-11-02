import { z } from 'zod';
import type { TaskSpec } from '@reality/schemas';
import { getRecipe, RECIPES } from '../analysis/recipes.ts';
import { CATALOG, findCandidate, findCatalogEntry } from '../capabilities/catalog.ts';
import { checkReadOnlySql } from '../capabilities/mcp.ts';
import { CHECKS, getCheck } from '../verification/checks.ts';
import { getResearchRecipe, RESEARCH_RECIPES } from '../research/research-step.ts';
import { getLabEngine, LAB_ENGINES } from '../lab/engines.ts';
import type { DatasetInfo } from './planner.ts';

/**
 * What a planner may use, rendered for a model prompt: the dataset schema (never raw
 * rows), the built-in recipes and checks with their parameter schemas, and the
 * capabilities that exist or can be acquired.
 */
export function planningContext(input: {
  datasets?: DatasetInfo[] | undefined;
  availableCapabilities?: string[] | undefined;
}): string {
  const schema = (t: z.ZodType) => JSON.stringify(z.toJSONSchema(t, { io: 'input' }));
  const datasets = (input.datasets ?? []).map(
    (d) =>
      `- ${d.filename}: ${d.rowCount} rows; columns ${d.columns
        .map(
          (c) =>
            `${c.name} (${c.type}${c.distinct !== undefined ? `, ${c.distinct} distinct` : ''}${c.integer ? ', integers' : ''}${c.minDate ? `, ${c.minDate}…${c.maxDate}` : ''})`,
        )
        .join(', ')}${d.notes?.length ? `\n  Prepared on upload: ${d.notes.join(' ')}` : ''}`,
  );
  return [
    '<datasets>',
    datasets.length > 0 ? datasets.join('\n') : 'No dataset attached.',
    '</datasets>',
    '<recipes>',
    ...RECIPES.map(
      (r) =>
        `- ${r.name}: ${r.description}${r.requires.length ? ` Requires capability: ${r.requires.join(', ')}.` : ''} Params JSON schema: ${schema(r.params)}`,
    ),
    '</recipes>',
    '<lab>',
    'lab-agent steps run these simulation engines in the sandbox (no dataset needed):',
    ...LAB_ENGINES.map(
      (e) =>
        `- ${e.name} (${e.domain}): ${e.description}${e.requires.length ? ` Requires capability: ${e.requires.join(', ')} (acquirable need "${e.need}").` : ''} Check: ${e.check} (params {"step": "<step id>", ...same params as the engine}). Params JSON schema: ${schema(e.params)}`,
    ),
    '</lab>',
    '<research>',
    'research-agent steps run outside the sandbox and need no dataset. Set "recipe" to one of:',
    ...RESEARCH_RECIPES.map(
      (r) => `- ${r.name}: ${r.description} Params JSON schema: ${schema(r.params)}`,
    ),
    '</research>',
    '<checks>',
    ...CHECKS.map(
      (c) =>
        `- ${c.name}: ${c.description}${c.needsResult ? ' Param "step" names the plan step whose result is checked.' : ''} Params JSON schema: ${schema(c.params)}`,
    ),
    '</checks>',
    '<tools>',
    ...CATALOG.flatMap((e) =>
      e.candidates
        .filter((c) => c.mcp)
        .flatMap((c) =>
          (c.mcp?.allowedTools ?? []).map(
            (t) =>
              `- ${c.provides}/${t}: MCP tool for need "${e.label}". ${t === 'execute_query' ? 'Args {"sql": "<one read-only SELECT>"}; the dataset is table "data" (DuckDB dialect); max 10,000 rows. Pair it with the sql_result_matches check.' : ''}`,
          ),
        ),
    ),
    '</tools>',
    '<capabilities>',
    `Enabled: ${(input.availableCapabilities ?? []).join(', ') || 'none'}.`,
    ...CATALOG.map(
      (e) =>
        `Acquirable need "${e.label}" provides: ${e.candidates.map((c) => c.provides).join(', ')}.`,
    ),
    '</capabilities>',
  ].join('\n');
}

/**
 * Semantic validation every plan must pass, whoever produced it: recipes and checks
 * exist and their parameters are valid, referenced columns exist, checks point at
 * real steps, and required capabilities are enabled or acquired by an earlier step.
 */
export function validatePlan(
  spec: TaskSpec,
  ctx: { datasets: DatasetInfo[]; availableCapabilities: string[] },
): string[] {
  const errors: string[] = [];
  const columns = new Set(ctx.datasets.flatMap((d) => d.columns.map((c) => c.name)));
  const stepIds = new Set(spec.workflow.map((s) => s.id));
  const columnParams = (params: Record<string, unknown>, where: string) => {
    for (const key of ['date', 'value', 'group']) {
      const v = params[key];
      if (typeof v === 'string' && columns.size > 0 && !columns.has(v)) {
        errors.push(`${where}: column "${v}" (param ${key}) is not in the dataset`);
      }
    }
  };
  const acquires = (step: TaskSpec['workflow'][number], seen = new Set<string>()): Set<string> => {
    const out = new Set<string>();
    for (const dep of step.dependsOn) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const d = spec.workflow.find((s) => s.id === dep);
      if (!d) continue;
      if (d.agent === 'capability-agent' && d.capability) {
        findCatalogEntry(d.capability)?.candidates.forEach((c) => out.add(c.provides));
      }
      acquires(d, seen).forEach((p) => out.add(p));
    }
    return out;
  };

  for (const step of spec.workflow) {
    const where = `workflow.${step.id}`;
    if (step.agent === 'lab-agent') {
      const engine = step.recipe ? getLabEngine(step.recipe.name) : undefined;
      if (!engine) {
        errors.push(
          `${where}: lab-agent steps need a lab engine (${LAB_ENGINES.map((e) => e.name).join(', ')})`,
        );
        continue;
      }
      const parsed = engine.params.safeParse(step.recipe?.params ?? {});
      if (!parsed.success) {
        errors.push(`${where}: invalid params for ${engine.name}: ${parsed.error.message}`);
      }
      const reachable = acquires(step);
      for (const cap of engine.requires) {
        if (!ctx.availableCapabilities.includes(cap) && !reachable.has(cap)) {
          errors.push(
            `${where}: engine ${engine.name} needs capability "${cap}"; add a capability-agent step for "${engine.need ?? cap}" it depends on`,
          );
        }
      }
      continue;
    }
    if (step.agent === 'research-agent') {
      const research = step.recipe ? getResearchRecipe(step.recipe.name) : undefined;
      if (!research) {
        errors.push(
          `${where}: research-agent steps need a research recipe (${RESEARCH_RECIPES.map((r) => r.name).join(', ')})`,
        );
        continue;
      }
      const parsed = research.params.safeParse(step.recipe?.params ?? {});
      if (!parsed.success) {
        errors.push(`${where}: invalid params for ${research.name}: ${parsed.error.message}`);
      }
      if (
        research.name === 'synthesize' &&
        !step.dependsOn.some((d) => {
          const name = spec.workflow.find((s) => s.id === d)?.recipe?.name;
          return name === 'literature' || name === 'knowledge';
        })
      ) {
        errors.push(`${where}: synthesize must depend on a literature or knowledge step`);
      }
      continue;
    }
    if (step.recipe && getResearchRecipe(step.recipe.name)) {
      errors.push(`${where}: recipe ${step.recipe.name} belongs to a research-agent step`);
      continue;
    }
    if (step.agent === 'capability-agent') {
      if (!step.capability) errors.push(`${where}: capability-agent steps need "capability"`);
      // A need the reviewed catalog does not know is searched for (verified, inspected and
      // approved like any library); only a need too vague to search for is refused.
      else if (!findCatalogEntry(step.capability) && step.capability.trim().length < 8) {
        errors.push(
          `${where}: the capability need "${step.capability}" is too short to search for`,
        );
      }
    }
    if (step.tool) {
      if (step.recipe) errors.push(`${where}: a step uses either a recipe or a tool, not both`);
      const candidate = findCandidate(step.tool.capability);
      if (!candidate?.mcp) {
        errors.push(`${where}: "${step.tool.capability}" is not a reviewed MCP capability`);
      } else if (!candidate.mcp.allowedTools.includes(step.tool.name)) {
        errors.push(
          `${where}: tool "${step.tool.name}" is not approved for ${step.tool.capability}`,
        );
      } else if (
        !ctx.availableCapabilities.includes(step.tool.capability) &&
        !acquires(step).has(step.tool.capability)
      ) {
        errors.push(
          `${where}: tool needs capability "${step.tool.capability}"; add a capability-agent step it depends on`,
        );
      }
      if (step.tool.name === 'execute_query') {
        const sql = step.tool.args.sql;
        const problem = typeof sql === 'string' ? checkReadOnlySql(sql) : 'missing "sql" argument';
        if (problem) errors.push(`${where}: ${problem}`);
      }
      continue;
    }
    if (!step.recipe) continue;
    const recipe = getRecipe(step.recipe.name);
    if (!recipe) {
      errors.push(
        `${where}: unknown recipe "${step.recipe.name}" (use one of ${RECIPES.map((r) => r.name).join(', ')})`,
      );
      continue;
    }
    const parsed = recipe.params.safeParse(step.recipe.params);
    if (!parsed.success)
      errors.push(`${where}: invalid params for ${recipe.name}: ${parsed.error.message}`);
    else columnParams(parsed.data, where);
    const reachable = acquires(step);
    for (const cap of recipe.requires) {
      if (!ctx.availableCapabilities.includes(cap) && !reachable.has(cap)) {
        errors.push(
          `${where}: recipe ${recipe.name} needs capability "${cap}"; add a capability-agent step it depends on`,
        );
      }
    }
  }

  for (const ac of spec.acceptanceCriteria) {
    if (!ac.check) continue;
    const where = `acceptanceCriteria.${ac.id}`;
    const check = getCheck(ac.check.name);
    if (!check) {
      errors.push(
        `${where}: unknown check "${ac.check.name}" (use one of ${CHECKS.map((c) => c.name).join(', ')})`,
      );
      continue;
    }
    const parsed = check.params.safeParse(ac.check.params);
    if (!parsed.success) {
      errors.push(`${where}: invalid params for ${check.name}: ${parsed.error.message}`);
      continue;
    }
    columnParams(parsed.data, where);
    if (check.needsResult && !stepIds.has(String(parsed.data.step))) {
      errors.push(`${where}: check refers to unknown step "${String(parsed.data.step)}"`);
    }
  }
  return errors;
}
