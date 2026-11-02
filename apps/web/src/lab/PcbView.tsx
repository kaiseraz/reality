import type { ChatCard } from '@reality/schemas';
import { Icon } from '../ui/Icon.tsx';

type LabCard = Extract<ChatCard, { kind: 'lab' }>;
type Row = Record<string, unknown>;

const FILES: [string, string][] = [
  ['board.kicad_pcb', 'KiCad board'],
  ['copper_top.gtl', 'Gerber top'],
  ['copper_bottom.gbl', 'Gerber bottom'],
  ['outline.gko', 'Gerber outline'],
  ['drill.drl', 'Drill'],
];

/** What the check found on a board. The board itself is built and seen in KiCad, on the bot's screen. */
export function PcbView({ card, rows }: { card: LabCard; rows: Row[] }) {
  const s = card.summary;
  const edges = rows.filter((r) => r.kind === 'edge');
  const W = Math.max(1, ...edges.map((r) => Number(r.x2)));
  const H = Math.max(1, ...edges.map((r) => Number(r.y2)));
  const unrouted = (s.unrouted as string[] | undefined) ?? [];
  const pourNets = (s.pour_nets as string[] | undefined) ?? [];
  // The lab's own copper files have no plane in them; KiCad's in the project folder do.
  const files = (card.files ?? []).filter(
    (f) =>
      FILES.some(([name]) => name === f.name) && (!pourNets.length || f.name === 'board.kicad_pcb'),
  );

  return (
    <>
      <dl className="lab-facts">
        {[
          ['Board', `${W} × ${H} mm`],
          ['Parts / nets', `${String(s.parts)} / ${String(s.nets)}`],
          ['Nets routed', `${String(s.nets_routed)} of ${String(s.nets)}`],
          ['Track length', `${Number(s.track_length_mm).toFixed(1)} mm`],
          ['Vias', String(s.vias)],
          ['Design-rule violations', String(s.drc_violations)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {pourNets.length > 0 && (
        <p className="muted small">
          {pourNets.join(', ')} joins through a copper plane: KiCad fills it on the bot's computer
          and its own rule check judges it. Fabrication files with the plane are in the project
          folder.
        </p>
      )}
      {unrouted.length > 0 && (
        <p className="bad small">
          Not routed: {unrouted.join(', ')}.{' '}
          {s.hand_edited
            ? 'The saved file leaves this open: connect it again in KiCad and check once more.'
            : 'Try a larger board, more spacing or fewer layers of constraints.'}
        </p>
      )}
      {files.length > 0 && (
        <div className="pcb-files">
          {FILES.map(([name, label]) => {
            const f = files.find((x) => x.name === name);
            return f ? (
              <a key={name} className="btn-ghost small" href={`/api/files/${f.id}?download=1`}>
                <Icon name="file" size={13} /> {label}
              </a>
            ) : null;
          })}
        </div>
      )}
    </>
  );
}
