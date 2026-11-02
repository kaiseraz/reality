import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { ChatCard } from '@reality/schemas';
import { api } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';

type LabCard = Extract<ChatCard, { kind: 'lab' }>;

/** Colours per assembly group: metals for rotating parts, lighter shells for casings. */
const GROUP_COLOR: Record<string, string> = {
  fan: '#c8ccd4',
  compressor: '#9fb3c8',
  combustor: '#d68a3d',
  turbine: '#b07a4a',
  shafts: '#7d8590',
  casing: '#e4e6ea',
  nacelle: '#f4f5f7',
  exhaust: '#8a8f99',
  accessories: '#4f6d8f',
};
const color = (g: string) => GROUP_COLOR[g] ?? '#aab4c0';
const groupOf = (file: string) => file.replace(/^mesh_/, '').replace(/\.stl$/, '');

interface Part {
  name: string;
  group: string;
  valid: string;
  volume: number;
}

/**
 * A CAD assembly in the browser: one mesh per group with metallic shading, orbit with the
 * mouse, a section plane that cuts the model open like a cutaway drawing, groups to hide,
 * the parts list and the STEP download. three.js, bundled; nothing is loaded from outside.
 */
export function CadView({ card, large = false }: { card: LabCard; large?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const meshes = useRef<Map<string, THREE.Mesh>>(new Map());
  const plane = useRef(new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e9));
  const hiddenRef = useRef<string[]>([]);
  const [cut, setCut] = useState(large ? 0.5 : 0);
  const [hidden, setHidden] = useState<string[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState(0);
  const [extent, setExtent] = useState(1000);
  const files = useMemo(() => card.files ?? [], [card.files]);
  const stls = useMemo(() => files.filter((f) => f.name.endsWith('.stl')), [files]);
  const step = files.find((f) => f.name.endsWith('.step'));
  const groups = stls.map((f) => groupOf(f.name));

  // The parts list from the result table.
  useEffect(() => {
    const result = card.artifacts.find((a) => a.name === 'result.csv');
    if (!result) return;
    let live = true;
    api
      .rows(result.id, { offset: 0, limit: 10_000 })
      .then(
        (page) =>
          live &&
          setParts(
            page.rows.map((r) => ({
              name: String(r.name),
              group: String(r.group),
              valid: String(r.valid),
              volume: Number(r.volume_mm3),
            })),
          ),
      )
      .catch(() => live && setParts([]));
    return () => {
      live = false;
    };
  }, [card.artifacts]);

  // The scene: renderer, camera, light, controls; one mesh per group file.
  useEffect(() => {
    const el = host.current;
    if (!el || stls.length === 0) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 100_000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, 1.2, 1.4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.9);
    rim.position.set(-1.5, 0.3, -1);
    scene.add(rim);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    controls.autoRotate = !reduce && !large;
    controls.autoRotateSpeed = 0.6;
    const root = new THREE.Group();
    // CAD x is the engine axis; show it lying left to right.
    scene.add(root);
    const box = new THREE.Box3();
    const loader = new STLLoader();
    let disposed = false;
    let count = 0;
    for (const f of stls) {
      const g = groupOf(f.name);
      loader.load(`/api/files/${f.id}`, (geometry) => {
        if (disposed) return;
        geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({
          color: color(g),
          metalness: g === 'nacelle' || g === 'casing' ? 0.25 : 0.75,
          roughness: g === 'nacelle' ? 0.55 : 0.32,
          side: THREE.DoubleSide,
          clippingPlanes:
            g === 'nacelle' || g === 'casing' || g === 'exhaust' ? [plane.current] : [],
        });
        const mesh = new THREE.Mesh(geometry, material);
        meshes.current.set(g, mesh);
        root.add(mesh);
        box.expandByObject(mesh);
        count += 1;
        setLoaded(count);
        if (count === stls.length) {
          const center = box.getCenter(new THREE.Vector3());
          const size = box.getSize(new THREE.Vector3());
          root.position.sub(center);
          const r = Math.max(size.x, size.y, size.z);
          setExtent(Math.max(size.y, size.z) / 2);
          // Step back further in narrow panels so the whole engine fits.
          const k = 1 + 0.9 / Math.max(0.6, Math.min(2, camera.aspect));
          camera.position.set(r * 0.62 * k, r * 0.3 * k, r * 0.78 * k);
          camera.near = r / 100;
          camera.far = r * 20;
          camera.updateProjectionMatrix();
          controls.target.set(0, 0, 0);
          controls.update();
        }
      });
    }
    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    let frame = 0;
    const loop = () => {
      for (const [g, m] of meshes.current) m.visible = !hiddenRef.current.includes(g);
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    const current = meshes.current;
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      for (const m of current.values()) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      current.clear();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [stls, large]);

  // Section plane: cut the shells open from the top, by the slider.
  useEffect(() => {
    plane.current.constant = cut === 0 ? 1e9 : extent * (1 - 2 * cut);
  }, [cut, extent]);

  // The render loop reads which groups are hidden.
  useEffect(() => {
    hiddenRef.current = hidden;
  }, [hidden]);

  const s = card.summary;
  const shown = parts.filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className={`cad-view ${large ? 'large' : ''}`}>
      <div className="cad-stage" ref={host} style={{ height: large ? 360 : 240 }}>
        {loaded < stls.length && (
          <span className="cad-loading">
            Loading the model… {loaded}/{stls.length}
          </span>
        )}
      </div>
      <div className="row cad-tools">
        <label className="inline-field">
          Cutaway
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={cut}
            onChange={(e) => setCut(Number(e.target.value))}
            aria-label="Cut the casings open"
          />
        </label>
        {step && (
          <a className="button btn-primary" href={`/api/files/${step.id}?download=1`}>
            <Icon name="file" size={14} /> STEP ({(step.sizeBytes / 1e6).toFixed(1)} MB)
          </a>
        )}
      </div>
      <div className="row cad-groups">
        {groups.map((g) => (
          <label key={g} className={`chip-check ${hidden.includes(g) ? '' : 'on'}`}>
            <input
              type="checkbox"
              checked={!hidden.includes(g)}
              onChange={(e) =>
                setHidden((h) => (e.target.checked ? h.filter((x) => x !== g) : [...h, g]))
              }
            />
            <span className="swatch-dot" style={{ background: color(g) }} /> {g}{' '}
            <small className="muted">{parts.filter((p) => p.group === g).length}</small>
          </label>
        ))}
      </div>
      <dl className="lab-facts">
        {[
          ['Parts', s.part_count],
          ['Blades and vanes', s.blade_count],
          ['Invalid solids', s.invalid_parts],
          ['Length', s.length_mm, 'mm'],
          ['Diameter', s.diameter_mm, 'mm'],
          ['Triangles', s.triangles],
        ].map(([k, v, unit]) => (
          <div key={String(k)}>
            <dt>{String(k)}</dt>
            <dd>
              {typeof v === 'number' ? v.toLocaleString() : String(v ?? '')}
              {unit ? <span className="muted"> {String(unit)}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {large && (
        <details className="cad-parts">
          <summary>Parts list ({parts.length})</summary>
          <input
            type="search"
            aria-label="Search parts"
            placeholder="Search parts, e.g. HPC_S03"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Group</th>
                  <th>Volume (cm³)</th>
                  <th>Valid</th>
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 200).map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td>{p.group}</td>
                    <td>{(p.volume / 1000).toFixed(1)}</td>
                    <td className={p.valid === 'yes' ? 'good' : 'bad'}>{p.valid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length > 200 && (
            <small className="muted">First 200 of {shown.length}; refine the search.</small>
          )}
        </details>
      )}
    </div>
  );
}
