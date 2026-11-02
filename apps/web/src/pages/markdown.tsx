import type { ReactNode } from 'react';

/**
 * A small Markdown renderer for pages: headings, lists, quotes, code, rules, bold, italic,
 * inline code and http(s) links. It builds React elements (never HTML strings), so text
 * written by bots or copied from sources cannot inject markup.
 */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Underscores count as emphasis only at word edges, so names like META_MODEL_API_KEY stay intact.
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|(?<![\p{L}\p{N}_])_[^_\s][^_]*_(?![\p{L}\p{N}_]))|(\[[^\]]+\]\(https?:\/\/[^\s)]+\))|(@[A-Za-z][\w-]*)/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{t.slice(1, -1)}</em>);
    else if (m[5])
      out.push(
        <span className="mention" key={k}>
          {t}
        </span>,
      );
    else {
      const label = t.slice(1, t.indexOf(']('));
      const href = t.slice(t.indexOf('](') + 2, -1);
      out.push(
        <a key={k} href={href} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `b${n++}`;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('```')) body.push(lines[i++] ?? '');
      i++;
      blocks.push(<pre key={key()}>{body.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]?.length ?? 1;
      const k = key();
      const content = inline(h[2] ?? '', k);
      blocks.push(
        level === 1 ? (
          <h1 key={k}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={k}>{content}</h2>
        ) : level === 3 ? (
          <h3 key={k}>{content}</h3>
        ) : (
          <h4 key={k}>{content}</h4>
        ),
      );
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: ReactNode[][] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+|^\s{2,}\S/.test(lines[i] ?? '')) {
        const l = lines[i] ?? '';
        const k = key();
        if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
          items.push(inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''), k));
        } else {
          // An indented line belongs to the item above (e.g. "  > quote").
          const q = l.trim().replace(/^>\s?/, '');
          items.at(-1)?.push(<blockquote key={k}>{inline(q, k)}</blockquote>);
        }
        i++;
      }
      const k = key();
      const lis = items.map((c, j) => <li key={`${k}-${j}`}>{c}</li>);
      blocks.push(ordered ? <ol key={k}>{lis}</ol> : <ul key={k}>{lis}</ul>);
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('>')) {
        body.push((lines[i++] ?? '').replace(/^>\s?/, ''));
      }
      const k = key();
      blocks.push(<blockquote key={k}>{inline(body.join(' '), k)}</blockquote>);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() &&
      !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s+)/.test(lines[i] ?? '')
    ) {
      para.push(lines[i++] ?? '');
    }
    if (para.length === 0) {
      // A line no block rule accepted: show it as text instead of looping forever.
      para.push(lines[i++] ?? '');
    }
    const k = key();
    blocks.push(<p key={k}>{inline(para.join(' '), k)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}
