import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../src/chat/model.ts';
import { forgetOldScreens } from '../src/chat/engine.ts';
import { TOOLS } from '../src/chat/tools.ts';
import {
  buildInputCommand,
  describeInput,
  findText,
  InputError,
  parseScreenText,
} from '../src/computer/desktop-input.ts';

describe('a bot operating its desktop', () => {
  it('turns actions into xdotool on the desktop display', () => {
    expect(buildInputCommand({ action: 'click', x: 20, y: 32 })).toBe(
      'DISPLAY=:99 xdotool mousemove 20 32 click 1',
    );
    expect(buildInputCommand({ action: 'right_click', x: 1, y: 2 })).toContain('click 3');
    expect(buildInputCommand({ action: 'key', keys: 'ctrl+s' })).toBe(
      'DISPLAY=:99 xdotool key --clearmodifiers -- ctrl+s',
    );
    expect(
      buildInputCommand({ action: 'scroll', x: 5, y: 5, direction: 'up', amount: 2 }),
    ).toContain('click --repeat 2 --delay 40 4');
  });

  it('drags in steps, since an instant jump is ignored by some programs', () => {
    const cmd = buildInputCommand({ action: 'drag', x: 100, y: 100, x2: 300, y2: 200 });
    expect(cmd).toContain('mousedown 1');
    expect(cmd.match(/mousemove/g)?.length).toBeGreaterThan(10);
    expect(cmd.trim().endsWith('mouseup 1')).toBe(true);
  });

  it('cannot be talked into running something else', () => {
    const typed = buildInputCommand({ action: 'type', text: `x'; rm -rf / #` });
    expect(typed).toContain(`-- 'x'"'"'; rm -rf / #'`);
    for (const keys of ['ctrl+s; rm -rf /', '$(reboot)', '`reboot`', 'a|b', 'a&b']) {
      expect(() => buildInputCommand({ action: 'key', keys })).toThrow(InputError);
    }
    expect(() => buildInputCommand({ action: 'click', x: '1; reboot', y: 2 })).toThrow(InputError);
    expect(() => buildInputCommand({ action: 'click', x: -1, y: 2 })).toThrow(InputError);
    expect(() => buildInputCommand({ action: 'click', x: 99999, y: 2 })).toThrow(InputError);
    expect(() => buildInputCommand({ action: 'shell' })).toThrow(InputError);
    expect(() => buildInputCommand({ action: 'type' })).toThrow(InputError);
  });

  it('reads the text on the screen into phrases with the centre of each', () => {
    const head =
      'level~page_num~block_num~par_num~line_num~word_num~left~top~width~height~conf~text';
    const word = (block: number, l: number, left: number, w: number, text: string, conf = 90) =>
      `5~1~${block}~1~${l}~1~${left * 3}~${770 * 3}~${w * 3}~${20 * 3}~${conf}~${text}`;
    const tsv = [
      head,
      '4~1~1~1~1~0~0~0~100~100~-1~',
      word(1, 1, 910, 26, 'Run'),
      word(1, 1, 942, 26, 'DRC'),
      word(1, 1, 700, 40, 'Close'),
      word(2, 1, 400, 40, '|||', 90),
      word(3, 1, 500, 40, 'noise', 10),
    ].join('\n');
    const found = parseScreenText(tsv);
    expect(found).toEqual([
      { text: 'Run DRC', x: 939, y: 780 },
      { text: 'Close', x: 720, y: 780 },
    ]);
    expect(findText(found, 'run drc')).toEqual({ text: 'Run DRC', x: 939, y: 780 });
    expect(findText(found, 'DRC')?.x).toBe(939);
    expect(findText(found, 'Inspect')).toBeUndefined();
    expect(findText(found, '  ')).toBeUndefined();
  });

  it('says in words what it does, for the person watching', () => {
    expect(describeInput({ action: 'click_text', text: 'Run DRC' })).toBe('Clicks “Run DRC”');
    expect(describeInput({ action: 'key', keys: 'ctrl+s' })).toBe('Presses ctrl+s');
    expect(describeInput({ action: 'click', x: 1, y: 2 })).toBe('Clicks at 1, 2');
  });

  it('offers the tools to the model', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['computer_screen', 'computer_input', 'recheck_board']),
    );
  });

  it('keeps only the newest screen picture in the conversation', () => {
    const picture = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: 'AAAA' },
    };
    const convo: AgentMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: [{ type: 'text', text: 'Windows: KiCad' }, picture],
          },
          { type: 'tool_result', tool_use_id: 'b', content: 'plain' },
        ],
      },
    ];
    forgetOldScreens(convo);
    const results = convo[1]!.content as { content: unknown }[];
    expect(JSON.stringify(convo)).not.toContain('AAAA');
    expect(results[0]!.content).toContain('Windows: KiCad');
    expect(results[1]!.content).toBe('plain');
  });
});
