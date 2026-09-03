import React, { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SpacecraftVehicle } from "../lib/types";

interface Props {
  vehicle: SpacecraftVehicle | null;
  loading?: boolean;
  compact?: boolean;
  onActivate?: () => void;
  onDetails?: () => void;
}

const GREEN = 0x54ff8a;
const CYAN = 0x39d6c8;
const AMBER = 0xff6a1f;
const DIM = 0x6b551f;
const VIEW_ANGLES = {
  free: { x: -0.16, y: -0.46, z: 0 },
  front: { x: 0, y: 0, z: 0 },
  side: { x: 0, y: Math.PI / 2, z: 0 },
  top: { x: -Math.PI / 2, y: 0, z: 0 },
} satisfies Record<string, { x: number; y: number; z: number }>;
type ViewLock = keyof typeof VIEW_ANGLES;

function isModelControl(target: EventTarget | null) {
  return target instanceof HTMLElement && !!target.closest("[data-model-controls]");
}

type DisposalState = {
  geometries: Set<THREE.BufferGeometry>;
  materials: Set<THREE.Material>;
  textures: Set<THREE.Texture>;
};

function createDisposalState(): DisposalState {
  return {
    geometries: new Set(),
    materials: new Set(),
    textures: new Set(),
  };
}

function disposeTexture(texture: THREE.Texture, state: DisposalState) {
  if (state.textures.has(texture)) return;
  state.textures.add(texture);
  texture.dispose();
}

function disposeUniformTextures(value: unknown, state: DisposalState, visited = new Set<object>()) {
  if (value instanceof THREE.Texture) {
    disposeTexture(value, state);
    return;
  }
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return;
  if (visited.has(value)) return;
  visited.add(value);
  for (const nested of Object.values(value)) disposeUniformTextures(nested, state, visited);
}

function disposeMaterialResources(material: THREE.Material, state: DisposalState) {
  if (state.materials.has(material)) return;
  state.materials.add(material);
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) disposeTexture(value, state);
  }
  if (material instanceof THREE.ShaderMaterial) {
    disposeUniformTextures(material.uniforms, state);
  }
  material.dispose();
}

function disposeObjectResources(root: THREE.Object3D, state = createDisposalState()) {
  root.traverse((object) => {
    const resource = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (resource.geometry && !state.geometries.has(resource.geometry)) {
      state.geometries.add(resource.geometry);
      resource.geometry.dispose();
    }
    const materials = resource.material == null
      ? []
      : Array.isArray(resource.material) ? resource.material : [resource.material];
    for (const material of materials) disposeMaterialResources(material, state);
  });
  if (root instanceof THREE.Scene) {
    if (root.background instanceof THREE.Texture) disposeTexture(root.background, state);
    if (root.environment instanceof THREE.Texture) disposeTexture(root.environment, state);
  }
}

function fitObject(obj: THREE.Object3D, target = 3.4) {
  // Scale first, THEN recenter using the post-scale bounding box. Doing it the
  // other way round (subtracting the un-scaled centre and scaling afterwards)
  // leaves the model off-centre by center*(scale-1) — which is what skewed the
  // Voyager mesh to one side of the frame.
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  obj.scale.multiplyScalar(target / maxDim);
  obj.updateMatrixWorld(true);
  const centered = new THREE.Box3().setFromObject(obj);
  const center = centered.getCenter(new THREE.Vector3());
  obj.position.sub(center);
}

function addWireHalo(g: THREE.Group, color: number, compact: boolean) {
  if (compact) return;
  const ringMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 });
  [1.42, 1.72, 2.02].forEach((r, i) => {
    const ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 97 }, (_, n) => {
          const a = (n / 96) * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r * 0.28, Math.sin(a) * r);
        })
      ),
      ringMat
    );
    ring.rotation.x = i === 1 ? Math.PI / 2 : 0;
    ring.rotation.z = i === 2 ? Math.PI / 2 : 0;
    g.add(ring);
  });
}

function edgeMaterial(mat: THREE.Material) {
  const src = mat as THREE.MeshBasicMaterial;
  return new THREE.LineBasicMaterial({
    color: src.color ?? new THREE.Color(GREEN),
    transparent: src.transparent,
    opacity: src.opacity,
  });
}

function addBox(g: THREE.Group, x: number, y: number, z: number, sx: number, sy: number, sz: number, mat: THREE.Material) {
  const line = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)), edgeMaterial(mat));
  line.position.set(x, y, z);
  g.add(line);
  return line;
}

function addDish(g: THREE.Group, x: number, y: number, z: number, r: number, mat: THREE.Material) {
  const dish = new THREE.Mesh(new THREE.ConeGeometry(r, 0.34, 48, 1, true), mat);
  dish.position.set(x, y, z);
  dish.rotation.x = Math.PI / 2;
  g.add(dish);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.025, 8, 64), mat);
  rim.position.set(x, y, z - 0.18);
  g.add(rim);
  return dish;
}

function addBoom(g: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, mat: THREE.Material) {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const len = a.distanceTo(b);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, len, 10), mat);
  cyl.position.copy(mid);
  cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.add(cyl);
  return cyl;
}

function proceduralCraft(vehicle: SpacecraftVehicle, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  switch (vehicle.schematic) {
    case "voyager":
      addDish(g, 0, 0.7, 0, 0.9, mat);
      addBox(g, 0, -0.12, 0, 0.58, 0.42, 0.58, mat);
      addBoom(g, new THREE.Vector3(-0.25, -0.1, 0), new THREE.Vector3(-1.75, -0.85, 0.45), mat);
      addBoom(g, new THREE.Vector3(0.25, -0.1, 0), new THREE.Vector3(1.85, -0.78, -0.45), mat);
      addBox(g, -1.95, -0.9, 0.48, 0.62, 0.24, 0.24, mat);
      addBox(g, 2.04, -0.82, -0.48, 0.72, 0.24, 0.24, mat);
      addBoom(g, new THREE.Vector3(0, 0.4, 0), new THREE.Vector3(0.9, 1.5, 0.6), mat);
      break;
    case "juno":
      addDish(g, 0, 0.2, 0, 0.48, mat);
      addBox(g, 0, -0.25, 0, 0.72, 0.5, 0.72, mat);
      addBoom(g, new THREE.Vector3(0.35, -0.25, 0), new THREE.Vector3(2.25, -0.25, 0), mat);
      addBoom(g, new THREE.Vector3(-0.35, -0.25, 0), new THREE.Vector3(-2.25, -0.25, 0), mat);
      addBoom(g, new THREE.Vector3(0, -0.45, 0.25), new THREE.Vector3(0, -0.45, 2.25), mat);
      addBox(g, 2.4, -0.25, 0, 1.25, 0.08, 0.58, mat);
      addBox(g, -2.4, -0.25, 0, 1.25, 0.08, 0.58, mat);
      addBox(g, 0, -0.45, 2.48, 0.58, 0.08, 1.25, mat);
      break;
    case "parker":
      addBox(g, 0, 0.45, 0, 1.55, 0.14, 1.0, mat);
      addBox(g, 0, -0.15, 0, 0.74, 0.78, 0.74, mat);
      addBox(g, -1.25, -0.18, 0, 1.15, 0.07, 0.48, mat);
      addBox(g, 1.25, -0.18, 0, 1.15, 0.07, 0.48, mat);
      addBoom(g, new THREE.Vector3(0, -0.55, 0), new THREE.Vector3(0, -1.55, 0), mat);
      break;
    case "psyche":
      addBox(g, 0, 0, 0, 0.82, 0.8, 0.95, mat);
      addDish(g, 0, 0.62, 0, 0.36, mat);
      addBox(g, -1.7, 0, 0, 1.72, 0.06, 1.0, mat);
      addBox(g, 1.7, 0, 0, 1.72, 0.06, 1.0, mat);
      addBoom(g, new THREE.Vector3(-0.45, 0, 0), new THREE.Vector3(-0.86, 0, 0), mat);
      addBoom(g, new THREE.Vector3(0.45, 0, 0), new THREE.Vector3(0.86, 0, 0), mat);
      break;
    default:
      addDish(g, 0, 0.55, 0, 0.76, mat);
      addBox(g, 0, -0.18, 0, 0.7, 0.64, 0.7, mat);
      addBoom(g, new THREE.Vector3(-0.34, -0.2, 0), new THREE.Vector3(-1.65, -0.7, 0), mat);
      addBoom(g, new THREE.Vector3(0.34, -0.2, 0), new THREE.Vector3(1.65, -0.7, 0), mat);
      addBox(g, -1.86, -0.7, 0, 0.62, 0.12, 0.5, mat);
      addBox(g, 1.86, -0.7, 0, 0.62, 0.12, 0.5, mat);
  }
  fitObject(g);
  return g;
}

export function SpacecraftModelView({ vehicle, loading = false, compact = false, onActivate, onDetails }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const lastInteraction = useRef(0);
  const drag = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef<{ active: boolean; dist: number }>({ active: false, dist: 0 });
  const desiredView = useRef<ViewLock>("free");
  // Camera dolly distance (scroll-to-zoom), eased toward its target each frame.
  const camDist = useRef({ v: compact ? 6.1 : 7.6, target: compact ? 6.1 : 7.6 });
  const camY = compact ? 0.85 : 0.6;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [loadedSource, setLoadedSource] = useState<"nasa" | "proxy" | "loading">("proxy");
  const [viewLock, setViewLock] = useState<ViewLock>("free");
  const [rendererError, setRendererError] = useState(false);
  const three = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    raf: number;
    frame: THREE.Group;
  } | null>(null);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      setRendererError(true);
      return;
    }
    setRendererError(false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, camY, camDist.current.v);
    camera.lookAt(0, 0, 0);
    const frame = new THREE.Group();
    scene.add(frame);

    const gridMat = new THREE.LineBasicMaterial({ color: DIM, transparent: true, opacity: compact ? 0.12 : 0.2 });
    for (let i = -4; i <= 4; i++) {
      const y = compact ? -1.35 : -2.05;
      const ptsA = [new THREE.Vector3(i, y, -2.8), new THREE.Vector3(i, y, 2.8)];
      const ptsB = [new THREE.Vector3(-4, y, i * 0.7), new THREE.Vector3(4, y, i * 0.7)];
      frame.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ptsA), gridMat));
      frame.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ptsB), gridMat));
    }
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.35, 0.012, 8, 96),
      new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.62 })
    );
    ring.rotation.x = Math.PI / 2;
    frame.add(ring);

    three.current = { renderer, scene, camera, raf: 0, frame };

    // Scroll-to-zoom on the full model view (mirrors the space-view wheel dolly).
    // The compact thumbnail stays fixed.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      lastInteraction.current = performance.now();
      const next = camDist.current.target * (1 + e.deltaY * 0.0012);
      camDist.current.target = Math.max(2.8, Math.min(18, next));
    };
    if (!compact) canvas.addEventListener("wheel", onWheel, { passive: false });

    const loop = () => {
      const t = three.current;
      if (!t) return;
      // Auto-rotate only the small preview thumbnail; the main view is fully
      // manual (drag to orbit, scroll to zoom) with no idle spin.
      if (modelRef.current && compact) {
        const idle = performance.now() - lastInteraction.current > 1200;
        if (idle && !drag.current.active) modelRef.current.rotation.y += 0.01;
      }
      const cd = camDist.current;
      cd.v += (cd.target - cd.v) * 0.14;
      t.camera.position.set(0, camY, cd.v);
      t.camera.lookAt(0, 0, 0);
      t.frame.rotation.z = Math.sin(performance.now() / 5200) * 0.04;
      t.renderer.render(t.scene, t.camera);
      t.raf = requestAnimationFrame(loop);
    };
    three.current.raf = requestAnimationFrame(loop);
    return () => {
      if (three.current) cancelAnimationFrame(three.current.raf);
      canvas.removeEventListener("wheel", onWheel);
      disposeObjectResources(scene);
      modelRef.current = null;
      renderer.dispose();
      three.current = null;
    };
  }, [compact, camY]);

  useEffect(() => {
    const t = three.current;
    if (!t || size.w === 0 || size.h === 0) return;
    t.renderer.setSize(size.w, size.h, false);
    t.camera.aspect = size.w / size.h;
    t.camera.updateProjectionMatrix();
  }, [size]);

  useEffect(() => {
    const t = three.current;
    if (!t || !vehicle) return;
    let cancelled = false;
    if (modelRef.current) {
      t.scene.remove(modelRef.current);
      disposeObjectResources(modelRef.current);
      modelRef.current = null;
    }

    const mat = new THREE.MeshBasicMaterial({
      color: vehicle.status.includes("ACTIVE") ? GREEN : CYAN,
      wireframe: true,
      transparent: true,
      opacity: 0.86,
    });
    const install = (obj: THREE.Object3D, source: "nasa" | "proxy") => {
      if (cancelled) {
        disposeObjectResources(obj);
        return;
      }
      const originalMaterials = new Set<THREE.Material>();
      obj.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) originalMaterials.add(material);
      });
      const disposal = createDisposalState();
      for (const material of originalMaterials) disposeMaterialResources(material, disposal);
      obj.traverse((object) => {
        if (object instanceof THREE.Mesh) object.material = mat.clone();
      });
      const root = new THREE.Group();
      fitObject(obj, compact ? 3.3 : source === "nasa" ? 2.9 : 3.4);
      root.add(obj);
      addWireHalo(root, vehicle.status.includes("ACTIVE") ? GREEN : CYAN, compact);
      // Keep the craft centred on the frame origin (the camera looks at 0,0,0).
      const view = VIEW_ANGLES[desiredView.current];
      root.rotation.set(view.x, view.y, view.z);
      t.scene.add(root);
      modelRef.current = root;
      setLoadedSource(source);
    };

    if (vehicle.modelUrl) {
      setLoadedSource("loading");
      new GLTFLoader().load(
        vehicle.modelUrl,
        (gltf) => install(gltf.scene, "nasa"),
        undefined,
        () => install(proceduralCraft(vehicle, mat.clone()), "proxy")
      );
    } else {
      install(proceduralCraft(vehicle, mat.clone()), "proxy");
    }
    return () => {
      cancelled = true;
      mat.dispose();
    };
  }, [vehicle, compact]);

  const lockView = useCallback((view: ViewLock) => {
    desiredView.current = view;
    setViewLock(view);
    lastInteraction.current = performance.now();
    const target = VIEW_ANGLES[view];
    modelRef.current?.rotation.set(target.x, target.y, target.z);
  }, []);

  const pointerDistance = useCallback(() => {
    const pts = [...activePointers.current.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }, []);

  const beginDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (compact || onActivate) return;
    if (isModelControl(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastInteraction.current = performance.now();
    setViewLock("free");
    desiredView.current = "free";
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer may already be captured */ }
    if (activePointers.current.size >= 2) {
      pinch.current = { active: true, dist: pointerDistance() };
      drag.current.active = false;
    } else {
      drag.current = { active: true, x: e.clientX, y: e.clientY };
      pinch.current.active = false;
    }
  }, [compact, onActivate, pointerDistance]);

  const moveDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (compact || onActivate) return;
    if (!activePointers.current.has(e.pointerId)) return;
    e.preventDefault();
    e.stopPropagation();
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.current.size >= 2) {
      const dist = pointerDistance();
      if (dist > 0 && pinch.current.dist > 0) {
        const next = camDist.current.target * (pinch.current.dist / dist);
        camDist.current.target = Math.max(2.8, Math.min(18, next));
      }
      pinch.current = { active: true, dist };
      lastInteraction.current = performance.now();
      return;
    }
    if (!drag.current.active || !modelRef.current) return;
    const dx = e.clientX - drag.current.x;
    const dy = e.clientY - drag.current.y;
    drag.current.x = e.clientX;
    drag.current.y = e.clientY;
    modelRef.current.rotation.y += dx * 0.009;
    modelRef.current.rotation.x = Math.max(-Math.PI * 0.62, Math.min(Math.PI * 0.62, modelRef.current.rotation.x + dy * 0.009));
    lastInteraction.current = performance.now();
  }, [compact, onActivate, pointerDistance]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (compact || onActivate) return;
    e.preventDefault();
    e.stopPropagation();
    activePointers.current.delete(e.pointerId);
    if (activePointers.current.size === 1) {
      const pt = [...activePointers.current.values()][0];
      drag.current = { active: true, x: pt.x, y: pt.y };
      pinch.current.active = false;
    } else {
      drag.current.active = false;
      pinch.current.active = false;
    }
    lastInteraction.current = performance.now();
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* pointer may already be released */ }
  }, [compact, onActivate]);

  const content = (
    <>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ touchAction: compact ? "manipulation" : "none" }} />
      {rendererError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[rgba(5,4,10,0.62)] text-center text-[11px] text-[var(--amber-dim)]">
          <div className="text-[var(--orange)] glow-text">▸ WEBGL MODEL OFFLINE</div>
          <div>3D CONTEXT UNAVAILABLE</div>
        </div>
      )}
      {compact && (
        <>
          <div className="pointer-events-none absolute left-2 top-2 text-[10px] leading-tight text-[var(--orange)] glow-text">
            ▸ CRAFT MODEL / {vehicle?.shortName ?? "STANDBY"}
          </div>
          <div className="pointer-events-none absolute right-2 top-2 text-right text-[10px] leading-tight text-[var(--text-dim)]">
            {loading ? "LOADING" : loadedSource === "nasa" ? "NASA GLB" : loadedSource === "loading" ? "FETCHING GLB" : "PROXY MESH"}
          </div>
        </>
      )}
      {!compact && !onActivate && (
        <div
          data-model-controls
          className="pointer-events-auto absolute right-2 bottom-[116px] z-40 flex gap-1 max-md:bottom-2"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}>
          {(["front", "side", "top"] as ViewLock[]).map((view) => (
            <button
              key={view}
              type="button"
              data-sfx="confirm"
              onClick={() => lockView(view)}
              aria-pressed={viewLock === view}
              className="h-6 border border-[var(--line)] bg-[rgba(5,4,10,0.56)] px-2 text-[10px] uppercase text-[var(--text-dim)] hover:border-[var(--amber-dim)] hover:text-[var(--green)]"
              style={{ color: viewLock === view ? "var(--green)" : undefined }}>
              {view}
            </button>
          ))}
          {onDetails && (
            <button
              type="button"
              data-sfx="select"
              onClick={onDetails}
              className="h-6 border border-[var(--line)] bg-[rgba(5,4,10,0.56)] px-2 text-[10px] uppercase text-[var(--text-dim)] hover:border-[var(--amber-dim)] hover:text-[var(--green)] md:hidden">
              details
            </button>
          )}
        </div>
      )}
      {!vehicle && (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[var(--amber-dim)]">
          ▸ MODEL STANDBY
        </div>
      )}
    </>
  );

  if (onActivate) {
    return (
      <button
        type="button"
        data-sfx="saber"
        onClick={onActivate}
        ref={(n) => { wrapRef.current = n as unknown as HTMLDivElement; }}
        className="relative block h-full w-full overflow-hidden text-left"
        aria-label="Open spacecraft archive">
        {content}
      </button>
    );
  }

  return (
    <div
      ref={wrapRef}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      className="relative h-full w-full cursor-grab overflow-hidden overscroll-contain active:cursor-grabbing"
      style={{ touchAction: "none" }}>
      {content}
    </div>
  );
}
