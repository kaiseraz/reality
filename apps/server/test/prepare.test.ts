import { readFileSync } from 'node:fs';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { prepareCsv } from '../src/artifacts/artifact-store.ts';

const rows = (text: string) =>
  Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;

describe('upload preparation', () => {
  it('leaves a clean file alone', () => {
    expect(prepareCsv('week,revenue\n2025-01-06,10\n2025-01-13,12\n')).toBeUndefined();
  });

  it('drops comment lines, turns an all-9s marker into missing, flags -1', () => {
    const p = prepareCsv(
      [
        '# Source: somewhere',
        '# second comment',
        'when,value,sdev,ndays',
        '2020-01-01,5.5,0.3,-1',
        '2020-02-01,6.1,-9.99,20',
        '2020-03-01,7.0,0.4,21',
      ].join('\n'),
    );
    expect(p?.notes).toEqual([
      'Dropped 2 comment lines (starting with "#").',
      'Column "sdev": 1 values of -9.99 treated as missing (no-data marker; all other values are ≥ 0).',
      'Column "ndays": -1 appears 1 times while all other values are ≥ 0; it may mean "no data" but was kept as a number.',
    ]);
    const out = rows(p!.text);
    expect(out.map((r) => r.sdev)).toEqual(['0.3', '', '0.4']);
    expect(out.map((r) => r.ndays)).toEqual(['-1', '20', '21']);
  });

  it('keeps genuine negative values (no marker when other values are negative)', () => {
    expect(prepareCsv('date,temp\n2020-01-01,-9.99\n2020-01-02,-3.5\n2020-01-03,2\n')).toBe(
      undefined,
    );
  });

  it('builds a date column from year and month', () => {
    const p = prepareCsv('year,month,v\n2020,1,3\n2020,12,4\n');
    expect(p?.notes).toEqual([
      'Added column "date" from "year" and "month" (first day of each month).',
    ]);
    expect(rows(p!.text).map((r) => r.date)).toEqual(['2020-01-01', '2020-12-01']);
  });

  it('prepares the real CO2 file', () => {
    const text = readFileSync(
      new URL('../../../samples/real/co2_mm_mlo.csv', import.meta.url),
      'utf8',
    );
    const p = prepareCsv(text);
    expect(p?.notes.join(' ')).toMatch(/Dropped \d+ comment lines/);
    expect(p?.notes.join(' ')).toMatch(/"sdev": \d+ values of -9\.99 treated as missing/);
    expect(p?.notes.join(' ')).toMatch(/Added column "date"/);
    const out = rows(p!.text);
    expect(out[0]).toMatchObject({ date: '1958-03-01', year: '1958', month: '3' });
    expect(out.every((r) => r.sdev !== '-9.99')).toBe(true);
  });
});
