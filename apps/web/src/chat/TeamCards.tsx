import { useEffect, useState } from 'react';
import type { ChatCard, ContractCheck } from '@reality/schemas';
import { BotFigure } from '../bots/BotFigure.tsx';
import { ROLE } from '../bots/BotAvatar.tsx';
import { Icon } from '../ui/Icon.tsx';

type TeamCard = Extract<ChatCard, { kind: 'team' }>;
type ContractCard = Extract<ChatCard, { kind: 'contract' }>;

function checkText(c: ContractCheck): string {
  switch (c.type) {
    case 'command':
      return `\`${c.command}\` succeeds on its computer`;
    case 'file':
      return `${c.path} exists${c.contains ? ` with "${c.contains}"` : ''}`;
    case 'task':
      return 'a Reality task passes independent verification';
    case 'review':
      return 'you accept it';
  }
}

const budget = (min: number) => (min < 60 ? `${min} min` : `${Math.round((min / 60) * 10) / 10} h`);

/** The lead's proposal: who it wants to hire, for what, and how each job is checked. */
export function TeamProposal({
  card,
  busy,
  onAnswer,
}: {
  card: TeamCard;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  return (
    <div className={`chat-card team ${card.status}`}>
      <div className="chat-card-head">
        <Icon name="user" size={15} />
        <strong>
          {card.status === 'open'
            ? 'Proposed team'
            : card.status === 'hired'
              ? 'Team hired'
              : 'Team not hired'}
        </strong>
        <span className="muted small">{card.goal}</span>
      </div>
      <ul className="plain team-members">
        {card.members.map((m) => (
          <li key={m.name}>
            <BotFigure name={m.name} size={44} title={m.name} />
            <div className="team-member-body">
              <div>
                <strong>{m.name}</strong>{' '}
                <span className="muted small">
                  {ROLE[m.role].label}
                  {m.reuseBotId ? ' · hired again' : ' · new'} · {budget(m.budgetMinutes)}
                </span>
              </div>
              <p className="small">{m.mission}</p>
              <dl className="team-terms small">
                <dt>Delivers</dt>
                <dd>{m.deliverable}</dd>
                <dt>Done when</dt>
                <dd>{checkText(m.check)}</dd>
                {m.domains.length > 0 && (
                  <>
                    <dt>Web</dt>
                    <dd>{m.domains.join(', ')}</dd>
                  </>
                )}
                {m.setup && (
                  <>
                    <dt>Setup</dt>
                    <dd>
                      <code>{m.setup}</code>
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </li>
        ))}
      </ul>
      {card.status === 'open' && (
        <div className="row">
          <button className="btn-primary" disabled={busy} onClick={() => onAnswer('Hire')}>
            Hire team
          </button>
          <button disabled={busy} onClick={() => onAnswer('Decline')}>
            Not now
          </button>
          <span className="muted small">
            Each job is checked by code; nobody declares their own work done.
          </span>
        </div>
      )}
    </div>
  );
}

/** Minutes or hours until the deadline, refreshed every half minute. */
function TimeLeft({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const left = Math.round((Date.parse(deadline) - now) / 60_000);
  return (
    <span className="muted small">
      {left > 0 ? `${left < 60 ? `${left} min` : `${Math.round(left / 60)} h`} left` : 'due'}
    </span>
  );
}

const STATUS: Record<ContractCard['status'], [string, string]> = {
  active: ['Working', 'info'],
  review: ['For your review', 'warn'],
  met: ['Met', 'ok'],
  failed: ['Failed', 'bad'],
  released: ['Released', 'neutral'],
};

/** A specialist's contract and what code decided about it. */
export function ContractView({
  card,
  busy,
  onAnswer,
}: {
  card: ContractCard;
  busy: boolean;
  onAnswer: (answer: string) => void;
}) {
  const [label, tone] = STATUS[card.status];
  const head = (
    <>
      <Icon name="file" size={15} />
      <strong>Contract · {card.botName}</strong>
      <span className={`pill tone-${tone}`}>{label}</span>
      {card.status === 'active' && <TimeLeft deadline={card.deadline} />}
    </>
  );
  const body = (
    <>
      <p className="small">{card.deliverable}</p>
      <p className="muted small">Done when {card.check}.</p>
      {card.evidence && <p className={`small contract-evidence tone-${tone}`}>{card.evidence}</p>}
    </>
  );
  // A contract that waits for the person's verdict stays open; every other one is a
  // slim, expandable row, so the chat reads as conversation, not as a card wall.
  if (card.status === 'review') {
    return (
      <div className={`chat-card contract ${card.status}`}>
        <div className="chat-card-head">{head}</div>
        {body}
        <div className="row">
          <button className="btn-primary" disabled={busy} onClick={() => onAnswer('Accept')}>
            Accept
          </button>
          <button disabled={busy} onClick={() => onAnswer('Reject')}>
            Reject
          </button>
        </div>
      </div>
    );
  }
  return (
    <details className={`chat-card contract slim ${card.status}`}>
      <summary className="chat-card-head">{head}</summary>
      {body}
    </details>
  );
}
