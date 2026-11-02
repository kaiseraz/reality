import { createContext, useContext } from 'react';
import type { ComponentInstance, TaskEvent, WorkspaceSpec } from '@reality/schemas';
import type { TaskDetail } from '../api.ts';

export interface WorkspaceData {
  spec: WorkspaceSpec;
  task: TaskDetail | null;
  events: TaskEvent[];
  /** Sends a registered action through the server's ActionIntent router. */
  sendAction: (instanceId: string, actionId: string, payload: unknown) => Promise<void>;
}

export const WorkspaceContext = createContext<WorkspaceData | null>(null);

export function useWorkspace(): WorkspaceData {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace outside WorkspaceContext');
  return ctx;
}

export class UndeclaredActionError extends Error {}

/** Props every component renderer receives. */
export interface RendererProps {
  instanceId: string;
  instance: ComponentInstance;
  /**
   * Emits one of the instance's declared actions. Anything else throws: a renderer
   * cannot invent an action the spec and registry don't grant it.
   */
  emit: (actionId: string, payload?: unknown) => Promise<void>;
}

export function makeEmit(
  instanceId: string,
  instance: ComponentInstance,
  send: WorkspaceData['sendAction'],
): RendererProps['emit'] {
  return (actionId, payload = {}) => {
    if (!instance.actions.includes(actionId)) {
      return Promise.reject(
        new UndeclaredActionError(`${instance.type} "${instanceId}" may not emit "${actionId}"`),
      );
    }
    return send(instanceId, actionId, payload);
  };
}
