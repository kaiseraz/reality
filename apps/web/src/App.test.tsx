import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('warns visibly when the fake planner is active', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === '/api/health'
          ? Response.json({
              status: 'ok',
              configured: { database: true, llm: false },
              planner: 'fake',
            })
          : Response.json([]),
      ),
    );
    render(<App />);
    expect((await screen.findByRole('status')).textContent).toMatch(/fake planner/i);
  });

  it('reports an unreachable server instead of faking status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toContain('connection refused');
  });
});

describe('task composer', () => {
  it('asks for the folder with the first message, shows a failed submission and keeps the draft', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const folders = {
      path: 'C:\\proj',
      parent: null,
      dirs: [],
      roots: [{ name: 'C:\\', path: 'C:\\' }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/api/folders') return Response.json(folders);
        if (init?.method === 'POST') return new Response('{}', { status: 502 });
        return String(input) === '/api/health'
          ? Response.json({
              status: 'ok',
              configured: { database: true, llm: true },
              planner: 'anthropic',
            })
          : Response.json([]);
      }),
    );
    render(<App />);
    const box = screen.getByLabelText(/what do you want/i);
    fireEvent.change(box, { target: { value: 'Analyse my data' } });
    // Enter opens the folder explorer first; nothing is sent until a folder is chosen.
    fireEvent.click(screen.getByRole('button', { name: 'Send to your lead' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use this folder' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not send/i);
    expect((box as HTMLTextAreaElement).value).toBe('Analyse my data');
  });
});
