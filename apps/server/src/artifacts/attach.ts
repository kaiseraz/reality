import type { Actor } from '@reality/schemas';
import type { EventLog } from '../events/event-log.ts';
import type { WorkspaceService } from '../workspaces/workspace-service.ts';
import type { ArtifactMeta, ArtifactStore } from './artifact-store.ts';

export interface AttachDeps {
  artifacts: ArtifactStore;
  events: EventLog;
  workspaces: WorkspaceService;
}

/**
 * Attaches a CSV to a task the way a user upload is attached: stored, prepared if needed,
 * recorded in the task log and shown in its workspace. Used for uploads, example datasets
 * and project data.
 */
export async function attachUpload(
  deps: AttachDeps,
  taskId: string,
  filename: string,
  text: string,
  actor: Actor = 'user',
): Promise<ArtifactMeta & { prepared: ArtifactMeta | null }> {
  const { original, prepared } = await deps.artifacts.putUpload(taskId, filename, text);
  await deps.events.append(taskId, 'artifact.added', actor, {
    artifactId: original.ref.id,
    filename: original.filename,
    rows: original.rowCount,
    columns: original.columns,
  });
  if (prepared) {
    await deps.events.append(taskId, 'artifact.added', 'system', {
      artifactId: prepared.ref.id,
      filename: prepared.filename,
      rows: prepared.rowCount,
      provenance: prepared.provenance,
    });
  }
  // The workspace shows the working dataset (prepared if cleaning was needed).
  await deps.workspaces.onDatasetAdded(taskId, prepared ?? original);
  return { ...original, prepared: prepared ?? null };
}
