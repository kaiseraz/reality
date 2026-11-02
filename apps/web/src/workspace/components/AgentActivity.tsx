import { useWorkspace, type RendererProps } from '../context.ts';

export function AgentActivity({ instance }: RendererProps) {
  const { events } = useWorkspace();
  const max = typeof instance.props.maxItems === 'number' ? instance.props.maxItems : 200;
  const shown = events.slice(-max).reverse(); // newest first

  if (shown.length === 0) return <p className="muted pad">No activity yet.</p>;
  return (
    <ol className="events pad" aria-label="activity log">
      {shown.map((e) => (
        <li key={e.id}>
          <time>{new Date(e.createdAt).toLocaleTimeString()}</time> <code>{e.type}</code>{' '}
          <small>{e.actor}</small>
        </li>
      ))}
    </ol>
  );
}
