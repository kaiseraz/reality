import type { AcceptanceCriterion } from '@reality/schemas';
import { primaryDataset } from '../analysis/executor.ts';
import type { SandboxService } from '../analysis/sandbox-service.ts';
import type { ArtifactStore } from '../artifacts/artifact-store.ts';
import type { EventLog } from '../events/event-log.ts';
import type { CheckResult, StepResult, Verifier } from '../orchestrator/graph.ts';
import { checkPrelude, getCheck } from './checks.ts';
import type { FileStore } from '../artifacts/file-store.ts';

interface CheckSummary {
  passed: boolean;
  checked: number;
  max_abs_error: number;
  mismatches: unknown[];
  note: string;
}

const isSummary = (v: unknown): v is CheckSummary =>
  typeof v === 'object' && v !== null && typeof (v as CheckSummary).passed === 'boolean';

/**
 * The Verification Agent. It never trusts a step's own claim of success: each
 * criterion with a machine check is re-computed independently in the sandbox from the
 * raw data. Anything it cannot check is reported as unverified, with the reason.
 */
export function createVerifier(deps: {
  sandbox: SandboxService;
  artifacts: ArtifactStore;
  events: EventLog;
  files?: FileStore;
}): Verifier {
  return async ({ taskId, spec, stepResults }) => {
    const dataset = await primaryDataset(deps.artifacts, taskId);
    const results: CheckResult[] = [];
    for (const ac of spec.acceptanceCriteria) {
      const result = await verifyOne(ac, taskId, stepResults, dataset);
      results.push(result);
      await deps.events.append(taskId, 'check.completed', 'verification-agent', result);
    }
    return results;
  };

  async function verifyOne(
    ac: AcceptanceCriterion,
    taskId: string,
    stepResults: StepResult[],
    dataset: Awaited<ReturnType<typeof primaryDataset>>,
  ): Promise<CheckResult> {
    const unverified = (detail: string): CheckResult => ({
      criterionId: ac.id,
      status: 'unverified',
      detail,
    });
    if (!ac.check) {
      return unverified(
        ac.checkType === 'human' || ac.checkType === 'llm-judge'
          ? `Needs ${ac.checkType === 'human' ? 'human review' : 'a judgement check'}; not machine-verified.`
          : 'No machine check is defined for this criterion.',
      );
    }
    const check = getCheck(ac.check.name);
    if (!check) return unverified(`Unknown check "${ac.check.name}".`);
    const params = check.params.safeParse(ac.check.params);
    if (!params.success) return unverified(`Invalid check parameters: ${params.error.message}`);
    const needsData = check.needsData !== false;
    if (needsData && !dataset) return unverified('No dataset to check against.');

    const inputs =
      needsData && dataset
        ? [{ name: 'data.csv', hostPath: deps.artifacts.filePath(dataset) }]
        : [];
    // What the step claims (its summary), so a check can re-derive the claim from raw data.
    let claim: unknown = null;
    if (check.needsResult) {
      const stepId = String(params.data.step);
      const step = stepResults.findLast((r) => r.stepId === stepId);
      if (!step || step.status !== 'done') {
        return unverified(`Not checked: step "${stepId}" did not complete.`);
      }
      const artifactId = step.artifacts?.[0];
      const result = artifactId ? await deps.artifacts.get(artifactId) : undefined;
      if (!result) return unverified(`Not checked: step "${stepId}" produced no result file.`);
      inputs.push({ name: 'result.csv', hostPath: deps.artifacts.filePath(result) });
      claim = step.summary ?? null;
      if (check.needsFiles && deps.files) {
        for (const f of await deps.files.forStep(taskId, stepId)) {
          inputs.push({ name: f.name, hostPath: deps.files.filePath(f) });
        }
      }
    }

    const exec = await deps.sandbox.execute({
      taskId,
      stepId: `check:${ac.id}`,
      kind: 'check',
      label: `check:${check.name}`,
      code: checkPrelude(params.data, claim) + check.body,
      inputs,
      // A busy machine must not turn a right result into a failed check.
      limits: { timeoutMs: 300_000 },
    });
    await exec.result.cleanup();
    if (exec.result.status !== 'succeeded' || !isSummary(exec.summary)) {
      return {
        criterionId: ac.id,
        status: 'failed',
        detail: `The check itself did not complete (${exec.result.status}): ${exec.result.stderr.slice(-500)}`,
        runId: exec.record.id,
      };
    }
    // A check may decline honestly (e.g. a query the independent engine cannot run).
    if ((exec.summary as { unsupported?: boolean }).unsupported) {
      return { ...unverified(exec.summary.note), runId: exec.record.id, evidence: exec.summary };
    }
    return {
      criterionId: ac.id,
      status: exec.summary.passed ? 'passed' : 'failed',
      detail: exec.summary.note,
      runId: exec.record.id,
      evidence: exec.summary,
    };
  }
}
