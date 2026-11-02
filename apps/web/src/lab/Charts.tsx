/**
 * Plain SVG charts for lab results: lines (spectra, energy curves) and bars (probabilities,
 * histograms). Theme-aware through CSS variables; sized by their container.
 */

const W = 560;

function ticks(min: number, max: number, n = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [min];
  const raw = (max - min) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step)
    out.push(+v.toFixed(10));
  return out;
}

const fmt = (v: number) =>
  Math.abs(v) >= 1e6 || (Math.abs(v) < 0.01 && v !== 0)
    ? v.toPrecision(3)
    : Math.abs(v) >= 1000
      ? String(Math.round(v))
      : String(+v.toFixed(3));

export interface Series {
  key: string;
  label: string;
  color: string;
}

export function LineChart({
  rows,
  x,
  series,
  xLabel,
  yLabel,
  height = 220,
  yMin,
  yMax,
  marks = [],
}: {
  rows: Record<string, number>[];
  x: string;
  series: Series[];
  xLabel: string;
  yLabel: string;
  height?: number;
  yMin?: number;
  yMax?: number;
  /** Vertical markers, e.g. a resonance or the experimental value. */
  marks?: { x: number; label: string; color?: string }[];
}) {
  const pad = { l: 46, r: 12, t: 12, b: 34 };
  const xs = rows.map((r) => r[x] ?? 0);
  const ys = rows.flatMap((r) => series.map((s) => r[s.key] ?? 0));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = yMin ?? Math.min(...ys);
  const y1 = yMax ?? Math.max(...ys);
  const sx = (v: number) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const sy = (v: number) => height - pad.b - ((v - y0) / (y1 - y0 || 1)) * (height - pad.t - pad.b);
  // Thin long series to at most ~800 points per line for drawing.
  const stride = Math.max(1, Math.floor(rows.length / 800));
  return (
    <svg
      className="lab-chart"
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={`${yLabel} over ${xLabel}`}
    >
      {ticks(y0, y1).map((t) => (
        <g key={`y${t}`}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} className="grid" />
          <text x={pad.l - 6} y={sy(t) + 4} textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {ticks(x0, x1, 6).map((t) => (
        <text key={`x${t}`} x={sx(t)} y={height - pad.b + 16} textAnchor="middle">
          {fmt(t)}
        </text>
      ))}
      <text x={(W + pad.l) / 2} y={height - 4} textAnchor="middle" className="axis-label">
        {xLabel}
      </text>
      <text
        x={12}
        y={height / 2}
        textAnchor="middle"
        className="axis-label"
        transform={`rotate(-90 12 ${height / 2})`}
      >
        {yLabel}
      </text>
      {marks.map((m) => (
        <g key={m.label}>
          <line
            x1={sx(m.x)}
            x2={sx(m.x)}
            y1={pad.t}
            y2={height - pad.b}
            stroke={m.color ?? 'currentColor'}
            strokeDasharray="4 3"
            opacity={0.7}
          />
          <text
            x={sx(m.x) + 4}
            y={pad.t + 10}
            className="mark-label"
            fill={m.color ?? 'currentColor'}
          >
            {m.label}
          </text>
        </g>
      ))}
      {series.map((s) => (
        <polyline
          key={s.key}
          fill="none"
          stroke={s.color}
          strokeWidth={1.8}
          points={rows
            .filter((_, i) => i % stride === 0 || i === rows.length - 1)
            .map((r) => `${sx(r[x] ?? 0).toFixed(1)},${sy(r[s.key] ?? 0).toFixed(1)}`)
            .join(' ')}
        />
      ))}
      {series.length > 1 &&
        series.map((s, i) => (
          <g key={`l${s.key}`} transform={`translate(${W - pad.r - 90}, ${pad.t + 4 + i * 16})`}>
            <rect width={10} height={3} y={5} fill={s.color} />
            <text x={14} y={10}>
              {s.label}
            </text>
          </g>
        ))}
    </svg>
  );
}

export function BarChart({
  items,
  height = 200,
  color = '#6e7bf2',
  yLabel,
  max,
}: {
  items: { label: string; value: number }[];
  height?: number;
  color?: string;
  yLabel: string;
  max?: number;
}) {
  const pad = { l: 40, r: 8, t: 10, b: 40 };
  const top = max ?? Math.max(...items.map((i) => i.value), 1e-9);
  const bw = (W - pad.l - pad.r) / Math.max(1, items.length);
  const sy = (v: number) => height - pad.b - (v / top) * (height - pad.t - pad.b);
  return (
    <svg className="lab-chart" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={yLabel}>
      {ticks(0, top, 4).map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} className="grid" />
          <text x={pad.l - 6} y={sy(t) + 4} textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {items.map((it, i) => (
        <g key={it.label}>
          <rect
            x={pad.l + i * bw + bw * 0.15}
            width={bw * 0.7}
            y={sy(it.value)}
            height={Math.max(0, height - pad.b - sy(it.value))}
            rx={3}
            fill={color}
          >
            <title>
              {it.label}: {fmt(it.value)}
            </title>
          </rect>
          {items.length <= 24 && (
            <text
              x={pad.l + i * bw + bw / 2}
              y={height - pad.b + 14}
              textAnchor="middle"
              className={items.length > 12 ? 'small-tick' : ''}
            >
              {it.label}
            </text>
          )}
        </g>
      ))}
      <text
        x={12}
        y={height / 2}
        textAnchor="middle"
        className="axis-label"
        transform={`rotate(-90 12 ${height / 2})`}
      >
        {yLabel}
      </text>
    </svg>
  );
}

/** Values into a histogram with equal-width bins. */
export function histogram(values: number[], bins = 16): { label: string; value: number }[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const w = (hi - lo) / bins || 1;
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor((v - lo) / w));
    counts[i] = (counts[i] ?? 0) + 1;
  }
  return counts.map((c, i) => ({ label: fmt(lo + (i + 0.5) * w), value: c }));
}
