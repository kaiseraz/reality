import { z } from 'zod';
import { Actor, ArtifactRef, Id } from './common.ts';

/** Parts of the live task state a component may bind to. */
export const TaskStatePath = z.enum([
  'spec',
  'events',
  'approval',
  'runs',
  'verification',
  'capabilities',
]);
export type TaskStatePath = z.infer<typeof TaskStatePath>;

/** Binds a component input to real data. Components never receive invented values. */
export const DataBinding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), artifact: ArtifactRef }),
  z.object({ kind: z.literal('task'), path: TaskStatePath }),
]);
export type DataBinding = z.infer<typeof DataBinding>;

export const ComponentInstance = z.object({
  type: z.string().min(1),
  typeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** Validated against the component's own props schema by the workspace engine. */
  props: z.record(z.string(), z.unknown()).default({}),
  bindings: z.record(z.string(), DataBinding).default({}),
  actions: z.array(Id).default([]),
  provenance: z.object({
    proposedBy: z.enum(['template', 'workspace-agent', 'user']),
    verified: z.boolean().default(false),
  }),
});
export type ComponentInstance = z.infer<typeof ComponentInstance>;

export const WorkspaceSpec = z.object({
  id: Id,
  version: z.number().int().nonnegative(),
  taskId: Id,
  workspaceType: z.string().min(1),
  /** Serialized docking layout (dockview `toJSON()` output); opaque to the schema layer. */
  layout: z.unknown(),
  components: z.record(Id, ComponentInstance),
});
export type WorkspaceSpec = z.infer<typeof WorkspaceSpec>;

/**
 * Workspaces change only through patches, never by regeneration, so component state
 * (keyed by instanceId) survives as the task evolves. Every op has an exact inverse,
 * which is what makes undo lossless.
 */
export const WorkspacePatchOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addComponent'), instanceId: Id, component: ComponentInstance }),
  z.object({ op: z.literal('removeComponent'), instanceId: Id }),
  z.object({
    op: z.literal('updateProps'),
    instanceId: Id,
    props: z.record(z.string(), z.unknown()),
    /** false (default): merge into existing props. true: replace them entirely. */
    replace: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('rebind'),
    instanceId: Id,
    input: z.string(),
    /** null removes the binding. */
    binding: DataBinding.nullable(),
  }),
  z.object({ op: z.literal('setLayout'), layout: z.unknown() }),
]);
export type WorkspacePatchOp = z.infer<typeof WorkspacePatchOp>;

export const WorkspacePatch = z.object({
  workspaceId: Id,
  baseVersion: z.number().int().nonnegative(),
  proposedBy: Actor,
  ops: z.array(WorkspacePatchOp).min(1),
});
export type WorkspacePatch = z.infer<typeof WorkspacePatch>;

/** What a component emits when the user acts. Routed through policy; never calls tools directly. */
export const ActionIntent = z.object({
  workspaceId: Id,
  instanceId: Id,
  actionId: Id,
  /** Omitted means an empty payload; the action definition validates the shape. */
  payload: z.unknown().optional(),
});
export type ActionIntent = z.infer<typeof ActionIntent>;
