import { z } from 'zod';

export const Id = z.string().min(1).max(128);

export const Timestamp = z.iso.datetime();

/** Content-addressed reference to a stored artifact (dataset, result table, chart data, log). */
export const ArtifactRef = z.object({
  id: Id,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().min(1),
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;

/** Who performed or proposed something. Agents are named roles, not free text. */
export const Actor = z.enum([
  'user',
  'system',
  'orchestrator',
  'analysis-agent',
  'capability-agent',
  'workspace-agent',
  'verification-agent',
  /** Searches literature and the owner's knowledge sources (server-side, never in the sandbox). */
  'research-agent',
  /** Runs simulation engines (photonics, quantum, chemistry, materials) in the sandbox. */
  'lab-agent',
  /** The deterministic project policy (never a model), e.g. for automatic plan approval. */
  'policy',
]);
export type Actor = z.infer<typeof Actor>;
