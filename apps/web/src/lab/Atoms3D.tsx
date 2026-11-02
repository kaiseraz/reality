import { useEffect, useRef } from 'react';

/**
 * A small 3D viewer for molecules and crystal cells: shaded spheres and bonds on a canvas,
 * drag to rotate, slow auto-rotation when left alone. No WebGL, no third-party code.
 */

export interface Atom {
  el: string;
  x: number;
  y: number;
  z: number;
}

const COLOR: Record<string, string> = {
  H: '#f4f4f4',
  C: '#5a5f66',
  N: '#3f6df2',
  O: '#ef3b3b',
  F: '#8fe35a',
  Cl: '#2fd14d',
  Br: '#a63a2b',
  I: '#8b1fa0',
  S: '#f2d22e',
  P: '#ff8a1f',
  B: '#ffb3a0',
  Si: '#d8b88a',
  Na: '#a46cf2',
  K: '#8a4fd6',
  Cu: '#d0803c',
  Ag: '#c9ccd2',
  Ni: '#6fc26f',
  Al: '#c9b3b3',
  Pb: '#6a6d78',
  Ca: '#7ad94a',
  Sr: '#46c95a',
};
const RADIUS: Record<string, number> = {
  H: 0.3,
  C: 0.42,
  N: 0.4,
  O: 0.39,
  S: 0.5,
  P: 0.5,
  Cl: 0.5,
  Br: 0.55,
  I: 0.6,
};

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) =>
    Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f))));
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}

export function Atoms3D({
  atoms,
  bonds = [],
  edges = [],
  height = 260,
  atomScale = 1,
  label,
}: {
  atoms: Atom[];
  bonds?: { a: number; b: number; order: number }[];
  /** Extra line segments, e.g. the edges of a unit cell. */
  edges?: [Atom, Atom][];
  height?: number;
  atomScale?: number;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({
    yaw: 0.6,
    pitch: -0.35,
    drag: null as null | { x: number; y: number },
    idle: 0,
  });

  useEffect(() => {
    const c = canvas.current;
    if (!c || atoms.length === 0) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Centre and size the scene.
    const cx = atoms.reduce((s, a) => s + a.x, 0) / atoms.length;
    const cy = atoms.reduce((s, a) => s + a.y, 0) / atoms.length;
    const cz = atoms.reduce((s, a) => s + a.z, 0) / atoms.length;
    const pts = atoms.map((a) => ({ ...a, x: a.x - cx, y: a.y - cy, z: a.z - cz }));
    const ext = Math.max(1, ...pts.map((p) => Math.hypot(p.x, p.y, p.z)));
    const shift = (p: Atom): Atom => ({ ...p, x: p.x - cx, y: p.y - cy, z: p.z - cz });
    const edgePts: [Atom, Atom][] = edges.map(([p, q]) => [shift(p), shift(q)]);
    let frame = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
      if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const v = view.current;
      if (!v.drag && !reduce) v.yaw += 0.006;
      const cyw = Math.cos(v.yaw);
      const syw = Math.sin(v.yaw);
      const cp = Math.cos(v.pitch);
      const sp = Math.sin(v.pitch);
      const scale = (Math.min(w, h) * 0.42) / ext;
      const project = (p: { x: number; y: number; z: number }) => {
        const x1 = p.x * cyw + p.z * syw;
        const z1 = -p.x * syw + p.z * cyw;
        const y2 = p.y * cp - z1 * sp;
        const z2 = p.y * sp + z1 * cp;
        const persp = 1 / (1 + z2 / (ext * 6));
        return { sx: w / 2 + x1 * scale * persp, sy: h / 2 - y2 * scale * persp, z: z2, persp };
      };
      const proj = pts.map(project);
      const muted = getComputedStyle(c).getPropertyValue('--muted') || '#888';
      // Cell edges behind everything, thin.
      ctx.strokeStyle = muted;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      for (const [p, q] of edgePts) {
        const a = project(p);
        const b = project(q);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Bonds and atoms, far to near.
      type Item = { z: number; draw: () => void };
      const items: Item[] = [];
      for (const b of bonds) {
        const p = proj[b.a];
        const q = proj[b.b];
        if (!p || !q) continue;
        items.push({
          z: (p.z + q.z) / 2 + 0.001,
          draw: () => {
            const width = Math.max(1.5, 0.16 * scale * ((p.persp + q.persp) / 2));
            const dx = q.sx - p.sx;
            const dy = q.sy - p.sy;
            const len = Math.hypot(dx, dy) || 1;
            const ox = (-dy / len) * width * 0.9;
            const oy = (dx / len) * width * 0.9;
            const offsets = b.order >= 2.5 ? [-1, 0, 1] : b.order >= 1.5 ? [-0.5, 0.5] : [0];
            for (const o of offsets) {
              const grad = ctx.createLinearGradient(p.sx, p.sy, q.sx, q.sy);
              grad.addColorStop(0, shade(COLOR[atoms[b.a]?.el ?? 'C'] ?? '#999', -0.15));
              grad.addColorStop(1, shade(COLOR[atoms[b.b]?.el ?? 'C'] ?? '#999', -0.15));
              ctx.strokeStyle = grad;
              ctx.lineWidth = offsets.length > 1 ? width * 0.6 : width;
              ctx.lineCap = 'round';
              ctx.beginPath();
              ctx.moveTo(p.sx + ox * o, p.sy + oy * o);
              ctx.lineTo(q.sx + ox * o, q.sy + oy * o);
              ctx.stroke();
            }
          },
        });
      }
      proj.forEach((p, i) => {
        const el = atoms[i]?.el ?? 'C';
        const r = Math.max(2, (RADIUS[el] ?? 0.5) * atomScale * scale * p.persp);
        const base = COLOR[el] ?? '#b0b0b0';
        items.push({
          z: p.z,
          draw: () => {
            const g = ctx.createRadialGradient(
              p.sx - r * 0.35,
              p.sy - r * 0.4,
              r * 0.1,
              p.sx,
              p.sy,
              r,
            );
            g.addColorStop(0, shade(base, 0.65));
            g.addColorStop(0.45, base);
            g.addColorStop(1, shade(base, -0.55));
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
            ctx.fill();
          },
        });
      });
      items.sort((a, b) => b.z - a.z).forEach((it) => it.draw());
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [atoms, bonds, edges, atomScale]);

  return (
    <canvas
      ref={canvas}
      className="atoms3d"
      style={{ height }}
      role="img"
      aria-label={label}
      onPointerDown={(e) => {
        view.current.drag = { x: e.clientX, y: e.clientY };
        (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const v = view.current;
        if (!v.drag) return;
        v.yaw += (e.clientX - v.drag.x) * 0.01;
        v.pitch = Math.max(-1.4, Math.min(1.4, v.pitch + (e.clientY - v.drag.y) * 0.01));
        v.drag = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={() => {
        view.current.drag = null;
      }}
    />
  );
}
