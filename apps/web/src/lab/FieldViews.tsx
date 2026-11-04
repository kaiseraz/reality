import { useEffect, useRef } from 'react';

/** A perceptual colour ramp (dark blue → teal → yellow), the same in light and dark mode. */
const STOPS: [number, number, number][] = [
  [48, 18, 59],
  [40, 98, 199],
  [27, 177, 177],
  [140, 216, 74],
  [249, 231, 33],
];
export function ramp(t: number): string {
  const u = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(u));
  const f = u - i;
  const a = STOPS[i] as [number, number, number];
  const b = STOPS[i + 1] as [number, number, number];
  const c = a.map((v, k) => Math.round(v + ((b[k] as number) - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const fmt = (v: number) =>
  Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0)
    ? v.toExponential(2)
    : String(+v.toPrecision(3));

function Legend({ min, max, label }: { min: number; max: number; label: string }) {
  return (
    <div className="field-legend">
      <span>{fmt(min)}</span>
      <span
        className="field-ramp"
        style={{
          background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map(ramp).join(', ')})`,
        }}
      />
      <span>{fmt(max)}</span>
      <span className="muted small">{label}</span>
    </div>
  );
}

export interface Tri {
  pts: [number, number][];
  v: number;
}

/** A finite-element field: every element coloured by its value, drawn to scale. */
export function TriField({
  tris,
  label,
  height = 260,
}: {
  tris: Tri[];
  label: string;
  height?: number;
}) {
  if (tris.length === 0) return null;
  const xs = tris.flatMap((t) => t.pts.map((p) => p[0]));
  const ys = tris.flatMap((t) => t.pts.map((p) => p[1]));
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const vs = tris.map((t) => t.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const w = x1 - x0 || 1;
  const h = y1 - y0 || 1;
  return (
    <figure className="field">
      <svg
        viewBox={`${x0 - w * 0.02} ${-y1 - h * 0.02} ${w * 1.04} ${h * 1.04}`}
        style={{ maxHeight: height }}
        role="img"
        aria-label={`${label}: ${fmt(lo)} to ${fmt(hi)}`}
      >
        {tris.map((t, i) => (
          <polygon
            key={i}
            points={t.pts.map(([x, y]) => `${x},${-y}`).join(' ')}
            fill={ramp((t.v - lo) / (hi - lo || 1))}
            stroke={ramp((t.v - lo) / (hi - lo || 1))}
            strokeWidth={w / 2000}
          />
        ))}
      </svg>
      <Legend min={lo} max={hi} label={label} />
    </figure>
  );
}

export interface Cell {
  x: number;
  y: number;
  v: number;
  u?: number;
  w?: number;
}

/**
 * A field on a regular grid (temperature, speed, potential), drawn on a canvas; optional arrows
 * show a flow's direction. `stretch` exaggerates a thin dimension and says so.
 */
export function GridField({
  cells,
  label,
  arrows = false,
  stretch = 1,
  height = 300,
}: {
  cells: Cell[];
  label: string;
  arrows?: boolean;
  stretch?: number;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const xs = [...new Set(cells.map((c) => c.x))].sort((a, b) => a - b);
  const ys = [...new Set(cells.map((c) => c.y))].sort((a, b) => a - b);
  const vs = cells.map((c) => c.v);
  const lo = vs.length ? Math.min(...vs) : 0;
  const hi = vs.length ? Math.max(...vs) : 1;
  const spanX = (xs.at(-1) ?? 1) - (xs[0] ?? 0) || 1;
  const spanY = ((ys.at(-1) ?? 1) - (ys[0] ?? 0) || 1) * stretch;
  const ratio = spanY / spanX;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || xs.length < 2 || ys.length < 2) return;
    const W = 900;
    const H = Math.max(60, Math.round(W * ratio));
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d');
    if (!g) return;
    const ix = new Map(xs.map((x, i) => [x, i]));
    const iy = new Map(ys.map((y, i) => [y, i]));
    const cw = W / xs.length;
    const ch = H / ys.length;
    for (const c of cells) {
      const i = ix.get(c.x) ?? 0;
      const j = iy.get(c.y) ?? 0;
      g.fillStyle = ramp((c.v - lo) / (hi - lo || 1));
      g.fillRect(i * cw, H - (j + 1) * ch, cw + 0.6, ch + 0.6);
    }
    if (arrows) {
      const every = Math.max(1, Math.round(xs.length / 22));
      const top = Math.max(...cells.map((c) => Math.hypot(c.u ?? 0, c.w ?? 0))) || 1;
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 1.2;
      for (const c of cells) {
        const i = ix.get(c.x) ?? 0;
        const j = iy.get(c.y) ?? 0;
        if (i % every || j % every || i === 0 || j === 0) continue;
        const sp = Math.hypot(c.u ?? 0, c.w ?? 0);
        if (sp < 1e-9) continue;
        const len = (cw * every * 0.9 * Math.sqrt(sp / top)) / sp;
        const px = (i + 0.5) * cw;
        const py = H - (j + 0.5) * ch;
        const qx = px + (c.u ?? 0) * len;
        const qy = py - (c.w ?? 0) * len;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(qx, qy);
        g.stroke();
        const a = Math.atan2(qy - py, qx - px);
        g.beginPath();
        g.moveTo(qx, qy);
        g.lineTo(qx - 4 * Math.cos(a - 0.45), qy - 4 * Math.sin(a - 0.45));
        g.lineTo(qx - 4 * Math.cos(a + 0.45), qy - 4 * Math.sin(a + 0.45));
        g.fill();
      }
    }
  }, [cells, xs, ys, lo, hi, ratio, arrows]);
  if (cells.length === 0) return null;
  return (
    <figure className="field">
      <canvas
        ref={ref}
        className="field-canvas"
        style={{ maxHeight: height, aspectRatio: `${1 / ratio}` }}
        aria-label={`${label}: ${fmt(lo)} to ${fmt(hi)}`}
        role="img"
      />
      <Legend
        min={lo}
        max={hi}
        label={stretch !== 1 ? `${label} · thickness drawn ×${stretch}` : label}
      />
    </figure>
  );
}
