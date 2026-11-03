import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { lineDiff } from './diff.ts';
import { Markdown } from './markdown.tsx';

describe('page versions', () => {
  it('diffs lines: kept, removed, added', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
    expect(lineDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
  });

  it('renders Markdown as elements, never as HTML', () => {
    const { container } = render(
      <Markdown
        text={
          '## Result\n\nTrees **cool** streets [S1](https://example.org).\n\n- claim [S1]\n  > quoted words\n\n<img src=x onerror=alert(1)>'
        }
      />,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Result');
    expect(container.querySelector('strong')?.textContent).toBe('cool');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.org');
    expect(container.querySelector('li blockquote')?.textContent).toBe('quoted words');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('keeps underscores inside words', () => {
    const { container } = render(
      <Markdown text={'Set META_MODEL_API_KEY, then _this_ is emphasis.'} />,
    );
    expect(container.textContent).toContain('META_MODEL_API_KEY');
    expect(container.querySelectorAll('em')).toHaveLength(1);
    expect(container.querySelector('em')?.textContent).toBe('this');
  });

  it('renders a table as a table, with a pipe in code kept in its cell', () => {
    const { container } = render(
      <Markdown
        text={[
          'Intro',
          '',
          '| # | Name | Note |',
          '|---|:--|---|',
          '| 1 | Ada | `a|b` |',
          '| 2 | Ben |  |',
          '',
          'After',
        ].join('\n')}
      />,
    );
    expect(container.querySelectorAll('th')).toHaveLength(3);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('tbody td:nth-child(3) code')?.textContent).toBe('a|b');
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });
});
