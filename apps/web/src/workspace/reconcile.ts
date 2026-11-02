import type { WorkspaceSpec } from '@reality/schemas';
import { registry } from '@reality/workspace';

export type Region = 'main' | 'side' | 'bottom';
export type Direction = 'within' | 'below' | 'above' | 'left' | 'right';

export interface PanelAdd {
  id: string;
  title: string;
  position?: { referencePanel: string; direction: Direction };
}

export interface PanelPlan {
  remove: string[];
  add: PanelAdd[];
  retitle: { id: string; title: string }[];
}

const ORDER: Region[] = ['main', 'bottom'];

export function regionOf(spec: WorkspaceSpec, id: string): Region {
  const type = spec.components[id]?.type;
  return (type && registry.get(type)?.defaultRegion) || 'main';
}

export function titleOf(spec: WorkspaceSpec, id: string): string {
  const title = spec.components[id]?.props.title;
  return typeof title === 'string' && title ? title : (spec.components[id]?.type ?? id);
}

/**
 * Computes the minimal change set that brings the dock in line with the spec. Panels
 * whose instance still exists are never removed or re-created, so their component state
 * (scroll, page, sort, inputs) survives every patch.
 */
export function planPanels(existingIds: readonly string[], spec: WorkspaceSpec): PanelPlan {
  const wanted = new Set(Object.keys(spec.components));
  const remove = existingIds.filter((id) => !wanted.has(id));
  const kept = existingIds.filter((id) => wanted.has(id));

  const placed: { id: string; region: Region }[] = kept.map((id) => ({
    id,
    region: regionOf(spec, id),
  }));
  const first = (r: Region) => placed.find((p) => p.region === r)?.id;
  const last = (r: Region) => placed.filter((p) => p.region === r).at(-1)?.id;

  const add: PanelAdd[] = [];
  // Placement order matters to the split tree: anchor the side column with one panel,
  // build the main/bottom area to its right, then stack further side panels in the column.
  // (Stacking side panels first would make later splits span the whole width.)
  const freshIds = [...wanted].filter((id) => !kept.includes(id));
  const anchor = first('side') ? undefined : freshIds.find((id) => regionOf(spec, id) === 'side');
  const rank = (id: string) =>
    id === anchor
      ? -1
      : regionOf(spec, id) === 'side'
        ? ORDER.length
        : ORDER.indexOf(regionOf(spec, id));
  const fresh = freshIds.sort((a, b) => rank(a) - rank(b));

  for (const id of fresh) {
    const region = regionOf(spec, id);
    const at = (ref: string | undefined, direction: Direction) =>
      ref ? { referencePanel: ref, direction } : undefined;
    const position =
      region === 'side'
        ? (at(last('side'), 'below') ?? at(first('main'), 'left') ?? at(first('bottom'), 'left'))
        : region === 'main'
          ? (at(last('main'), 'within') ??
            at(first('bottom'), 'above') ??
            at(first('side'), 'right'))
          : (at(last('bottom'), 'within') ??
            at(first('main'), 'below') ??
            at(first('side'), 'right'));
    add.push({ id, title: titleOf(spec, id), ...(position ? { position } : {}) });
    placed.push({ id, region });
  }

  const retitle = kept.map((id) => ({ id, title: titleOf(spec, id) }));
  return { remove, add, retitle };
}
