import { useState } from 'react';
import { api, type Mission } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime } from '../ui/status.ts';
import { money, STATUS, VERDICT } from './MissionsPage.tsx';

const shown = (v: unknown) =>
  typeof v === 'number'
    ? String(+v.toPrecision(6))
    : v === null || v === undefined
      ? ''
      : String(v);

const MARK: Record<
  Mission['criteria'][number]['status'],
  { icon: 'check' | 'x' | 'info'; tone: string }
> = {
  met: { icon: 'check', tone: 'good' },
  missed: { icon: 'x', tone: 'bad' },
  open: { icon: 'info', tone: 'muted' },
  not_checkable: { icon: 'info', tone: 'muted' },
};

/** A mission at a glance: verdict so far, budget, criteria with their evidence, journal. */
export function MissionPanel({ mission, onChange }: { mission: Mission; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const running = mission.status === 'running';
  const verdict =
    VERDICT[running ? mission.liveVerdict : (mission.verdict ?? '')] ?? VERDICT.no_criteria;
  const start = new Date(mission.startedAt).getTime();
  const end = new Date(mission.endsAt).getTime();
  // eslint-disable-next-line react-hooks/purity -- a progress bar for the time budget
  const now = running ? Date.now() : new Date(mission.finishedAt ?? mission.endsAt).getTime();
  const timeShare = Math.max(0, Math.min(1, (now - start) / (end - start || 1)));

  return (
    <div className="mission-panel">
      <div className={`mission-verdict ${verdict?.tone ?? ''}`}>
        <Icon name="target" size={16} />
        <span>
          <strong>
            {running
              ? `Running · so far ${verdict?.label}`
              : `${STATUS[mission.status]} · ${verdict?.label}`}
          </strong>
          <small>{mission.goal}</small>
        </span>
      </div>
      <div className="mission-budget">
        <div>
          <span className="muted small">Time</span>
          <div className="meter">
            <span style={{ width: `${(timeShare * 100).toFixed(0)}%` }} />
          </div>
          <small className="muted">
            {running ? `ends ${relativeTime(mission.endsAt)}` : `${mission.hours} h budget`}
          </small>
        </div>
        <div>
          <span className="muted small">Tasks</span>
          <div className="meter">
            <span
              style={{
                width: `${Math.min(100, (mission.tasksUsed / mission.maxTasks) * 100).toFixed(0)}%`,
              }}
            />
          </div>
          <small className="muted">
            {mission.tasksUsed} of {mission.maxTasks}
          </small>
        </div>
        <div>
          <span className="muted small">Model use</span>
          <div className="meter">
            <span
              style={{
                width: `${mission.costBudget ? Math.min(100, (mission.spent / mission.costBudget) * 100).toFixed(0) : 0}%`,
              }}
            />
          </div>
          <small className="muted">
            {money(mission.spent, mission.costUnit)}
            {mission.costBudget !== null
              ? ` of ${money(mission.costBudget, mission.costUnit)}`
              : ', no limit'}
          </small>
        </div>
        <div>
          <span className="muted small">Rounds</span>
          <div className="meter">
            <span
              style={{
                width: `${Math.min(100, (mission.rounds / mission.maxRounds) * 100).toFixed(0)}%`,
              }}
            />
          </div>
          <small className="muted">
            {mission.rounds} of {mission.maxRounds}
          </small>
        </div>
      </div>
      {mission.openDecisions.length > 0 && (
        <>
          <div className="board-h">Waiting for you</div>
          <ul className="plain mission-criteria">
            {mission.openDecisions.map((d) => (
              <li key={d} className="muted">
                <Icon name="info" size={13} />
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="board-h">Criteria (checked by code)</div>
      {mission.criteria.length === 0 ? (
        <p className="muted small">No measurable criteria were set.</p>
      ) : (
        <ul className="plain mission-criteria">
          {mission.criteria.map((c) => (
            <li key={c.id} className={MARK[c.status].tone}>
              <Icon name={MARK[c.status].icon} size={13} />
              <span>
                <strong>{c.field}</strong> {c.expected}
                <br />
                <small className="muted">
                  {c.actual === null || c.actual === undefined
                    ? 'no checked evidence yet'
                    : `actual ${shown(c.actual)} (${c.evidenceId ?? '?'})`}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}
      {mission.reportPageId && (
        <a className="btn-primary mission-report" href={`#/page/${mission.reportPageId}`}>
          <Icon name="file" size={14} /> Open the report
        </a>
      )}
      <div className="board-h">Journal</div>
      <ol className="plain mission-journal">
        {[...mission.journal]
          .reverse()
          .slice(0, 14)
          .map((j, i) => (
            <li key={i}>
              <small className="muted">{relativeTime(j.at)}</small> {j.text}
            </li>
          ))}
      </ol>
      {running && (
        <button
          className="btn-ghost small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api
              .stopMission(mission.id)
              .then(onChange)
              .finally(() => setBusy(false));
          }}
        >
          <Icon name="x" size={13} /> Stop the mission (writes an interim report)
        </button>
      )}
    </div>
  );
}
