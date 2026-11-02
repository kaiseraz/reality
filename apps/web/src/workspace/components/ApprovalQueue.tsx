import { useState } from 'react';
import { useWorkspace, type RendererProps } from '../context.ts';
import { CapabilityProposalView, type Proposal } from './CapabilityProposal.tsx';

export function ApprovalQueue({ emit }: RendererProps) {
  const { task } = useWorkspace();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!task) return <p className="muted pad">Loading…</p>;
  const pending = task.status === 'awaiting_approval' && task.pendingApproval !== null;
  if (!pending) return <p className="muted pad">No pending approvals.</p>;

  const spec = task.state?.spec;
  const decide = async (actionId: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      await emit(actionId, note.trim() ? { note: note.trim() } : {});
      setNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const request = task.pendingApproval as { kind?: string; proposal?: Proposal };
  const isCapability = request.kind === 'capability-approval' && request.proposal;

  return (
    <div className="pad approval">
      {isCapability && request.proposal ? (
        <CapabilityProposalView proposal={request.proposal} />
      ) : (
        <p>
          <strong>Plan approval</strong>: nothing runs until you decide.
        </p>
      )}
      {!isCapability && spec && (
        <p>
          {spec.workflow.length} steps, {spec.acceptanceCriteria.length} acceptance criteria
          {spec.missingCapabilities.length > 0 &&
            `, ${spec.missingCapabilities.length} missing capabilities`}
          . See the Plan panel for details.
        </p>
      )}
      <label>
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </label>
      <div className="row">
        <button data-action="approve" disabled={busy} onClick={() => void decide('approve')}>
          {isCapability ? 'Approve installation' : 'Approve plan'}
        </button>
        <button data-action="deny" disabled={busy} onClick={() => void decide('deny')}>
          Deny
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
