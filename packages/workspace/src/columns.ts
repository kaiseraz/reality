import type { Column } from './templates.ts';

/**
 * Column roles, decided from the data's real schema and statistics. Shared by the
 * rule-based planner and the workspace templates so they never disagree.
 */

/** Calendar parts and time encodings: never a measured value. */
// Whole names or name parts only: "order_date" and "weekday" are time parts, "holiday" is not.
const TIME_PART =
  /^(yr|mnth|hr|dow|weekday|instant|dteday)$|(^|[_\s.-])(years?|months?|weeks?|days?|dates?|time|hours?|quarters?)($|[_\s.-])/i;
const ID_NAME = /(^|[_\s])(id|idx|index|row|no|nr|instant)$|^id[_\s]/i;
const VALUE_HINT =
  /(cnt|count|revenue|sales|amount|value|total|price|umsatz|profit|cost|qty|quantity|average|avg|mean|rentals|visits|orders|ppm|concentration|temperature)/i;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The request names the column as a whole word (so "seasonal" does not mention "season"). */
export function mentions(request: string, name: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(name)}($|[^\\p{L}\\p{N}_])`, 'iu').test(request);
}

export function isTimePart(c: Column): boolean {
  return TIME_PART.test(c.name);
}

/** A running number: integer, one distinct value per row, named like an id or a 1…n sequence. */
export function isIdLike(c: Column, rowCount: number): boolean {
  if (c.type !== 'number' || !c.integer || c.distinct !== rowCount) return false;
  const sequence = c.min !== undefined && c.max !== undefined && c.max - c.min === rowCount - 1;
  return ID_NAME.test(c.name) || sequence;
}

/**
 * Integer codes standing for categories (e.g. weather 1–3, season 1–4): few distinct
 * values in a compact range. A few amounts such as 60, 95, 340 are not codes.
 */
export function isCodeLike(c: Column): boolean {
  if (c.type !== 'number' || c.integer !== true) return false;
  const n = c.distinct ?? 0;
  if (n < 2 || n > 12 || c.min === undefined || c.max === undefined) return false;
  return c.max - c.min + 1 <= 2 * n;
}

/** The measured value to analyse: named in the request, else a value-like name, else the first measure. */
export function chooseValueColumn(
  columns: readonly Column[],
  rowCount: number,
  request = '',
): Column | undefined {
  const measures = columns.filter(
    (c) => c.type === 'number' && !isIdLike(c, rowCount) && !isCodeLike(c) && !isTimePart(c),
  );
  return (
    measures.find((c) => mentions(request, c.name)) ??
    measures.find((c) => VALUE_HINT.test(c.name)) ??
    measures[0]
  );
}

/** A grouping column: text categories or integer codes (2–50 / 2–12 values). */
export function chooseGroupColumn(columns: readonly Column[], request = ''): Column | undefined {
  const text = columns.filter(
    (c) => c.type === 'string' && (c.distinct ?? 0) >= 2 && (c.distinct ?? 0) <= 50,
  );
  const codes = columns.filter((c) => isCodeLike(c) && !isTimePart(c));
  const all = [...text, ...codes];
  return all.find((c) => mentions(request, c.name)) ?? text[0] ?? codes[0];
}

export interface Frequency {
  label: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'irregular';
  spacingDays: number;
  spanDays: number;
  /** Seasonal period in observations, when the series is long enough for two full cycles. */
  period?: number;
  periodLabel?: string;
  /** Aggregate before decomposing (long daily series → complete calendar weeks). */
  resample?: 'week';
}

/** Frequency of a date column from its span and number of distinct dates. */
export function inferFrequency(date: Column): Frequency | undefined {
  if (
    date.type !== 'date' ||
    !date.minDate ||
    !date.maxDate ||
    !date.distinct ||
    date.distinct < 2
  ) {
    return undefined;
  }
  const spanDays = (Date.parse(date.maxDate) - Date.parse(date.minDate)) / 86_400_000;
  const n = date.distinct;
  const spacingDays = spanDays / (n - 1);
  const f = (label: Frequency['label'], period?: number, periodLabel?: string): Frequency => ({
    label,
    spacingDays,
    spanDays,
    ...(period && periodLabel ? { period, periodLabel } : {}),
  });
  if (spacingDays >= 0.8 && spacingDays <= 1.5) {
    // A yearly cycle of daily data is decomposed on weekly totals: 52 instead of 365
    // seasonal values to estimate, and fast enough for the permutation test.
    if (spanDays >= 730) {
      return {
        ...f('daily', 52, 'yearly cycle; daily data summed to complete calendar weeks'),
        resample: 'week',
      };
    }
    if (n >= 28) return f('daily', 7, 'weekly cycle of daily data');
    return f('daily');
  }
  if (spacingDays >= 6 && spacingDays <= 8)
    return n >= 104 ? f('weekly', 52, 'yearly cycle of weekly data') : f('weekly');
  if (spacingDays >= 27 && spacingDays <= 32)
    return n >= 24 ? f('monthly', 12, 'yearly cycle of monthly data') : f('monthly');
  if (spacingDays >= 85 && spacingDays <= 95)
    return n >= 8 ? f('quarterly', 4, 'yearly cycle of quarterly data') : f('quarterly');
  if (spacingDays >= 360 && spacingDays <= 370) return f('yearly');
  return f('irregular');
}
