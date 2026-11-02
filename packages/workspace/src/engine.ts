import {
  ComponentInstance,
  WorkspacePatch,
  type DataBinding,
  type WorkspacePatchOp,
  type WorkspaceSpec,
} from '@reality/schemas';
import type { ComponentDefinition, Registry } from './registry.ts';

export interface EngineContext {
  registry: Registry;
  /** Column names of a stored artifact; undefined if the artifact is unknown. */
  columnsOf?: (artifactId: string) => readonly string[] | undefined;
}

export type PatchResult =
  { ok: true; spec: WorkspaceSpec; inverse: WorkspacePatchOp[] } | { ok: false; errors: string[] };

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function sameMajor(a: string, b: string): boolean {
  return a.split('.')[0] === b.split('.')[0];
}

/**
 * Validates one component instance against its registry definition and returns the
 * normalized instance (props with defaults applied). Collects every problem rather than
 * stopping at the first, so a model proposing a patch gets complete feedback.
 */
export function validateInstance(
  id: string,
  raw: unknown,
  ctx: EngineContext,
): { instance?: ComponentInstance; errors: string[] } {
  const parsed = ComponentInstance.safeParse(raw);
  if (!parsed.success) {
    return { errors: parsed.error.issues.map((i) => `${id}.${i.path.join('.')}: ${i.message}`) };
  }
  const instance = parsed.data;
  const def: ComponentDefinition | undefined = ctx.registry.get(instance.type);
  if (!def) return { errors: [`${id}: unknown component type "${instance.type}"`] };

  const errors: string[] = [];
  if (!sameMajor(def.version, instance.typeVersion)) {
    errors.push(`${id}: ${instance.type}@${instance.typeVersion} incompatible with ${def.version}`);
  }

  const props = def.props.safeParse(instance.props);
  if (!props.success) {
    for (const i of props.error.issues)
      errors.push(`${id}.props.${i.path.join('.')}: ${i.message}`);
  }

  for (const [input, binding] of Object.entries(instance.bindings)) {
    const spec = def.inputs[input];
    if (!spec) {
      errors.push(`${id}: ${instance.type} has no input "${input}"`);
      continue;
    }
    errors.push(...checkBinding(id, input, spec, binding, ctx));
  }
  for (const [input, spec] of Object.entries(def.inputs)) {
    if (spec.required && !instance.bindings[input]) {
      errors.push(`${id}: required input "${input}" is not bound`);
    }
  }

  for (const action of instance.actions) {
    if (!def.actions[action]) errors.push(`${id}: ${instance.type} has no action "${action}"`);
  }

  if (props.success && def.fieldRefs && ctx.columnsOf) {
    for (const ref of def.fieldRefs(props.data)) {
      const binding = instance.bindings[ref.input];
      if (binding?.kind !== 'artifact') continue;
      const columns = ctx.columnsOf(binding.artifact.id);
      if (columns && !columns.includes(ref.field)) {
        errors.push(`${id}: field "${ref.field}" not found in bound dataset`);
      }
    }
  }

  if (errors.length > 0) return { errors };
  return { instance: { ...instance, props: props.success ? props.data : {} }, errors };
}

function checkBinding(
  id: string,
  input: string,
  spec: ComponentDefinition['inputs'][string],
  binding: DataBinding,
  ctx: EngineContext,
): string[] {
  if (spec.kind !== binding.kind) {
    return [`${id}.${input}: expects a ${spec.kind} binding, got ${binding.kind}`];
  }
  if (spec.kind === 'task' && binding.kind === 'task' && spec.path !== binding.path) {
    return [`${id}.${input}: expects task.${spec.path}, got task.${binding.path}`];
  }
  if (spec.kind === 'artifact' && binding.kind === 'artifact') {
    if (!spec.mediaTypes.includes(binding.artifact.mediaType)) {
      return [`${id}.${input}: media type ${binding.artifact.mediaType} not accepted`];
    }
    if (ctx.columnsOf && ctx.columnsOf(binding.artifact.id) === undefined) {
      return [`${id}.${input}: artifact ${binding.artifact.id} does not exist`];
    }
  }
  return [];
}

/**
 * Applies a patch atomically: either every op succeeds and a new version is produced,
 * or nothing changes. Returns the inverse ops, which undo the patch exactly.
 */
export function applyPatch(
  spec: WorkspaceSpec,
  rawPatch: unknown,
  ctx: EngineContext,
): PatchResult {
  const parsedPatch = WorkspacePatch.safeParse(rawPatch);
  if (!parsedPatch.success) {
    return {
      ok: false,
      errors: parsedPatch.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  const patch = parsedPatch.data;
  if (patch.workspaceId !== spec.id)
    return { ok: false, errors: ['patch targets another workspace'] };
  if (patch.baseVersion !== spec.version) {
    return {
      ok: false,
      errors: [`stale patch: based on v${patch.baseVersion}, workspace is at v${spec.version}`],
    };
  }

  // Shallow copy is enough: instances are replaced, never mutated in place.
  let components = { ...spec.components };
  let layout = spec.layout;
  const inverse: WorkspacePatchOp[] = [];
  const errors: string[] = [];

  patch.ops.forEach((op, index) => {
    const where = `ops.${index} (${op.op})`;
    switch (op.op) {
      case 'addComponent': {
        if (components[op.instanceId]) {
          errors.push(`${where}: instance "${op.instanceId}" already exists`);
          return;
        }
        const { instance, errors: e } = validateInstance(op.instanceId, op.component, ctx);
        if (!instance) return void errors.push(...e.map((m) => `${where}: ${m}`));
        components[op.instanceId] = instance;
        inverse.unshift({ op: 'removeComponent', instanceId: op.instanceId });
        return;
      }
      case 'removeComponent': {
        const existing = components[op.instanceId];
        if (!existing) return void errors.push(`${where}: no instance "${op.instanceId}"`);
        components = omit(components, op.instanceId);
        inverse.unshift({ op: 'addComponent', instanceId: op.instanceId, component: existing });
        return;
      }
      case 'updateProps': {
        const existing = components[op.instanceId];
        if (!existing) return void errors.push(`${where}: no instance "${op.instanceId}"`);
        const nextProps = op.replace ? op.props : { ...existing.props, ...op.props };
        const { instance, errors: e } = validateInstance(
          op.instanceId,
          { ...existing, props: nextProps },
          ctx,
        );
        if (!instance) return void errors.push(...e.map((m) => `${where}: ${m}`));
        components[op.instanceId] = instance;
        inverse.unshift({
          op: 'updateProps',
          instanceId: op.instanceId,
          props: existing.props,
          replace: true,
        });
        return;
      }
      case 'rebind': {
        const existing = components[op.instanceId];
        if (!existing) return void errors.push(`${where}: no instance "${op.instanceId}"`);
        const previous = existing.bindings[op.input] ?? null;
        const bindings = op.binding
          ? { ...existing.bindings, [op.input]: op.binding }
          : omit(existing.bindings, op.input);
        const { instance, errors: e } = validateInstance(
          op.instanceId,
          { ...existing, bindings },
          ctx,
        );
        if (!instance) return void errors.push(...e.map((m) => `${where}: ${m}`));
        components[op.instanceId] = instance;
        inverse.unshift({
          op: 'rebind',
          instanceId: op.instanceId,
          input: op.input,
          binding: previous,
        });
        return;
      }
      case 'setLayout': {
        inverse.unshift({ op: 'setLayout', layout });
        layout = op.layout;
        return;
      }
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    spec: { ...spec, version: spec.version + 1, components, layout },
    inverse,
  };
}

/** Layout-only patches are user arrangement, not content; undo skips them. */
export function isLayoutOnly(ops: readonly WorkspacePatchOp[]): boolean {
  return ops.every((op) => op.op === 'setLayout');
}
