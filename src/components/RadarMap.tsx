import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { NeoObject } from "../lib/types";
import { radarLayout, timeToAngle, ldToRadius, RING_LDS, LD_MAX, type RadarLayout } from "../lib/layout";
import { moonDistanceLd } from "../lib/astro";
import { fmtDateShort } from "../lib/format";

interface Props {
  objects: NeoObject[];
  windowMin: number;
  windowMax: number;
  scrubberMs: number;
  selectedId: string | null;
  onSelect: (o: NeoObject) => void;
}

const AMBER = 0xf0b32a;
const AMBER_DIM = 0x7a5a14;
const BLUE = 0x5f7bff;
const RED = 0xff3b2f;

function circlePoints(r: number, seg = 128): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0));
  }
  return pts;
}

export function RadarMap({ objects, windowMin, windowMax, scrubberMs, selectedId, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null);

  const three = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    dynamic: THREE.Group;
    sweep: THREE.Group;
    moon: THREE.Mesh;
    raf: number;
  } | null>(null);
  const scrubRef = useRef(scrubberMs);
  scrubRef.current = scrubberMs;
  const winRef = useRef({ min: windowMin, max: windowMax });
  winRef.current = { min: windowMin, max: windowMax };
  const maxRRef = useRef(100);
  const dotsRef = useRef<Array<{mesh: THREE.Mesh;baseR: number;frac: number;haz: boolean;}>>([]);

  // Track container size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      setSize({ w: Math.round(cr.width), h: Math.round(cr.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Init renderer once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, -100, 100);
    camera.position.z = 10;
    const dynamic = new THREE.Group();
    scene.add(dynamic);

    // Sweep group (rotates with time).
    const sweep = new THREE.Group();
    scene.add(sweep);
    const moon = new THREE.Mesh(
      new THREE.CircleGeometry(5, 24),
      new THREE.MeshBasicMaterial({ color: 0xcfd6e6 })
    );
    scene.add(moon);

    three.current = { renderer, scene, camera, dynamic, sweep, moon, raf: 0 };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    const loop = () => {
      const t = three.current;
      if (!t) return;
      const now = performance.now();
      const elapsed = (now - start) / 1000;
      const a = timeToAngle(scrubRef.current, winRef.current.min, winRef.current.max);
      t.sweep.rotation.z = -a;
      // Moon rides the sweep line at its real geocentric distance.
      const moonLd = moonDistanceLd(new Date(scrubRef.current));
      const rMoon = ldToRadius(moonLd, maxRRef.current);
      t.moon.position.set(rMoon * Math.cos(a), -rMoon * Math.sin(a), 1);
      // Pulse dots near the sweep angle.
      const pulse = reduce ? 1 : 0.85 + 0.15 * Math.sin(elapsed * 3);
      const sweepFrac = (a + Math.PI / 2) / (2 * Math.PI);
      for (const d of dotsRef.current) {
        let near = Math.abs(d.frac - sweepFrac);
        near = Math.min(near, 1 - near);
        const closeBoost = near < 0.02 ? 1.8 : 1;
        d.mesh.scale.setScalar((d.haz ? pulse : 1) * closeBoost);
      }
      t.renderer.render(t.scene, t.camera);
      t.raf = requestAnimationFrame(loop);
    };
    three.current.raf = requestAnimationFrame(loop);

    return () => {
      if (three.current) cancelAnimationFrame(three.current.raf);
      renderer.dispose();
      three.current = null;
    };
  }, []);

  // Resize renderer + camera.
  useEffect(() => {
    const t = three.current;
    if (!t || size.w === 0 || size.h === 0) return;
    t.renderer.setSize(size.w, size.h, false);
    t.camera.left = -size.w / 2;
    t.camera.right = size.w / 2;
    t.camera.top = size.h / 2;
    t.camera.bottom = -size.h / 2;
    t.camera.updateProjectionMatrix();
  }, [size]);

  // Rebuild static geometry when data or size changes.
  useEffect(() => {
    const t = three.current;
    if (!t || size.w === 0 || size.h === 0) return;
    const layout = radarLayout(objects, size.w, size.h, windowMin, windowMax);
    maxRRef.current = layout.maxR;

    // clear groups
    const clear = (g: THREE.Group) => {
      while (g.children.length) {
        const c = g.children.pop() as any;
        c.geometry?.dispose?.();
        if (Array.isArray(c.material)) c.material.forEach((m: any) => m.dispose?.());else
        c.material?.dispose?.();
      }
    };
    clear(t.dynamic);
    clear(t.sweep);
    dotsRef.current = [];

    const W2 = (x: number, y: number) => new THREE.Vector3(x - size.w / 2, size.h / 2 - y, 0);

    // Range rings.
    for (const ring of layout.rings) {
      const isMoon = ring.ld === 1;
      const mat = new THREE.LineBasicMaterial({ color: isMoon ? AMBER : AMBER_DIM, transparent: true, opacity: isMoon ? 0.85 : 0.4 });
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(circlePoints(ring.r)), mat);
      t.dynamic.add(line);
    }
    // Outer dial + ticks.
    {
      const outer = layout.maxR + 14;
      const tickMat = new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.55 });
      const segs: THREE.Vector3[] = [];
      for (let i = 0; i < 120; i++) {
        const a = i / 120 * Math.PI * 2 - Math.PI / 2;
        const long = i % 10 === 0;
        const r0 = outer;
        const r1 = outer + (long ? 12 : 5);
        segs.push(new THREE.Vector3(Math.cos(a) * r0, -Math.sin(a) * r0, 0));
        segs.push(new THREE.Vector3(Math.cos(a) * r1, -Math.sin(a) * r1, 0));
      }
      t.dynamic.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), tickMat));
      t.dynamic.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(circlePoints(outer)), new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.7 })));
      // crosshair axes
      const cross: THREE.Vector3[] = [
      new THREE.Vector3(-layout.maxR, 0, 0), new THREE.Vector3(layout.maxR, 0, 0),
      new THREE.Vector3(0, -layout.maxR, 0), new THREE.Vector3(0, layout.maxR, 0)];

      t.dynamic.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(cross), new THREE.LineBasicMaterial({ color: AMBER_DIM, transparent: true, opacity: 0.35 })));
    }

    // Connector lines (object -> Earth), like the converging trajectory lines.
    {
      const segs: THREE.Vector3[] = [];
      for (const p of layout.points) {
        const w = W2(p.x, p.y);
        segs.push(new THREE.Vector3(0, 0, 0));
        segs.push(w);
      }
      t.dynamic.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(segs),
        new THREE.LineBasicMaterial({ color: BLUE, transparent: true, opacity: 0.32 })
      ));
    }

    // Earth core.
    {
      const earth = new THREE.Mesh(new THREE.CircleGeometry(layout.earthR, 48), new THREE.MeshBasicMaterial({ color: 0x10243a }));
      earth.position.z = 0.5;
      t.dynamic.add(earth);
      t.dynamic.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(circlePoints(layout.earthR)), new THREE.LineBasicMaterial({ color: 0x59c6ff })));
      t.dynamic.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(circlePoints(layout.earthR * 0.55)), new THREE.LineBasicMaterial({ color: 0x3a8fd0, transparent: true, opacity: 0.7 })));
      const dot = new THREE.Mesh(new THREE.CircleGeometry(2.2, 16), new THREE.MeshBasicMaterial({ color: 0x9fe0ff }));
      dot.position.z = 0.6;
      t.dynamic.add(dot);
    }

    // Object dots.
    for (const p of layout.points) {
      const w = W2(p.x, p.y);
      const haz = p.obj.monitored;
      const baseR = 3;
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(baseR, 16), new THREE.MeshBasicMaterial({ color: haz ? RED : AMBER }));
      mesh.position.set(w.x, w.y, 0.8);
      t.dynamic.add(mesh);
      if (haz) {
        const halo = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(circlePoints(7, 24)), new THREE.LineBasicMaterial({ color: RED, transparent: true, opacity: 0.6 }));
        halo.position.set(w.x, w.y, 0.7);
        t.dynamic.add(halo);
      }
      dotsRef.current.push({ mesh, baseR, frac: p.frac, haz });
    }

    // Sweep line + leading dot.
    {
      const segs = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(layout.maxR, 0, 0)];
      t.sweep.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(segs), new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9 })));
      // faint trailing wedge
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      for (let i = 0; i <= 16; i++) {
        const a = -(i / 16) * 0.5;
        shape.lineTo(Math.cos(a) * layout.maxR, Math.sin(a) * layout.maxR);
      }
      t.sweep.add(new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.07 })));
    }
  }, [objects, size, windowMin, windowMax]);

  // ----- overlay layout (labels + hit areas) -----
  const layout: RadarLayout | null = size.w > 0 ? radarLayout(objects, size.w, size.h, windowMin, windowMax) : null;
  const moonLd = moonDistanceLd(new Date(scrubberMs));
  // Only the single nearest encounter (smallest miss distance) keeps a standing
  // label; everything else reveals its designation on hover or selection.
  const nearestId = layout && layout.points.length ?
  layout.points.reduce((a, b) => b.obj.distLd < a.obj.distLd ? b : a).obj.id :
  null;

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {layout &&
      <div className="pointer-events-none absolute inset-0">
          {/* ring LD labels along vertical axis */}
          {layout.rings.map((r) =>
        <span key={r.ld} className="absolute -translate-x-1/2 text-[12px] text-[var(--amber-dim)]"
        style={{ left: layout.cx, top: layout.cy - r.r - 11 }}>
              {r.ld.toFixed(0)} LD
            </span>
        )}
          {/* dial date labels at quartiles */}
          {[0, 0.25, 0.5, 0.75].map((f) => {
          const a = -Math.PI / 2 + 2 * Math.PI * f;
          const rr = layout.maxR + 30;
          const x = layout.cx + Math.cos(a) * rr;
          const y = layout.cy + Math.sin(a) * rr;
          const t = windowMin + (windowMax - windowMin) * f;
          return (
            <span key={f} className="absolute -translate-x-1/2 -translate-y-1/2 text-[12px] tracking-wide text-[var(--amber)] opacity-80"
            style={{ left: x, top: y }}>{fmtDateShort(t)}</span>);

        })}
          {/* moon label */}
          <span className="absolute -translate-x-1/2 text-[12px] text-[#aeb8d0]"
        style={{ left: layout.cx, top: layout.cy - ldToRadius(moonLd, layout.maxR) - 22 }}>
            ☾ {moonLd.toFixed(2)} LD
          </span>
          {/* object labels + hit areas */}
          {layout.points.map((p) => {
          const sel = p.obj.id === selectedId;
          const hov = p.obj.id === hover;
          const show = sel || hov || p.obj.id === nearestId;
          return (
            <div key={p.obj.id}>
                {show &&
              <span className="absolute whitespace-nowrap text-[12px] leading-none"
              style={{
                left: p.x + 7, top: p.y - 5,
                color: p.obj.monitored ? "var(--red)" : sel ? "var(--amber-bright)" : "var(--amber)",
                textShadow: "0 0 6px currentColor"
              }}>
                    {p.obj.des}
                  </span>
              }
                {sel &&
              <span className="absolute rounded-full border"
              style={{ left: p.x - 9, top: p.y - 9, width: 18, height: 18, borderColor: "var(--amber-bright)", boxShadow: "0 0 10px var(--amber)" }} />
              }
                <button
                data-sfx="select"
                className="pointer-events-auto absolute rounded-full"
                style={{ left: p.x - 13, top: p.y - 13, width: 26, height: 26 }}
                onMouseEnter={() => setHover(p.obj.id)}
                onMouseLeave={() => setHover((h) => h === p.obj.id ? null : h)}
                onClick={() => onSelect(p.obj)}
                aria-label={`Select ${p.obj.des}`} />
              
              </div>);

        })}
        </div>
      }
    </div>);

}