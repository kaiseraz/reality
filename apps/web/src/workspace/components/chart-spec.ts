import type { TopLevelSpec } from 'vega-lite';
import type { Cell } from '../../api.ts';

interface Encoding {
  field: string;
  type: string;
  aggregate?: string;
  timeUnit?: string;
  sort?: string;
}

export interface ChartProps {
  title: string;
  mark: 'line' | 'bar' | 'point';
  x: Encoding;
  y: Encoding;
  color?: { field: string };
  row?: { field: string };
}

/**
 * Translates validated, typed Chart props into a Vega-Lite spec. Props never contain raw
 * Vega-Lite, so a model can't smuggle in arbitrary specs (data URLs, expressions).
 */
export function buildVegaLiteSpec(props: ChartProps, rows: Record<string, Cell>[]): TopLevelSpec {
  const encode = (e: ChartProps['x']) => ({
    field: e.field,
    type: e.type,
    ...(e.aggregate ? { aggregate: e.aggregate } : {}),
    ...(e.timeUnit ? { timeUnit: e.timeUnit } : {}),
    ...(e.sort ? { sort: e.sort } : {}),
  });
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: 'container',
    height: 'container',
    autosize: { type: 'fit', contains: 'padding' },
    data: { values: rows },
    mark: { type: props.mark, tooltip: true, ...(props.mark === 'line' ? { point: false } : {}) },
    encoding: {
      x: encode(props.x),
      // Lines follow the data range (CO2 at 400+ would be flat from zero); bars keep zero.
      y: { ...encode(props.y), ...(props.mark === 'line' ? { scale: { zero: false } } : {}) },
      ...(props.color ? { color: { field: props.color.field, type: 'nominal' } } : {}),
      ...(props.row ? { row: { field: props.row.field, type: 'nominal', title: null } } : {}),
    },
    // Faceted rows (e.g. decomposition components) differ in scale; give each its own y.
    ...(props.row ? { resolve: { scale: { y: 'independent' } }, height: 90 } : {}),
  } as TopLevelSpec;
}
