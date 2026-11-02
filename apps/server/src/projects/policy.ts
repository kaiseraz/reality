import type { TaskSpec } from '@reality/schemas';
import { getCheck } from '../verification/checks.ts';
import { getRecipe } from '../analysis/recipes.ts';
import { findCandidate } from '../capabilities/catalog.ts';

export type PolicyVerdict = { approve: true; reason: string } | { approve: false; reason: string };

/**
 * The deterministic project policy (never a model). With autonomy "ask-critical" it approves
 * a plan without asking only if all of this holds:
 * - every analysis step runs a reviewed built-in recipe or a reviewed MCP tool (no AI-written
 *   code),
 * - no capability has to be acquired (installing one always needs a person),
 * - every acceptance criterion has a machine check, so the result will be verified,
 * - the project budget still allows another task.
 */
export function planPolicy(spec: TaskSpec, ctx: { budgetLeft: boolean }): PolicyVerdict {
  if (!ctx.budgetLeft) return { approve: false, reason: 'The project budget is used up.' };
  if (spec.missingCapabilities.length > 0) {
    return {
      approve: false,
      reason: `Needs a new capability (${spec.missingCapabilities.map((m) => m.need).join(', ')}); installing one always needs a person.`,
    };
  }
  for (const step of spec.workflow) {
    if (step.agent === 'capability-agent') {
      return { approve: false, reason: `Step "${step.id}" acquires a capability.` };
    }
    if (step.agent !== 'analysis-agent') continue;
    if (step.recipe) {
      if (!getRecipe(step.recipe.name)) {
        return { approve: false, reason: `Step "${step.id}" uses an unknown recipe.` };
      }
      continue;
    }
    if (step.tool) {
      const reviewed = findCandidate(step.tool.capability)?.mcp?.allowedTools ?? [];
      if (!reviewed.includes(step.tool.name)) {
        return {
          approve: false,
          reason: `Step "${step.id}" calls a tool outside the reviewed list.`,
        };
      }
      continue;
    }
    return {
      approve: false,
      reason: `Step "${step.id}" needs AI-written code, which a person must approve.`,
    };
  }
  const unchecked = spec.acceptanceCriteria.filter((a) => !a.check || !getCheck(a.check.name));
  if (unchecked.length > 0) {
    return {
      approve: false,
      reason: `${unchecked.length} acceptance criteria have no machine check, so the result could not be verified.`,
    };
  }
  return {
    approve: true,
    reason: `Only reviewed recipes and tools, no new capability, all ${spec.acceptanceCriteria.length} criteria machine-checked, within budget.`,
  };
}
