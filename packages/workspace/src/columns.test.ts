import { describe, expect, it } from 'vitest';
import {
  chooseGroupColumn,
  chooseValueColumn,
  inferFrequency,
  isCodeLike,
  isIdLike,
  isTimePart,
  mentions,
} from './columns.ts';
import type { Column } from './templates.ts';

// Shapes taken from a real public daily-rental dataset (731 rows).
const bike: Column[] = [
  { name: 'instant', type: 'number', distinct: 731, integer: true, min: 1, max: 731 },
  { name: 'dteday', type: 'date', distinct: 731, minDate: '2011-01-01', maxDate: '2012-12-31' },
  { name: 'season', type: 'number', distinct: 4, integer: true, min: 1, max: 4 },
  { name: 'mnth', type: 'number', distinct: 12, integer: true, min: 1, max: 12 },
  { name: 'weathersit', type: 'number', distinct: 3, integer: true, min: 1, max: 3 },
  { name: 'temp', type: 'number', distinct: 499, integer: false, min: 0.06, max: 0.86 },
  { name: 'casual', type: 'number', distinct: 606, integer: true, min: 2, max: 3410 },
  { name: 'cnt', type: 'number', distinct: 696, integer: true, min: 22, max: 8714 },
];

describe('column roles', () => {
  it('matches whole words only', () => {
    expect(mentions('Is there a seasonal pattern?', 'season')).toBe(false);
    expect(mentions('rentals by season?', 'season')).toBe(true);
    expect(mentions('daily bike rentals (cnt)', 'cnt')).toBe(true);
    expect(mentions('Größenordnung', 'größe')).toBe(false);
    expect(mentions('Umsatz nach Größe', 'größe')).toBe(true);
  });

  it('treats calendar names as time parts, but not words that merely contain one', () => {
    const t = (name: string) => isTimePart({ name, type: 'number' });
    for (const n of ['year', 'Year', 'mnth', 'weekday', 'order_date', 'decimal date', 'hour'])
      expect(t(n)).toBe(true);
    for (const n of ['holiday', 'workingday', 'birthday_count', 'runtime', 'update'])
      expect(t(n)).toBe(false);
  });

  it('recognises running numbers and integer codes', () => {
    expect(isIdLike(bike[0]!, 731)).toBe(true);
    expect(isIdLike(bike[7]!, 731)).toBe(false);
    expect(isCodeLike(bike[4]!)).toBe(true);
    expect(isCodeLike(bike[5]!)).toBe(false);
    // Found by the eval: six integer revenues are amounts, not category codes.
    const revenue: Column = {
      name: 'revenue',
      type: 'number',
      distinct: 6,
      integer: true,
      min: 60,
      max: 340,
    };
    expect(isCodeLike(revenue)).toBe(false);
    expect(
      chooseValueColumn([{ name: 'product', type: 'string', distinct: 4 }, revenue], 6)?.name,
    ).toBe('revenue');
  });

  it('picks the measured value: named, else value-like, never an id, code or time part', () => {
    expect(chooseValueColumn(bike, 731)?.name).toBe('cnt');
    expect(chooseValueColumn(bike, 731, 'casual riders per day')?.name).toBe('casual');
    expect(chooseValueColumn(bike, 731, 'how does mnth look')?.name).toBe('cnt');
  });

  it('groups by text categories first, else by codes, preferring the one named', () => {
    expect(chooseGroupColumn(bike)?.name).toBe('season');
    expect(chooseGroupColumn(bike, 'which weathersit drives rentals')?.name).toBe('weathersit');
    const withText: Column[] = [...bike, { name: 'region', type: 'string', distinct: 3 }];
    expect(chooseGroupColumn(withText)?.name).toBe('region');
  });
});

describe('inferFrequency', () => {
  const date = (n: number, from: string, to: string): Column => ({
    name: 'd',
    type: 'date',
    distinct: n,
    minDate: from,
    maxDate: to,
  });

  it('two years of daily data: yearly cycle on complete weeks', () => {
    expect(inferFrequency(date(731, '2011-01-01', '2012-12-31'))).toMatchObject({
      label: 'daily',
      period: 52,
      resample: 'week',
    });
  });

  it('a few months of daily data: weekly cycle, no resampling', () => {
    const f = inferFrequency(date(90, '2024-01-01', '2024-03-30'));
    expect(f).toMatchObject({ label: 'daily', period: 7 });
    expect(f?.resample).toBeUndefined();
  });

  it('monthly, weekly and quarterly series get their yearly period', () => {
    expect(inferFrequency(date(823, '1957-01-23', '2025-07-25'))).toMatchObject({
      label: 'monthly',
      period: 12,
    });
    expect(inferFrequency(date(156, '2023-01-02', '2025-12-22'))).toMatchObject({
      label: 'weekly',
      period: 52,
    });
    expect(inferFrequency(date(12, '2020-01-01', '2022-10-01'))).toMatchObject({
      label: 'quarterly',
      period: 4,
    });
  });

  it('too short for two cycles: no period', () => {
    expect(inferFrequency(date(20, '2023-01-02', '2023-05-15'))?.period).toBeUndefined();
    expect(inferFrequency(date(18, '2020-01-01', '2021-06-01'))?.period).toBeUndefined();
  });

  it('not a date or a single date: unknown', () => {
    expect(inferFrequency(bike[7]!)).toBeUndefined();
    expect(inferFrequency(date(1, '2020-01-01', '2020-01-01'))).toBeUndefined();
  });
});
