import { describe, expect, it } from 'vitest';
import { chartFor, inferFrequency, type Column } from '@reality/workspace';
import {
  correlationCandidates,
  planForecast,
  requestedHorizonDays,
  RuleBasedPlanner,
} from '../src/planner/rule-planner.ts';

// Shapes of the real public datasets (prepared variants of samples/real).
const bike: Column[] = [
  { name: 'instant', type: 'number', distinct: 731, integer: true, min: 1, max: 731 },
  { name: 'dteday', type: 'date', distinct: 731, minDate: '2011-01-01', maxDate: '2012-12-31' },
  { name: 'season', type: 'number', distinct: 4, integer: true, min: 1, max: 4 },
  { name: 'yr', type: 'number', distinct: 2, integer: true, min: 0, max: 1 },
  { name: 'holiday', type: 'number', distinct: 2, integer: true, min: 0, max: 1 },
  { name: 'weathersit', type: 'number', distinct: 3, integer: true, min: 1, max: 3 },
  { name: 'temp', type: 'number', distinct: 499, integer: false, min: 0.06, max: 0.86 },
  { name: 'casual', type: 'number', distinct: 606, integer: true, min: 2, max: 3410 },
  { name: 'cnt', type: 'number', distinct: 686, integer: true, min: 22, max: 8714 },
];
const co2: Column[] = [
  { name: 'date', type: 'date', distinct: 823, minDate: '1958-03-01', maxDate: '2025-12-31' },
  { name: 'year', type: 'number', distinct: 69, integer: true, min: 1958, max: 2025 },
  { name: 'average', type: 'number', distinct: 799, integer: false, min: 312, max: 427 },
];

const plan = async (request: string, columns: Column[], rowCount: number, caps: string[] = []) => {
  const out = await new RuleBasedPlanner().propose({
    request,
    datasets: [{ filename: 'd.csv', rowCount, columns }],
    availableCapabilities: caps,
  });
  return out.draft as {
    workflow: { id: string; recipe?: { name: string; params: Record<string, unknown> } }[];
    risks: string[];
  };
};

describe('forecast planning', () => {
  it('reads horizons in English and German', () => {
    expect(requestedHorizonDays('forecast the next 24 months')).toBeCloseTo(730.56);
    expect(requestedHorizonDays('Prognose für die nächsten 6 Wochen')).toBe(42);
    expect(requestedHorizonDays('forecast revenue')).toBeUndefined();
  });

  it('sizes the horizon in periods and refuses when the backtest cannot fit', () => {
    const monthly = inferFrequency(co2[0]!)!;
    expect(planForecast(monthly, 823, 730.56)).toEqual({ horizon: 24, period: 12 });
    expect(planForecast(monthly, 823, undefined)).toEqual({ horizon: 12, period: 12 });
    const short = planForecast(monthly, 30, 365.25);
    expect(short).toMatchObject({ horizon: 6, period: 12 });
    expect('note' in short && short.note).toMatch(/shortened to 6/);
    const daily = inferFrequency(bike[1]!)!;
    expect(planForecast(daily, 103, 90)).toMatchObject({
      refused: expect.stringMatching(/two full cycles \(104 periods\).*only 103/),
    });
  });

  it('plans a forecast with a backtest check, sharing one capability acquisition', async () => {
    const d = await plan('Forecast the monthly CO2 average for the next 24 months', co2, 823);
    const ids = d.workflow.map((s) => s.id);
    expect(ids.filter((i) => i === 'acquire')).toHaveLength(1);
    // "monthly" only describes the data here; it is not a seasonality question.
    expect(ids).not.toContain('decompose');
    expect(d.workflow.find((s) => s.id === 'forecast')?.recipe?.params).toEqual({
      date: 'date',
      value: 'average',
      horizon: 24,
      period: 12,
    });
  });

  it('says why when no forecast is possible', async () => {
    const d = await plan('Forecast bike rentals (cnt) for the next 3 months', bike, 731);
    expect(d.workflow.map((s) => s.id)).not.toContain('forecast');
    expect(d.risks.join(' ')).toMatch(/No forecast/);
  });
});

describe('correlation planning', () => {
  it('uses measures and binary flags, never ids, calendar parts or multi-valued codes', () => {
    expect(correlationCandidates(bike, 731, 'cnt')).toEqual(['holiday', 'temp', 'casual']);
  });

  it('plans a correlation for a "factors" question and no automatic breakdown', async () => {
    const d = await plan('Which factors influence daily bike rentals (cnt)?', bike, 731);
    const ids = d.workflow.map((s) => s.id);
    expect(ids).toContain('correlate');
    expect(ids).not.toContain('breakdown');
  });

  it('still compares groups when the request names the group column', async () => {
    const d = await plan('How does weathersit influence cnt?', bike, 731);
    expect(d.workflow.map((s) => s.id)).toEqual(expect.arrayContaining(['correlate', 'breakdown']));
  });
});

describe('charts for new result shapes', () => {
  it('draws a forecast as lines per kind, not summed', () => {
    const spec = chartFor(
      [
        { name: 'date', type: 'date', distinct: 850 },
        { name: 'kind', type: 'string', distinct: 3 },
        { name: 'average', type: 'number', distinct: 840 },
        { name: 'lower', type: 'number', distinct: 24 },
        { name: 'upper', type: 'number', distinct: 24 },
      ],
      871,
    );
    expect(spec).toMatchObject({ title: 'average forecast', color: { field: 'kind' } });
    expect((spec?.y as { aggregate?: string }).aggregate).toBeUndefined();
  });

  it('draws correlations as bars per variable', () => {
    const spec = chartFor(
      [
        { name: 'variable', type: 'string', distinct: 6 },
        { name: 'pearson_r', type: 'number', distinct: 6 },
        { name: 'direction', type: 'string', distinct: 2 },
      ],
      6,
    );
    expect(spec).toMatchObject({ mark: 'bar', y: { field: 'pearson_r' } });
  });
});
