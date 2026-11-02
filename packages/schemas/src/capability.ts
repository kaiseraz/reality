import { z } from 'zod';

/**
 * Capability lifecycle. Discovering a tool never implies trusting it: each step up
 * requires evidence, and state is written only by core code paths, never by agents.
 */
export const CapabilityState = z.enum([
  'discovered',
  'inspected',
  'tested',
  'enabled',
  'trusted',
  'rejected',
]);
export type CapabilityState = z.infer<typeof CapabilityState>;

const transitions: Record<CapabilityState, readonly CapabilityState[]> = {
  discovered: ['inspected', 'rejected'],
  inspected: ['tested', 'rejected'],
  tested: ['enabled', 'rejected'],
  enabled: ['trusted', 'rejected'],
  trusted: ['rejected'],
  rejected: [],
};

export function canTransition(from: CapabilityState, to: CapabilityState): boolean {
  return transitions[from].includes(to);
}

export const CapabilityKind = z.enum(['builtin', 'python-package', 'mcp-server', 'skill']);

export const CapabilityPermissions = z.object({
  network: z.enum(['none', 'install-only', 'allowlist']).default('none'),
  cpus: z.number().positive().max(8).default(1),
  memoryMb: z.number().int().positive().max(16384).default(1024),
  timeoutSec: z.number().int().positive().max(3600).default(120),
});
