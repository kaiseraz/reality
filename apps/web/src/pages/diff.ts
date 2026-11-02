export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
}

const MAX_CELLS = 4_000_000;

/**
 * Line diff between two versions (longest common subsequence). Very large pages fall back
 * to "everything removed, everything added" instead of freezing the browser.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Common head and tail first: most edits touch a small part of a long page.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ kind: 'same' as const, text }));
  const tail = a.slice(endA).map((text) => ({ kind: 'same' as const, text }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > MAX_CELLS) {
    return [
      ...head,
      ...x.map((text) => ({ kind: 'del' as const, text })),
      ...y.map((text) => ({ kind: 'add' as const, text })),
      ...tail,
    ];
  }
  // lcs at (i, j): length of the common subsequence of x[i..] and y[j..]
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      mid.push({ kind: 'same', text: x[i] ?? '' });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) mid.push({ kind: 'del', text: x[i++] ?? '' });
    else mid.push({ kind: 'add', text: y[j++] ?? '' });
  }
  while (i < x.length) mid.push({ kind: 'del', text: x[i++] ?? '' });
  while (j < y.length) mid.push({ kind: 'add', text: y[j++] ?? '' });
  return [...head, ...mid, ...tail];
}
