import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskEvent } from '@reality/schemas';
import type { TaskDetail } from './api.ts';
import { App } from './App.tsx';
import { relativeTime } from './ui/status.ts';
import { formatCell } from './workspace/components/DataTable.tsx';
import { progressOf } from './workspace/TaskHeader.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const task = (status: string, extra: Partial<TaskDetail> = {}) =>
  ({
    id: 't',
    request: 'r',
    status,
    createdAt: '2025-08-12T00:00:00.000Z',
    updatedAt: '2025-08-12T00:00:00.000Z',
    state: { spec: null },
    pendingApproval: null,
    ...extra,
  }) as TaskDetail;
const checkEvent = { type: 'check.completed' } as TaskEvent;

describe('task progress', () => {
  it('follows the lifecycle', () => {
    expect(progressOf(task('planning'), [])).toEqual({ current: 'plan', state: 'active' });
    expect(
      progressOf(task('awaiting_approval', { pendingApproval: { kind: 'plan-approval' } }), []),
    ).toEqual({ current: 'approve', state: 'wait' });
    expect(
      progressOf(
        task('awaiting_approval', { pendingApproval: { kind: 'capability-approval' } }),
        [],
      ),
    ).toEqual({ current: 'run', state: 'wait' });
    expect(progressOf(task('running'), [checkEvent])).toEqual({
      current: 'verify',
      state: 'active',
    });
    expect(progressOf(task('completed'), [])).toEqual({ current: 'done', state: 'done' });
    expect(progressOf(task('rejected'), [])).toEqual({ current: 'approve', state: 'failed' });
    expect(progressOf(task('failed'), [])).toEqual({ current: 'plan', state: 'failed' });
  });
});

describe('display formatting', () => {
  it('rounds for reading, never hides tiny values', () => {
    expect(formatCell(0.685749203005)).toBe('0.6857');
    expect(formatCell(4876.78617711)).toBe('4876.79');
    expect(formatCell(180332.88999999998)).toBe('180332.89');
    expect(formatCell(0.0000123)).toBe('0.0000123');
    expect(formatCell(42)).toBe('42');
    expect(formatCell('North')).toBe('North');
  });

  it('describes recent times relatively', () => {
    const now = Date.parse('2025-08-12T12:00:00Z');
    expect(relativeTime('2025-08-12T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2025-08-12T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2025-08-12T09:00:00Z', now)).toBe('3 h ago');
  });
});

describe('start screen', () => {
  it('picks the folder with the first message, sends a question to a fresh lead chat, and a /mission starts the team on its goal', async () => {
    const calls: string[] = [];
    const leadId = '22222222-2222-4222-8222-222222222222';
    const chatId = '33333333-3333-4333-8333-333333333333';
    const missionChat = '44444444-4444-4444-8444-444444444444';
    const posts = (all: string[]) => all.filter((c) => c.startsWith('POST'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url === '/api/health')
          return Response.json({ status: 'ok', planner: 'rules', sandboxProblem: null });
        if (url === '/api/folders')
          return Response.json({ path: 'C:\\proj', parent: null, dirs: [], roots: [] });
        if (url === '/api/samples')
          return Response.json([
            { id: 'bike', title: 'Bike sharing', description: 'd', question: 'Q?', source: 's' },
          ]);
        if (url === '/api/bots')
          return Response.json([
            {
              id: leadId,
              name: 'Reality',
              role: 'lead',
              color: '#888888',
              persona: '',
              figure: 'orb',
              createdAt: '2024-10-24T00:00:00.000Z',
              status: 'idle',
              current: null,
              done: 0,
              isMain: true,
              resting: false,
              record: { met: 0, failed: 0 },
            },
          ]);
        if (url === '/api/missions' && init?.method === 'POST') {
          missionBody = JSON.parse(String(init.body)) as { goal: string; botIds: string[] };
          return Response.json({ id: 'm1', chatId: missionChat });
        }
        if (init?.method === 'POST') return Response.json({ id: chatId });
        return Response.json([]);
      }),
    );
    let missionBody: { goal: string; botIds: string[] } | null = null;
    render(<App />);
    const box = await screen.findByPlaceholderText('Ask Reality anything…');
    // The start page has the lead, not example boxes.
    expect(screen.queryByText('Bike sharing')).toBeNull();
    expect((await screen.findAllByRole('img', { name: /^Reality/ })).length).toBeGreaterThan(0);
    expect(document.querySelector('.home-hero .bot-figure')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'How strong is the seasonal cycle?' } });
    // Enter opens the folder explorer first, like in Claude Code; nothing runs yet.
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(posts(calls)).toEqual([]);
    // The chosen folder goes on the fresh chat, then the message goes out — never in an older chat.
    fireEvent.click(await screen.findByRole('button', { name: 'Use this folder' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${chatId}`));
    expect(posts(calls)).toEqual(['POST /api/chats', `POST /api/chats/${chatId}/messages`]);
    expect(calls).toContain(`PUT /api/chats/${chatId}/folder`);
    expect(calls.some((c) => c.includes(`/api/bots/${leadId}/chat`))).toBe(false);

    window.location.hash = '';
    const again = await screen.findByPlaceholderText('Ask Reality anything…');
    fireEvent.change(again, { target: { value: '/mi' } });
    expect(await screen.findByText('Work on it overnight')).toBeTruthy();
    fireEvent.change(again, { target: { value: '/mission Find the best lipase for biodiesel' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    // The mission asks for its folder too, before the team works.
    fireEvent.click(await screen.findByRole('button', { name: 'Use this folder' }));
    await waitFor(() => expect(window.location.hash).toBe(`#/chat/${missionChat}`));
    expect(missionBody).toMatchObject({
      goal: 'Find the best lipase for biodiesel',
      botIds: [leadId],
    });
    expect(calls).toContain(`PUT /api/chats/${missionChat}/folder`);
  });

  it('lists a direct chat with an employee that is not the lead', async () => {
    const leadId = '11111111-1111-4111-8111-111111111111';
    const eddieId = '22222222-2222-4222-8222-222222222222';
    const bot = (id: string, name: string, role: string, isMain: boolean) => ({
      id,
      name,
      role,
      color: '#888888',
      persona: '',
      figure: 'orb',
      createdAt: '2024-10-24T00:00:00.000Z',
      status: 'idle',
      current: null,
      done: 0,
      isMain,
      resting: false,
      record: { met: 0, failed: 0 },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/health')
          return Response.json({ status: 'ok', planner: 'rules', sandboxProblem: null });
        if (url === '/api/bots')
          return Response.json([
            bot(leadId, 'Reality', 'lead', true),
            bot(eddieId, 'Eddie', 'engineer', false),
          ]);
        if (url === '/api/chats')
          return Response.json([
            {
              id: '44444444-4444-4444-8444-444444444444',
              kind: 'dm',
              title: 'Design a jet engine',
              botIds: [eddieId],
              updatedAt: new Date().toISOString(),
              last: 'Model visible on your desktop',
            },
          ]);
        return Response.json([]);
      }),
    );
    render(<App />);
    expect(await screen.findByText('Design a jet engine')).toBeDefined();
    expect(await screen.findByText('Eddie · direct')).toBeDefined();
  });

  it('opens the command palette with Ctrl+K', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([])),
    );
    render(<App />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(await screen.findByRole('dialog', { name: 'Command palette' })).toBeDefined();
    expect(screen.getByText('Open capability library')).toBeDefined();
  });
});

describe('inbox', () => {
  it('shows why each decision waits, with a quick approval only for plans', async () => {
    const { InboxPage } = await import('./projects/InboxPage.tsx');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          {
            taskId: 't1',
            request: 'Which factors influence rentals?',
            since: new Date().toISOString(),
            kind: 'plan-approval',
            summary: 'Plan with 4 steps and 3 checks',
            project: { id: 'p1', goal: 'Bike review' },
            reason: 'Step "free" needs AI-written code, which a person must approve.',
          },
          {
            taskId: 't2',
            request: 'Is there seasonality?',
            since: new Date().toISOString(),
            kind: 'capability-approval',
            summary: 'Install statsmodels 0.15.0',
            project: null,
            reason: 'Installing a capability always needs a person.',
          },
        ]),
      ),
    );
    render(<InboxPage openTask={() => undefined} openProject={() => undefined} />);
    expect(await screen.findByText(/needs AI-written code/)).toBeDefined();
    expect(screen.getByText(/always needs a person/)).toBeDefined();
    // One quick approval (the plan); the installation must be reviewed in its task.
    expect(screen.getAllByRole('button', { name: /Approve plan/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(2);
  });
});

describe('conversation view', () => {
  it('shows the question, the plan with a decision, and verified results', async () => {
    const { Thread, resultViews } = await import('./workspace/Thread.tsx');
    const task = {
      id: 't',
      request: 'Which regions drive revenue?',
      status: 'awaiting_approval',
      createdAt: '2025-08-13T00:00:00.000Z',
      updatedAt: '2025-08-13T00:00:00.000Z',
      pendingApproval: { kind: 'plan-approval' },
      state: {
        spec: {
          goal: 'g',
          constraints: [],
          requiredOutputs: [],
          resources: [],
          risks: ['Grouping by "region".'],
          acceptanceCriteria: [],
          workflow: [
            {
              id: 'profile',
              description: 'Profile sales.csv',
              agent: 'analysis-agent',
              dependsOn: [],
              status: 'pending',
            },
            {
              id: 'breakdown',
              description: 'Total revenue per region',
              agent: 'analysis-agent',
              dependsOn: [],
              status: 'pending',
            },
          ],
          missingCapabilities: [],
          candidateWorkspaces: [],
        },
        stepResults: [],
        verification: [],
      },
    } as unknown as TaskDetail;
    const spec = { id: 'w', taskId: 't', version: 1, components: {}, regions: {} } as never;
    const events = [
      {
        id: 1,
        taskId: 't',
        type: 'artifact.added',
        actor: 'user',
        payload: { filename: 'sales.csv' },
        createdAt: '',
      },
    ] as TaskEvent[];
    render(
      <Thread
        ctx={{ spec, task, events, sendAction: async () => undefined }}
        onFollowUp={async () => undefined}
        openWorkspace={() => undefined}
      />,
    );
    expect(screen.getByText('Which regions drive revenue?')).toBeDefined();
    expect(screen.getByText('sales.csv')).toBeDefined();
    expect(screen.getByText('Here is my plan:')).toBeDefined();
    expect(screen.getByText('Total revenue per region')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Approve and run' })).toBeDefined();

    // Charts: derived results first; the input chart only when there is no result chart.
    const comp = (artifact: string, type: string) => ({
      type,
      props: { title: type },
      bindings: { rows: { kind: 'artifact', artifact: { id: artifact } } },
    });
    const views = resultViews(
      {
        components: {
          a: comp('in', 'Chart'),
          b: comp('out', 'Chart'),
          c: comp('out', 'DataTable'),
        },
      } as never,
      new Set(['out']),
    );
    expect(views).toEqual({ charts: ['b'], tables: ['c'] });
    expect(
      resultViews({ components: { a: comp('in', 'Chart') } } as never, new Set()).charts,
    ).toEqual(['a']);
  });
});
