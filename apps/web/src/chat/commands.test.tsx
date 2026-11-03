import { describe, expect, it } from 'vitest';
import { buildTree } from './FileTree.tsx';
import { matchingCommands, parseCommand } from './commands.tsx';

describe('commands in a message box', () => {
  it('reads a command and what follows, and leaves ordinary messages alone', () => {
    expect(parseCommand('/mission Find the best lipase')).toEqual({
      name: 'mission',
      rest: 'Find the best lipase',
    });
    expect(parseCommand('/routine every Monday at 8')).toEqual({
      name: 'routine',
      rest: 'every Monday at 8',
    });
    expect(parseCommand('/nope x')).toBeNull();
    expect(parseCommand('what is /mission?')).toBeNull();
  });

  it('offers the commands that fit while the name is typed', () => {
    expect(matchingCommands('/').map((c) => c.name)).toEqual(['mission', 'routine']);
    expect(matchingCommands('/ro').map((c) => c.name)).toEqual(['routine']);
    expect(matchingCommands('/mission x')).toEqual([]);
  });
});

describe('the project files as a tree', () => {
  it('nests folders, folders first and by name', () => {
    const tree = buildTree([
      { path: 'results/pcb_design/board.kicad_pcb' },
      { path: 'notes.md' },
      { path: 'results/pcb_design/gerber/board.drl' },
      { path: 'results/turbofan/assembly.step' },
    ]);
    expect(tree.map((n) => n.name)).toEqual(['results', 'notes.md']);
    const results = tree[0];
    expect(results?.children.map((n) => n.name)).toEqual(['pcb_design', 'turbofan']);
    expect(results?.children[0]?.children.map((n) => n.name)).toEqual([
      'gerber',
      'board.kicad_pcb',
    ]);
  });
});
