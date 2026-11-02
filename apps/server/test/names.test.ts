import { describe, expect, it } from 'vitest';
import { uniqueName } from '../src/team/team.ts';

describe('specialist names', () => {
  it('keeps a free name as it is', () => {
    expect(uniqueName('Ada', ['Reality', 'Rosa'])).toBe('Ada');
  });

  it('never numbers a taken name: it picks a fresh first name from the pool', () => {
    const taken = ['Reality', 'Rosa', 'Eddie'];
    const name = uniqueName('Rosa', taken);
    expect(name).not.toBe('Rosa');
    expect(name).not.toMatch(/\d/);
    expect(taken.map((t) => t.toLowerCase())).not.toContain(name.toLowerCase());
  });
});
