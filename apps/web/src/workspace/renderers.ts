import type { FunctionComponent } from 'react';
import { AgentActivity } from './components/AgentActivity.tsx';
import { ApprovalQueue } from './components/ApprovalQueue.tsx';
import { CapabilityCard } from './components/CapabilityCard.tsx';
import { Chart } from './components/Chart.tsx';
import { DataTable } from './components/DataTable.tsx';
import { EvidencePanel } from './components/EvidencePanel.tsx';
import { PlanView } from './components/PlanView.tsx';
import { RunLog } from './components/RunLog.tsx';
import type { RendererProps } from './context.ts';

/** One renderer per registry type; a test keeps this in lockstep with the registry. */
export const RENDERERS: Record<string, FunctionComponent<RendererProps>> = {
  PlanView,
  AgentActivity,
  ApprovalQueue,
  DataTable,
  Chart,
  RunLog,
  EvidencePanel,
  CapabilityCard,
};
