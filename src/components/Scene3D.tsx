import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { CmeEvent, FlareEvent, NeoObject, OrbitElements, SatElements, SpacecraftVehicle } from "../lib/types";
import {
  orbitPosition,
  orbitPath3D,
  earthPosition,
  planetStates3D,
  moonDistanceLd,
  moonEclipticLongitude,
  satEclipticKm,
  helioDirEcliptic,
  AU_TO_LD,
  AU_KM,
  LUNAR_DISTANCE_KM,
  EARTH_RADIUS_KM,
  MOON_RADIUS_KM } from
"../lib/astro";
import { CONTINENTS, lonLatToVec3 } from "../lib/continents";
import { audio } from "../lib/audio";

type Mode = "GEO" | "HELIO";
export type SceneLayers = {
  orbits: boolean;
  cmes: boolean;
  flares: boolean;
  solar: boolean;
};

interface Props {
  objects: NeoObject[];
  elements: Record<string, OrbitElements>;
  windowMin: number;
  windowMax: number;
  scrubberMs: number;
  selectedId: string | null;
  selectedDes: string | null;
  onSelect: (o: NeoObject) => void;
  mode: Mode;
  variant?: "main" | "mini";
  onActivate?: () => void;
  satellites?: SatElements[];
  onNearEarth?: () => void;
  cmes?: CmeEvent[];
  flares?: FlareEvent[];
  layers?: Partial<SceneLayers>;
  spacecraft?: SpacecraftVehicle[];
  onSelectCraft?: (craft: SpacecraftVehicle) => void;
}

const AMBER = 0xf0b32a;
const AMBER_DIM = 0x6f5316;
const AMBER_BRIGHT = 0xffd76b;
const BLUE = 0x6fb8ff;
const RED = 0xff3b2f;
const MOONC = 0xcfd6e6;
const ISSC = 0x6dffae;
const DEG = Math.PI / 180;
const ISS_NORAD = 25544;

// Constellation-class colours, matched to the bottom-left key.
const SAT_COLORS: Record<string, number> = {
  starlink: 0x39d6c8,
  oneweb: 0x5f7bff,
  weather: 0xcfd6e6,
  gps: 0x54ff8a,
  geo: 0xff8a3c,
  other: 0x8a93b5,
};

const AU_SCALE = 46; // units per AU (heliocentric)
const HELIO_LINEAR_AU = 4;
const LD_SCALE = 3.3; // units per lunar distance (geocentric)
const GEO_AU = AU_TO_LD * LD_SCALE; // units per AU in geocentric mode
const GEO_KM = LD_SCALE / LUNAR_DISTANCE_KM; // units per km in geocentric mode
const GEO_RINGS = [1, 5, 10, 15, 20];

// CME particle-stream colours by bulk speed (km/s) — cool amber for slow ejecta
// through to hot red for the fastest, halo-class events.
const CME_SLOW = 0xffb24a;
const CME_FAST = 0xff7a1f;
const CME_EXTREME = 0xff3b2f;
function cmeColor(speed: number | null, earthDirected: boolean): number {
  if (earthDirected) return CME_EXTREME;
  if (speed == null) return CME_SLOW;
  if (speed >= 1500) return CME_EXTREME;
  if (speed >= 800) return CME_FAST;
  return CME_SLOW;
}
const CME_MAX_AU = 1.8; // clip plumes inside the inner-system framing radius
const CME_FADE_DAYS = 6; // a plume lingers ~6 days after launch, then fades out
const FLARE_GLOW_MS = 10 * 60 * 60 * 1000; // active-region flash half-life window

// True-to-scale geocentric body radii (units). Earth is ~1/389 of a lunar
// distance, so at the scale that shows asteroid fly-bys it is a tiny dot — the
// honest relationship. A fixed-pixel core point keeps it locatable when far.
const EARTH_R = EARTH_RADIUS_KM * GEO_KM; // ≈ 0.0547 units
const MOON_R = MOON_RADIUS_KM * GEO_KM; // ≈ 0.0149 units
const SAT_FETCH_RADIUS = 9; // camera radius at which we lazily pull CelesTrak

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

function toThree(e: {x: number;y: number;z: number;}, scale: number): THREE.Vector3 {
  return new THREE.Vector3(e.x * scale, e.z * scale, -e.y * scale);
}

function helioSceneRadius(au: number): number {
  if (au <= HELIO_LINEAR_AU) return au * AU_SCALE;
  return HELIO_LINEAR_AU * AU_SCALE + Math.log1p(au - HELIO_LINEAR_AU) * 96;
}

function toHelio(e: {x: number;y: number;z: number;}): THREE.Vector3 {
  const au = Math.hypot(e.x, e.y, e.z);
  if (au < 1e-8) return new THREE.Vector3();
  const s = helioSceneRadius(au) / au;
  return toThree(e, s);
}

function ringPoints(r: number, seg = 160): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = i / seg * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
  }
  return pts;
}

function seeded01(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function Scene3D(props: Props) {
  const {
    objects, elements, windowMin, windowMax, scrubberMs,
    selectedId, selectedDes, onSelect, mode,
    variant = "main", onActivate, satellites, onNearEarth,
    cmes, flares, layers, spacecraft, onSelectCraft } = props;
  const isMini = variant === "mini";
  const showOrbits = layers?.orbits ?? true;
  // On the mini map the Sun is always drawn as a plain sphere — the solar
  // activity / CME / flare layers are forced off regardless of the toggles.
  const showCmes = isMini ? false : (layers?.cmes ?? true);
  const showFlares = isMini ? false : (layers?.flares ?? true);
  const showSolar = isMini ? false : (layers?.solar ?? true);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [rendererError, setRendererError] = useState(false);

  const labelHost = useRef<HTMLDivElement | null>(null);
  const bodyHost = useRef<HTMLDivElement | null>(null);
  const labelNodes = useRef<Map<string, HTMLSpanElement>>(new Map());
  const markerById = useRef<Map<string, THREE.Object3D>>(new Map());
  const extraLabels = useRef<Array<{node: HTMLSpanElement;obj: THREE.Object3D;}>>([]);

  const scrubRef = useRef(scrubberMs);
  scrubRef.current = scrubberMs;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const selRef = useRef(selectedId);
  selRef.current = selectedId;
  const satsRef = useRef<SatElements[]>(satellites ?? []);
  satsRef.current = satellites ?? [];
  const onNearEarthRef = useRef(onNearEarth);
  onNearEarthRef.current = onNearEarth;
  const onSelectCraftRef = useRef(onSelectCraft);
  onSelectCraftRef.current = onSelectCraft;
  const nearFired = useRef(false);

  const three = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    raf: number;
    raycaster: THREE.Raycaster;
    selRing: THREE.LineLoop;
  } | null>(null);

  // Camera orbit state (spherical around target).
  const cam = useRef({ theta: 0.9, phi: 1.05, radius: 120, target: 120 });
  const lastActive = useRef(0); // 0 => idle from boot, so it auto-rotates immediately
  const allowAuto = useRef(true);
  const pickList = useRef<THREE.Object3D[]>([]);
  const pickMap = useRef<Map<THREE.Object3D, NeoObject>>(new Map());
  const craftPickMap = useRef<Map<THREE.Object3D, SpacecraftVehicle>>(new Map());
  const dynUpdate = useRef<(() => void) | null>(null);
  // Hover glow: the marker currently under the cursor (its whole orbit path
  // eases up to a soft bright glow rather than snapping on/off).
  const hoverTarget = useRef<THREE.Object3D | null>(null);
  const glowReg = useRef<Map<THREE.Object3D, {
    markerMat: THREE.MeshBasicMaterial;
    baseMarker: THREE.Color;
    trailMat: THREE.MeshBasicMaterial | null;
    baseTrail: THREE.Color;
    baseTrailOp: number;
    glowTrailOp: number;
  }>>(new Map());
  const activeGlow = useRef<Map<THREE.Object3D, number>>(new Map());
  const bright = useRef(new THREE.Color(AMBER_BRIGHT));

  const plotted = useMemo(
    () => objects.filter((o) => elements[o.des]),
    [objects, elements]
  );

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

  // Init renderer + controls once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      setRendererError(true);
      return;
    }
    setRendererError(false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 9000);
    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 4 };

    // billboard selection ring (red), reused across rebuilds
    const selRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        Array.from({ length: 65 }, (_, i) => {
          const a = i / 64 * Math.PI * 2;
          return new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
        })
      ),
      new THREE.LineBasicMaterial({ color: RED, transparent: true, opacity: 0.92 })
    );
    selRing.visible = false;
    scene.add(selRing);

    three.current = { renderer, scene, camera, raf: 0, raycaster, selRing };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    allowAuto.current = !reduce;

    const poke = () => {lastActive.current = performance.now();};
    const worldPos = new THREE.Vector3();

    // ---- interaction (main variant only) ----
    let dragging = false;
    let lx = 0,ly = 0,moved = 0;
    // Flag a pickable marker as the hover target; the render loop eases its
    // glow (and its whole orbit path's glow) up or down for a soft transition.
    const applyHover = (mesh: THREE.Object3D | null) => {
      if (hoverTarget.current === mesh) return;
      hoverTarget.current = mesh;
      if (mesh) activeGlow.current.set(mesh, activeGlow.current.get(mesh) ?? 0);
    };

    // Lerp a marker + its trail between their base colour/opacity and a soft
    // amber glow. g in [0,1] is the eased glow strength.
    const applyGlow = (obj: THREE.Object3D, g: number) => {
      const e = glowReg.current.get(obj);
      if (!e) return;
      e.markerMat.color.copy(e.baseMarker).lerp(bright.current, g * 0.9);
      obj.scale.setScalar(1 + g * 0.55);
      if (e.trailMat) {
        e.trailMat.color.copy(e.baseTrail).lerp(bright.current, g * 0.85);
        e.trailMat.opacity = e.baseTrailOp + (e.glowTrailOp - e.baseTrailOp) * g;
      }
    };

    const onDown = (e: PointerEvent) => {
      dragging = true;moved = 0;lx = e.clientX;ly = e.clientY;
      poke();
      canvas.style.cursor = "grabbing";
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      poke(); // any movement over the surface counts as active
      if (pinchActive) return; // a two-finger pinch owns the gesture
      if (dragging) {
        const dx = e.clientX - lx,dy = e.clientY - ly;
        lx = e.clientX;ly = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        cam.current.theta -= dx * 0.006;
        cam.current.phi = Math.max(0.12, Math.min(Math.PI - 0.12, cam.current.phi - dy * 0.006));
        return;
      }
      // hover detection over pickable markers
      const t = three.current;
      if (!t) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        (e.clientX - rect.left) / rect.width * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      t.raycaster.setFromCamera(ndc, t.camera);
      const hits = t.raycaster.intersectObjects(pickList.current, false);
      const hitMesh = hits.length ? hits[0].object : null;
      applyHover(hitMesh);
      canvas.style.cursor = hitMesh ? "pointer" : "grab";
    };
    const onUp = (e: PointerEvent) => {
      if (dragging && moved < 5) pick(e);
      dragging = false;
      canvas.style.cursor = hoverTarget.current ? "pointer" : "grab";
      try {canvas.releasePointerCapture(e.pointerId);} catch {/* noop */}
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      poke();
      // GEO min is tiny so you can fly right down to the true-scale globe and
      // pick out individual satellites; max frames the full ~20 LD field. The
      // mini map lets you push in much closer than the main heliocentric view.
      const min = modeRef.current === "GEO" ? 0.12 : isMini ? 8 : 70;
      const max = modeRef.current === "GEO" ? 340 : 900;
      cam.current.target = Math.max(min, Math.min(max, cam.current.target * (1 + e.deltaY * 0.0012)));
    };
    const pick = (e: PointerEvent) => {
      const t = three.current;
      if (!t) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        (e.clientX - rect.left) / rect.width * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      t.raycaster.setFromCamera(ndc, t.camera);
      const hits = t.raycaster.intersectObjects(pickList.current, false);
      if (hits.length) {
        const obj = pickMap.current.get(hits[0].object);
        if (obj) { audio.play("select"); onSelect(obj); }
        const craft = craftPickMap.current.get(hits[0].object);
        if (craft) { audio.play("select"); onSelectCraftRef.current?.(craft); }
      }
    };

    // Pinch-to-zoom for touch devices.
    let pinchDist0 = 0;
    let pinchActive = false;
    const pinchDist = (t: TouchList) =>
      Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinchActive = true;
        dragging = false; // cancel any rotation drag — the pinch takes over
        pinchDist0 = pinchDist(e.touches);
        e.preventDefault();
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!pinchActive || e.touches.length !== 2) return;
      e.preventDefault();
      poke();
      const d = pinchDist(e.touches);
      const ratio = pinchDist0 / d; // >1 fingers closer → zoom out, <1 → zoom in
      pinchDist0 = d;
      const min = modeRef.current === "GEO" ? 0.12 : isMini ? 8 : 70;
      const max = modeRef.current === "GEO" ? 340 : 900;
      cam.current.target = Math.max(min, Math.min(max, cam.current.target * ratio));
    };
    const onTouchEnd = () => { pinchActive = false; };

    if (!isMini) {
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("touchstart", onTouchStart, { passive: false });
      canvas.addEventListener("touchmove", onTouchMove, { passive: false });
      canvas.addEventListener("touchend", onTouchEnd);
    } else {
      // The mini map still promotes on click, but supports zoom so operators can
      // push in on the plain-sphere Sun without opening the full view.
      canvas.addEventListener("wheel", onWheel, { passive: false });
      canvas.addEventListener("touchstart", onTouchStart, { passive: false });
      canvas.addEventListener("touchmove", onTouchMove, { passive: false });
      canvas.addEventListener("touchend", onTouchEnd);
    }

    const loop = () => {
      const t = three.current;
      if (!t) return;
      const idle = performance.now() - lastActive.current > 5000;
      const autorotate = allowAuto.current && (isMini || idle);
      if (autorotate) cam.current.theta += isMini ? 0.0013 : 0.0006;
      cam.current.radius += (cam.current.target - cam.current.radius) * 0.12;
      // Lazily request the satellite catalogue once the operator zooms into
      // Earth's neighbourhood in the geocentric view.
      if (!isMini && modeRef.current === "GEO" && !nearFired.current && cam.current.radius < SAT_FETCH_RADIUS) {
        nearFired.current = true;
        onNearEarthRef.current?.();
      }
      const { theta, phi, radius } = cam.current;
      t.camera.position.set(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        radius * Math.sin(phi) * Math.sin(theta)
      );
      t.camera.lookAt(0, 0, 0);
      dynUpdate.current?.();

      // Ease hover glow on the hovered marker + its whole orbit path, and fade
      // any previously-hovered markers back down (soft, not on/off).
      {
        const target = hoverTarget.current;
        const act = activeGlow.current;
        if (target && !act.has(target)) act.set(target, 0);
        act.forEach((val, obj) => {
          const goal = obj === target ? 1 : 0;
          let nv = val + (goal - val) * 0.1;
          if (goal === 0 && nv < 0.003) {
            applyGlow(obj, 0);
            act.delete(obj);
            return;
          }
          nv = Math.min(1, Math.max(0, nv));
          act.set(obj, nv);
          applyGlow(obj, nv);
        });
      }

      // selection ring billboard
      const sel = selRef.current;
      let selMesh: THREE.Object3D | undefined;
      if (!isMini && sel) selMesh = markerById.current.get(sel);
      if (selMesh && (selMesh as any).visible !== false) {
        const s = t.camera.position.distanceTo(selMesh.position) * 0.05;
        t.selRing.position.copy(selMesh.position);
        t.selRing.scale.setScalar(Math.max(2.4, s));
        t.selRing.quaternion.copy(t.camera.quaternion);
        t.selRing.visible = true;
      } else {
        t.selRing.visible = false;
      }

      // project labels (use WORLD position so bodies inside transformed groups,
      // like the inclined ISS orbit, keep their labels pinned to the icon)
      const project = (host: HTMLDivElement | null, node: HTMLSpanElement, obj: THREE.Object3D) => {
        if (!host) return;
        const w = host.clientWidth,h = host.clientHeight;
        if ((obj as any).visible === false) {node.style.display = "none";return;}
        const v = obj.getWorldPosition(worldPos).project(t.camera);
        if (v.z > 1) {node.style.display = "none";return;}
        node.style.display = "block";
        node.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px)`;
      };
      labelNodes.current.forEach((node, id) => {
        const mk = markerById.current.get(id);
        if (!mk) {node.style.display = "none";return;}
        project(labelHost.current, node, mk);
      });
      for (const e of extraLabels.current) project(bodyHost.current, e.node, e.obj);

      t.renderer.render(t.scene, t.camera);
      t.raf = requestAnimationFrame(loop);
    };
    three.current.raf = requestAnimationFrame(loop);

    return () => {
      if (three.current) cancelAnimationFrame(three.current.raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      disposeObjectResources(scene);
      renderer.dispose();
      dynUpdate.current = null;
      three.current = null;
    };
  }, [onSelect, isMini]);

  // Resize.
  useEffect(() => {
    const t = three.current;
    if (!t || size.w === 0 || size.h === 0) return;
    t.renderer.setSize(size.w, size.h, false);
    t.camera.aspect = size.w / size.h;
    t.camera.updateProjectionMatrix();
  }, [size]);

  // Reset zoom target when mode changes.
  useEffect(() => {
    cam.current.target = mode === "GEO" ? 120 : 200;
  }, [mode]);

  // Build scene contents on data / mode change.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const scene = t.scene;
    // clear everything except the persistent selection ring
    const disposal = createDisposalState();
    for (let i = scene.children.length - 1; i >= 0; i--) {
      const c = scene.children[i];
      if (c === t.selRing) continue;
      scene.remove(c);
      disposeObjectResources(c, disposal);
    }
    dynUpdate.current = null;
    t.selRing.visible = false;
    pickList.current = [];
    pickMap.current = new Map();
    craftPickMap.current = new Map();
    markerById.current = new Map();
    // old hovered meshes are being disposed — drop all glow bookkeeping
    glowReg.current = new Map();
    activeGlow.current = new Map();
    hoverTarget.current = null;

    // Record a marker + its orbit path so the hover glow can light both up.
    const registerGlow = (marker: THREE.Mesh, trail: THREE.Object3D | null) => {
      const mm = marker.material as THREE.MeshBasicMaterial;
      const trailMat = trail ? (trail as any).material : null;
      const tm =
      trailMat && trailMat.color && typeof trailMat.opacity === "number" ?
      trailMat as THREE.Material & { color: THREE.Color; opacity: number } : null;
      const baseTrailOp = tm ? tm.opacity : 0;
      glowReg.current.set(marker, {
        markerMat: mm,
        baseMarker: mm.color.clone(),
        trailMat: tm as THREE.MeshBasicMaterial | null,
        baseTrail: tm ? tm.color.clone() : new THREE.Color(),
        baseTrailOp,
        glowTrailOp: Math.min(0.85, Math.max(0.5, baseTrailOp * 12 + 0.45))
      });
    };
    // clear body labels
    for (const e of extraLabels.current) e.node.remove();
    extraLabels.current = [];

    const mkLabel = (text: string, colorVar: string, obj: THREE.Object3D) => {
      if (isMini || !bodyHost.current) return;
      const s = document.createElement("span");
      s.textContent = text;
      s.style.cssText =
      `position:absolute;left:0;top:0;white-space:nowrap;font-size:12px;line-height:1;` +
      `color:${colorVar};text-shadow:0 0 6px currentColor;margin-left:9px;margin-top:-5px;` +
      `font-family:var(--font-mono);letter-spacing:0.04em;display:none;`;
      bodyHost.current.appendChild(s);
      extraLabels.current.push({ node: s, obj });
    };

    const dimLine = (pts: THREE.Vector3[], color: number, opacity: number, loop = false) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
      return loop ? new THREE.LineLoop(geo, mat) : new THREE.Line(geo, mat);
    };

    const dottedLine = (pts: THREE.Vector3[], color: number, opacity: number) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 3.2, gapSize: 2.4 });
      const line = new THREE.Line(geo, mat);
      line.computeLineDistances();
      return line;
    };

    // Tube-based "fat" line — WebGL ignores LineBasicMaterial.linewidth, so real
    // weight comes from extruding the polyline along a curve. Used for the bold
    // strokes: coastlines, approach trails, and orbit paths.
    const fatLine = (pts: THREE.Vector3[], color: number, opacity: number, radius: number, closed = false) => {
      const clean: THREE.Vector3[] = [];
      for (const p of pts) {
        if (!clean.length || clean[clean.length - 1].distanceToSquared(p) > 1e-7) clean.push(p);
      }
      if (closed && clean.length > 2 && clean[0].distanceToSquared(clean[clean.length - 1]) < 1e-6) clean.pop();
      if (clean.length < 2) return new THREE.Object3D();
      const curve = new THREE.CatmullRomCurve3(clean, closed, "catmullrom", 0.0);
      const seg = Math.min(900, Math.max(clean.length, 24));
      const geo = new THREE.TubeGeometry(curve, seg, radius, 6, closed);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity });
      return new THREE.Mesh(geo, mat);
    };

    const markerGeo = (sel: boolean) =>
    new THREE.OctahedronGeometry(
      mode === "GEO" ? sel ? 0.85 : 0.52 : sel ? 1.25 : 0.85,
      0
    );

    // starfield — denser two-layer field for depth
    {
      const make = (count: number, color: number, sz: number, op: number) => {
        const pts: number[] = [];
        for (let i = 0; i < count; i++) {
          const r = 1100 + Math.random() * 2200;
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const s = Math.sqrt(1 - u * u);
          pts.push(Math.cos(a) * s * r, u * r, Math.sin(a) * s * r);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color, size: sz, sizeAttenuation: false, transparent: true, opacity: op })));
      };
      make(3200, 0x4a3f1e, 1.1, 0.5);
      make(2200, 0x5e5026, 1.5, 0.6);
      make(520, 0xb59a4a, 2.2, 0.85);
    }

    const date0 = new Date(scrubRef.current);

    if (mode === "HELIO") {
      if (showOrbits) {
        for (const au of [0.39, 0.72, 1, 1.52, 5.2, 9.6, 19.2, 30.1, 60, 120, 165]) {
          scene.add(dimLine(ringPoints(helioSceneRadius(au)), AMBER_DIM, au === 1 ? 0.35 : au > 40 ? 0.1 : 0.16, true));
        }
      }
      // ---- Sun: layered photosphere + corona + billboarded glow halo --------
      const SUN_R = 4.5;
      const sun = new THREE.Group();
      scene.add(sun);
      // Photosphere core.
      sun.add(new THREE.Mesh(
        new THREE.SphereGeometry(SUN_R, 32, 32),
        new THREE.MeshBasicMaterial({ color: 0xffe39a })
      ));
      // Additive corona shells, warm → dim, growing outward. All of the Sun's
      // embellishments (granulation shimmer, corona, glow halo, ring) are dropped
      // on the mini map so it stays a clean, plain sphere.
      const coronaShells: Array<{ mat: THREE.MeshBasicMaterial; base: number }> = [];
      if (!isMini) {
        // Granulation shimmer — a thin offset wireframe shell that mottles the limb.
        sun.add(new THREE.Mesh(
          new THREE.SphereGeometry(SUN_R * 1.012, 28, 20),
          new THREE.MeshBasicMaterial({ color: CME_FAST, wireframe: true, transparent: true, opacity: showSolar ? 0.22 : 0.08 })
        ));
        const shellSpec: Array<[number, number, number]> = [
          [SUN_R * 1.25, 0xffb24a, 0.3],
          [SUN_R * 1.7, CME_FAST, 0.16],
          [SUN_R * 2.5, CME_EXTREME, 0.08],
        ];
        for (const [r, color, op] of shellSpec) {
          const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false });
          sun.add(new THREE.Mesh(new THREE.SphereGeometry(r, 28, 24), mat));
          coronaShells.push({ mat, base: op });
        }
        // Soft radial-gradient glow sprite (always faces the camera).
        const glowTex = (() => {
          const c = document.createElement("canvas");
          c.width = c.height = 128;
          const g = c.getContext("2d")!;
          const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
          grd.addColorStop(0, "rgba(255,228,150,0.95)");
          grd.addColorStop(0.25, "rgba(255,150,60,0.5)");
          grd.addColorStop(0.6, "rgba(255,70,40,0.14)");
          grd.addColorStop(1, "rgba(255,70,40,0)");
          g.fillStyle = grd;
          g.fillRect(0, 0, 128, 128);
          const t = new THREE.CanvasTexture(c);
          return t;
        })();
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.75 }));
        glow.scale.setScalar(SUN_R * 5);
        sun.add(glow);
        scene.add(dimLine(ringPoints(SUN_R * 1.7, 64), AMBER, 0.4, true));
      }
      mkLabel("SOL", "var(--amber-bright)", sun);

      // ---- Solar activity shell: moving particles + latitude bands -----------
      const solarActivity = new THREE.Group();
      if (showSolar) {
        sun.add(solarActivity);
        const shellCount = 1200;
        const shellPos = new Float32Array(shellCount * 3);
        const shellCol = new Float32Array(shellCount * 3);
        for (let i = 0; i < shellCount; i++) {
          const band = (i % 9) / 8;
          const lat = (band - 0.5) * 1.35 + (seeded01(i + 7) - 0.5) * 0.18;
          const a = i * 0.31 + seeded01(i + 19) * Math.PI * 2;
          const r = SUN_R * (1.14 + seeded01(i + 31) * 1.35);
          const cl = Math.cos(lat);
          shellPos[i * 3] = Math.cos(a) * cl * r;
          shellPos[i * 3 + 1] = Math.sin(lat) * r;
          shellPos[i * 3 + 2] = Math.sin(a) * cl * r;
          const hot = new THREE.Color(i % 5 === 0 ? 0x9cffb2 : i % 3 === 0 ? 0xffd76b : 0xff8a3c);
          shellCol[i * 3] = hot.r;shellCol[i * 3 + 1] = hot.g;shellCol[i * 3 + 2] = hot.b;
        }
        const shellGeo = new THREE.BufferGeometry();
        shellGeo.setAttribute("position", new THREE.Float32BufferAttribute(shellPos, 3));
        shellGeo.setAttribute("color", new THREE.Float32BufferAttribute(shellCol, 3));
        solarActivity.add(new THREE.Points(
          shellGeo,
          new THREE.PointsMaterial({ size: 1.9, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false })
        ));
        for (let b = 0; b < 5; b++) {
          const ring = dimLine(ringPoints(SUN_R * (1.18 + b * 0.18), 180), b % 2 ? 0x9cffb2 : AMBER_BRIGHT, 0.22, true);
          ring.rotation.x = (38 + b * 11) * DEG;
          ring.rotation.z = (b * 31) * DEG;
          solarActivity.add(ring);
        }
      }

      // ---- Flare particle bursts on the solar surface ------------------------
      const POS_Y = new THREE.Vector3(0, 1, 0);
      const flareList = showFlares ? (flares ?? []).filter((f) => f.lat != null && f.lon != null).slice(-36) : [];
      const flareBursts: Array<{ group: THREE.Group; mat: THREE.PointsMaterial; peakMs: number; cls: string }> = [];
      for (const [fi, f] of flareList.entries()) {
        const dir = toThree(helioDirEcliptic(f.lon!, f.lat!, date0), 1).normalize();
        const hot = f.cls === "X" ? CME_EXTREME : f.cls === "M" ? CME_FAST : 0xffd76b;
        const count = f.cls === "X" ? 150 : f.cls === "M" ? 110 : 70;
        const pos = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const t0 = seeded01(fi * 1000 + i * 13);
          const a = seeded01(fi * 2000 + i * 17) * Math.PI * 2;
          const spread = (0.12 + t0 * 0.36) * SUN_R;
          const h = SUN_R * 1.03 + t0 * SUN_R * 2.5;
          const curl = Math.sin(t0 * 8 + fi) * 0.25;
          pos[i * 3] = Math.cos(a + curl) * spread * t0;
          pos[i * 3 + 1] = h;
          pos[i * 3 + 2] = Math.sin(a + curl) * spread * t0;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({ color: hot, size: f.cls === "X" ? 3.2 : 2.4, sizeAttenuation: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
        const points = new THREE.Points(geo, mat);
        const group = new THREE.Group();
        group.quaternion.setFromUnitVectors(POS_Y, dir);
        group.add(points);
        group.visible = false;
        sun.add(group);
        flareBursts.push({ group, mat, peakMs: f.peakMs, cls: f.cls });
      }

      // ---- CME streamers: sparse particles, not opaque cones -----------------
      const NEG_Y = new THREE.Vector3(0, -1, 0);
      const cmeList = showCmes ? (cmes ?? []).filter((c) => c.lat != null && c.lon != null && c.speed != null) : [];
      const cmeStreamers: Array<{
        group: THREE.Group; mat: THREE.PointsMaterial; startMs: number; speed: number; baseOp: number;
      }> = [];
      for (const [ci, c] of cmeList.entries()) {
        const dir = toThree(helioDirEcliptic(c.lon!, c.lat!, date0), 1).normalize();
        const half = Math.max(5, Math.min(55, c.halfAngle ?? 18)) * DEG;
        const baseR = Math.tan(half);
        const color = cmeColor(c.speed, c.earthDirected);
        const strands = c.earthDirected ? 13 : 9;
        const steps = c.earthDirected ? 28 : 22;
        const count = strands * steps;
        const pos = new Float32Array(count * 3);
        let n = 0;
        for (let s = 0; s < strands; s++) {
          const strandA = s / strands * Math.PI * 2 + seeded01(ci * 37 + s) * 0.35;
          const wobble = seeded01(ci * 71 + s) * Math.PI * 2;
          for (let k = 0; k < steps; k++) {
            const t0 = (k + seeded01(ci * 1000 + s * 53 + k)) / steps;
            const taper = Math.pow(t0, 0.82);
            const spread = baseR * taper * (0.22 + seeded01(ci * 2000 + s * 97 + k) * 0.74);
            const a = strandA + Math.sin(t0 * 8 + wobble) * 0.3;
            pos[n * 3] = Math.cos(a) * spread;
            pos[n * 3 + 1] = -taper;
            pos[n * 3 + 2] = Math.sin(a) * spread;
            n++;
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({ color, size: c.earthDirected ? 3.2 : 2.5, sizeAttenuation: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
        const group = new THREE.Group();
        group.add(new THREE.Points(geo, mat));
        group.quaternion.setFromUnitVectors(NEG_Y, dir);
        group.visible = false;
        scene.add(group);
        cmeStreamers.push({
          group, mat,
          baseOp: c.earthDirected ? 0.78 : 0.46,
          startMs: c.startMs, speed: c.speed!,
        });
      }

      // planets
      const planets = planetStates3D(date0);
      const planetBodies: THREE.Mesh[] = [];
      planets.forEach((p, idx) => {
        const path = p.path.map((q) => toHelio(q));
        const isEarth = p.name === "Earth";
        const isOuter = !["Mercury", "Venus", "Earth", "Mars"].includes(p.name);
        if (showOrbits) scene.add(fatLine(path, isEarth ? BLUE : AMBER_DIM, isEarth ? 0.75 : 0.4, isEarth ? 0.07 : 0.055, true));
        const body = new THREE.Mesh(
          new THREE.SphereGeometry(isEarth ? 2.4 : isOuter ? 2.2 : 1.7, 16, 16),
          new THREE.MeshBasicMaterial({ color: isEarth ? BLUE : isOuter ? 0xffd76b : 0x8fd8cc })
        );
        scene.add(body);
        (body as any).__idx = idx;
        planetBodies.push(body);
        mkLabel(p.name.toUpperCase(), isEarth ? "var(--blue)" : "var(--cyan)", body);
      });

      // NEO orbits + markers
      const neoMarkers: Array<{mesh: THREE.Mesh;el: OrbitElements;}> = [];
      for (const o of plotted) {
        const el = elements[o.des];
        const aph = el.a * (1 + el.e);
        const sel = o.id === selRef.current;
        let trail: THREE.Object3D | null = null;
        if (showOrbits && aph < 9) {
          const path = orbitPath3D(el, 240).map((q) => toHelio(q));
          trail = fatLine(path, sel ? AMBER_BRIGHT : o.monitored ? RED : AMBER, sel ? 0.95 : o.monitored ? 0.6 : 0.4, sel ? 0.09 : o.monitored ? 0.065 : 0.05, true);
          scene.add(trail);
        }
        const mk = new THREE.Mesh(
          markerGeo(sel),
          new THREE.MeshBasicMaterial({ color: sel ? AMBER_BRIGHT : o.monitored ? RED : AMBER })
        );
        scene.add(mk);
        neoMarkers.push({ mesh: mk, el });
        pickList.current.push(mk);
        pickMap.current.set(mk, o);
        markerById.current.set(o.id, mk);
        registerGlow(mk, trail);
      }

      const craftMarkers: Array<{ mesh: THREE.Mesh; craft: SpacecraftVehicle }> = [];
      const craftSeed = (id: string) =>
        [...id].reduce((sum, ch, i) => sum + ch.charCodeAt(0) * (i + 3), 0);
      const craftPosition = (craft: SpacecraftVehicle, d: Date) => {
        const au = Math.max(0.18, craft.rangeAu ?? 2);
        const seed = craftSeed(craft.id);
        const base = seeded01(seed) * Math.PI * 2;
        const yrs = (d.getTime() - Date.parse(craft.launchDate)) / (365.25 * 86400000);
        const drift = yrs * (au < 1 ? 1.1 : au < 6 ? 0.22 : 0.025);
        const a = base + drift;
        const tilt = (seeded01(seed + 19) - 0.5) * 0.34;
        return { x: Math.cos(a) * au, y: Math.sin(a) * au, z: Math.sin(tilt) * au * 0.18 };
      };
      const craftTrajectory = (craft: SpacecraftVehicle, d: Date) => {
        const au = Math.max(0.18, craft.rangeAu ?? 2);
        const seed = craftSeed(craft.id);
        const base = seeded01(seed) * Math.PI * 2;
        const yrs = (d.getTime() - Date.parse(craft.launchDate)) / (365.25 * 86400000);
        const drift = yrs * (au < 1 ? 1.1 : au < 6 ? 0.22 : 0.025);
        const loops = au < 1 ? 5.5 : au < 6 ? 2.6 : 1.2;
        const start = Math.min(1, au * 0.72);
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 180; i++) {
          const t0 = i / 180;
          const r = start + (au - start) * Math.pow(t0, 1.06);
          const a = base + drift * t0 - (1 - t0) * loops;
          const tilt = (seeded01(seed + 19) - 0.5) * 0.34;
          pts.push(toHelio({ x: Math.cos(a) * r, y: Math.sin(a) * r, z: Math.sin(tilt) * r * 0.18 }));
        }
        return pts;
      };

      if (!isMini) {
        for (const craft of spacecraft ?? []) {
          const trail = dottedLine(craftTrajectory(craft, date0), ISSC, 0.018);
          scene.add(trail);
          const mk = new THREE.Mesh(
            new THREE.OctahedronGeometry(craft.rangeAu != null && craft.rangeAu > 20 ? 1.95 : 1.45, 0),
            new THREE.MeshBasicMaterial({ color: ISSC, transparent: true, opacity: 0.95 })
          );
          mk.position.copy(toHelio(craftPosition(craft, date0)));
          scene.add(mk);
          craftMarkers.push({ mesh: mk, craft });
          pickList.current.push(mk);
          craftPickMap.current.set(mk, craft);
          registerGlow(mk, trail);
          mkLabel(craft.shortName, "var(--green)", mk);
        }
      }

      dynUpdate.current = () => {
        const d = new Date(scrubRef.current);
        const nowMs = d.getTime();
        const ps = planetStates3D(d);
        for (const b of planetBodies) {
          const idx = (b as any).__idx as number;
          b.position.copy(toHelio(ps[idx].pos));
        }
        for (const nm of neoMarkers) nm.mesh.position.copy(toHelio(orbitPosition(nm.el, d)));
        for (const cm of craftMarkers) cm.mesh.position.copy(toHelio(craftPosition(cm.craft, d)));

        // Corona breathes; a slow idle pulse keeps the Sun alive on screen.
        const breathe = 1 + 0.05 * Math.sin(nowMs / 4.5e6);
        for (const sh of coronaShells) sh.mat.opacity = sh.base * breathe;
        solarActivity.rotation.y = nowMs / 1.8e7;
        solarActivity.rotation.z = Math.sin(nowMs / 2.8e7) * 0.18;

        // Flare bursts: particles flare up near peak time, then fade away.
        for (const fp of flareBursts) {
          const dt = Math.abs(nowMs - fp.peakMs);
          const g = dt < FLARE_GLOW_MS ? 1 - dt / FLARE_GLOW_MS : 0;
          fp.group.visible = g > 0.01;
          fp.mat.opacity = g * (fp.cls === "X" ? 0.95 : fp.cls === "M" ? 0.75 : 0.52);
          fp.group.scale.setScalar(1 + g * 0.65);
        }

        // CME streamers: grow at the DONKI bulk speed, but remain sparse enough
        // that planets and asteroid orbits stay readable through them.
        for (const pl of cmeStreamers) {
          const ageSec = (nowMs - pl.startMs) / 1000;
          if (ageSec <= 0) { pl.group.visible = false; continue; }
          const ageDays = ageSec / 86400;
          const fade = ageDays > CME_FADE_DAYS ? Math.max(0, 1 - (ageDays - CME_FADE_DAYS) / 2) : 1;
          if (fade <= 0) { pl.group.visible = false; continue; }
          const lenAu = Math.min(CME_MAX_AU, pl.speed * ageSec / AU_KM);
          if (lenAu <= 0) { pl.group.visible = false; continue; }
          pl.group.visible = true;
          pl.group.scale.setScalar(lenAu * AU_SCALE);
          pl.group.rotation.z = Math.sin(nowMs / 1.2e7 + pl.startMs * 0.000001) * 0.05;
          pl.mat.opacity = pl.baseOp * fade;
        }
      };
    } else {
      // GEO mode — Earth, Moon, satellites and NEO tracks are drawn at TRUE
      // relative scale. Earth's radius is ~1/389 of one lunar distance, so on
      // the lunar-distance grid that frames the asteroid fly-bys it is just a
      // dot. A fixed-pixel "core" point keeps each body locatable at any zoom;
      // fly the camera in close to grow the globe and resolve satellites.
      const earthR = EARTH_R;

      // single-vertex marker that holds a constant pixel size at every zoom
      const corePoint = (color: number, px: number) => {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
        return new THREE.Points(g, new THREE.PointsMaterial({ color, size: px, sizeAttenuation: false, transparent: true, opacity: 0.95 }));
      };

      // dark occluder so far-side coastlines are hidden — reads as a solid globe
      const occluder = new THREE.Mesh(
        new THREE.SphereGeometry(earthR * 0.992, 32, 24),
        new THREE.MeshBasicMaterial({ color: 0x070503 })
      );
      scene.add(occluder);

      // faint lat/long graticule
      const grat = new THREE.Mesh(
        new THREE.SphereGeometry(earthR, 24, 16),
        new THREE.MeshBasicMaterial({ color: AMBER_DIM, wireframe: true, transparent: true, opacity: 0.18 })
      );
      scene.add(grat);

      // continent coastlines
      for (const ring of CONTINENTS) {
        const pts = ring.map(([lon, lat]) => {
          const [x, y, z] = lonLatToVec3(lon, lat, earthR * 1.004);
          return new THREE.Vector3(x, y, z);
        });
        scene.add(fatLine(pts, AMBER, 0.9, earthR * 0.012, false));
      }
      scene.add(fatLine(ringPoints(earthR, 96), AMBER_BRIGHT, 0.6, earthR * 0.014, true));
      const earthCore = corePoint(AMBER_BRIGHT, 5);
      scene.add(earthCore);
      const earthLabelAnchor = new THREE.Object3D();
      scene.add(earthLabelAnchor);
      mkLabel("EARTH", "var(--amber-bright)", earthLabelAnchor);

      // range shells (lunar-distance rings on the ecliptic plane)
      for (const ld of GEO_RINGS) {
        scene.add(dimLine(ringPoints(ld * LD_SCALE), ld === 1 ? AMBER : AMBER_DIM, ld === 1 ? 0.45 : 0.18, true));
      }
      const ax = GEO_RINGS[GEO_RINGS.length - 1] * LD_SCALE;
      scene.add(dimLine([new THREE.Vector3(-ax, 0, 0), new THREE.Vector3(ax, 0, 0)], AMBER_DIM, 0.2));
      scene.add(dimLine([new THREE.Vector3(0, 0, -ax), new THREE.Vector3(0, 0, ax)], AMBER_DIM, 0.2));

      // Live satellites from CelesTrak GP elements (cyan/green points — visually
      // distinct from the amber/red asteroid diamonds). Loaded lazily on zoom-in.
      // The ISS gets its own distinctive icon, so it is held out of the dot
      // cloud (each remaining dot represents ~10 active satellites).
      const fullList = satsRef.current;
      const issSat = fullList.find((s) => s.noradId === ISS_NORAD) ?? null;
      const satList = fullList.filter((s) => s.noradId !== ISS_NORAD);
      let satPoints: THREE.Points | null = null;
      let issAnchor: THREE.Object3D | null = null;
      if (satList.length) {
        const pos = new Float32Array(satList.length * 3);
        const col = new Float32Array(satList.length * 3);
        satList.forEach((s, k) => {
          const c = new THREE.Color(SAT_COLORS[s.cat] ?? SAT_COLORS.other);
          col[k * 3] = c.r;col[k * 3 + 1] = c.g;col[k * 3 + 2] = c.b;
        });
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        // Fixed-pixel dots: satellites read as small flecks at any zoom instead
        // of swelling into spheres that swallow the true-scale globe.
        satPoints = new THREE.Points(g, new THREE.PointsMaterial({ size: 2.4, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.95 }));
        scene.add(satPoints);
      }
      if (issSat) {
        // Distinctive ISS marker — a bright green octahedron ringed by a
        // crosshair so the station stands out from the satellite flecks.
        issAnchor = new THREE.Object3D();
        const issMat = new THREE.MeshBasicMaterial({ color: ISSC });
        const core = new THREE.Mesh(new THREE.OctahedronGeometry(MOON_R * 0.9, 0), issMat);
        issAnchor.add(core);
        issAnchor.add(corePoint(ISSC, 5));
        const ringR = MOON_R * 2.4;
        issAnchor.add(dimLine(ringPoints(ringR, 48), ISSC, 0.9, true));
        const cross: THREE.Vector3[] = [
          new THREE.Vector3(-ringR * 1.5, 0, 0), new THREE.Vector3(ringR * 1.5, 0, 0),
          new THREE.Vector3(0, 0, -ringR * 1.5), new THREE.Vector3(0, 0, ringR * 1.5)];
        const crossGeo = new THREE.BufferGeometry().setFromPoints(cross);
        issAnchor.add(new THREE.LineSegments(crossGeo, new THREE.LineBasicMaterial({ color: ISSC, transparent: true, opacity: 0.7 })));
        scene.add(issAnchor);
        mkLabel("◆ ISS", "var(--green)", issAnchor);
      }

      // Moon marker + orbit ring at its real geocentric distance
      const moonLd = moonDistanceLd(date0);
      scene.add(dimLine(ringPoints(moonLd * LD_SCALE, 120), MOONC, 0.22, true));
      const moon = new THREE.Mesh(new THREE.SphereGeometry(MOON_R, 16, 16), new THREE.MeshBasicMaterial({ color: MOONC }));
      moon.add(corePoint(MOONC, 3));
      scene.add(moon);
      mkLabel("MOON", "var(--moon, #cfd6e6)", moon);

      // NEO geocentric approach tracks across the close-approach window
      const neoTracks: Array<{mesh: THREE.Mesh;el: OrbitElements;}> = [];
      const samples = 140;
      const halfWin = 14 * 86400000;
      for (const o of plotted) {
        const el = elements[o.des];
        const sel = o.id === selRef.current;
        const tStart = Math.max(windowMin, o.epochMs - halfWin);
        const tEnd = Math.min(windowMax, o.epochMs + halfWin);
        const pts: THREE.Vector3[] = [];
        for (let s = 0; s <= samples; s++) {
          const t0 = tStart + (tEnd - tStart) * s / samples;
          const d = new Date(t0);
          const helio = orbitPosition(el, d);
          const earth = earthPosition(d);
          const geo = { x: helio.x - earth.x, y: helio.y - earth.y, z: helio.z - earth.z };
          pts.push(toThree(geo, GEO_AU));
        }
        const trail = fatLine(pts, sel ? AMBER_BRIGHT : o.monitored ? RED : AMBER, sel ? 0.95 : o.monitored ? 0.7 : 0.46, sel ? 0.045 : o.monitored ? 0.03 : 0.022);
        scene.add(trail);
        const mk = new THREE.Mesh(
          markerGeo(sel),
          new THREE.MeshBasicMaterial({ color: sel ? AMBER_BRIGHT : o.monitored ? RED : AMBER })
        );
        scene.add(mk);
        neoTracks.push({ mesh: mk, el });
        pickList.current.push(mk);
        pickMap.current.set(mk, o);
        markerById.current.set(o.id, mk);
        registerGlow(mk, trail);
      }

      dynUpdate.current = () => {
        const d = new Date(scrubRef.current);
        const earth = earthPosition(d);
        const maxShell = GEO_RINGS[GEO_RINGS.length - 1] * LD_SCALE * 1.35;
        for (const nt of neoTracks) {
          const helio = orbitPosition(nt.el, d);
          nt.mesh.position.copy(toThree({ x: helio.x - earth.x, y: helio.y - earth.y, z: helio.z - earth.z }, GEO_AU));
          nt.mesh.visible = nt.mesh.position.length() <= maxShell;
        }
        const lon = moonEclipticLongitude(d);
        const mLd = moonDistanceLd(d);
        moon.position.copy(toThree({ x: Math.cos(lon) * mLd / AU_TO_LD, y: Math.sin(lon) * mLd / AU_TO_LD, z: 0 }, GEO_AU));
        // Satellites — two-body propagation of real CelesTrak elements to the
        // scrubbed instant, mapped from geocentric ecliptic km to scene units.
        if (satPoints) {
          const attr = satPoints.geometry.getAttribute("position") as THREE.BufferAttribute;
          for (let k = 0; k < satList.length; k++) {
            const p = satEclipticKm(satList[k], d);
            attr.setXYZ(k, p.x * GEO_KM, p.z * GEO_KM, -p.y * GEO_KM);
          }
          attr.needsUpdate = true;
        }
        if (issAnchor && issSat) {
          const p = satEclipticKm(issSat, d);
          issAnchor.position.set(p.x * GEO_KM, p.z * GEO_KM, -p.y * GEO_KM);
        }
        // Satellites only make sense near Earth — hide the dot cloud and the ISS
        // marker once the operator pulls back out to the lunar-distance field.
        const showSats = cam.current.radius < 10.5;
        if (satPoints) satPoints.visible = showSats;
        if (issAnchor) {
          issAnchor.visible = showSats;
          // Keep the ISS reticle at a constant on-screen size (~10× a satellite
          // fleck) instead of ballooning as the camera flies in.
          const camT = three.current?.camera;
          if (camT) {
            const dd = camT.position.distanceTo(issAnchor.position);
            issAnchor.scale.setScalar(Math.max(dd, 0.001) * 0.22);
          }
        }
      };
    }
  }, [mode, plotted, elements, windowMin, windowMax, selectedId, isMini, satellites, cmes, flares, spacecraft, showOrbits, showCmes, showFlares, showSolar]);

  const labelList = useMemo(
    // Heliocentric map shows icons only — no asteroid name labels.
    () => isMini || mode === "HELIO" ? [] : plotted.filter((o) => o.monitored || o.id === selectedId),
    [plotted, selectedId, isMini, mode]
  );

  if (isMini) {
    return (
      <button
        type="button"
        data-sfx="saber"
        onClick={onActivate}
        ref={(n) => {wrapRef.current = n as unknown as HTMLDivElement;}}
        className="group relative block h-full w-full overflow-hidden"
        style={{ cursor: "pointer" }}
        aria-label="Promote this view to the main map">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {rendererError && (
          <div className="absolute inset-0 flex items-center justify-center bg-[rgba(5,4,10,0.62)] text-[10px] text-[var(--amber-dim)]">
            ▸ 3D CONTEXT UNAVAILABLE
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-[rgba(240,179,42,0)] transition-colors group-hover:bg-[rgba(240,179,42,0.06)]" />
        <div className="pointer-events-none absolute bottom-1.5 left-2 text-[9px] tracking-wide text-[var(--text-dim)] opacity-0 transition-opacity group-hover:opacity-100">
          ▸ CLICK TO PROMOTE
        </div>
      </button>);

  }

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ cursor: "grab", touchAction: "none" }} />
      {rendererError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-[rgba(5,4,10,0.62)] text-center text-[12px] text-[var(--amber-dim)]">
          <div className="text-[var(--orange)] glow-text">▸ 3D MAP OFFLINE</div>
          <div>WEBGL CONTEXT UNAVAILABLE</div>
        </div>
      )}
      <div ref={bodyHost} className="pointer-events-none absolute inset-0 overflow-hidden" />
      <div ref={labelHost} className="pointer-events-none absolute inset-0 overflow-hidden">
        {labelList.map((o) =>
        <span
          key={o.id}
          ref={(n) => {
            if (n) labelNodes.current.set(o.id, n);else
            labelNodes.current.delete(o.id);
          }}
          className="absolute left-0 top-0 whitespace-nowrap text-[12px] leading-none"
          style={{
            display: "none",
            color: o.monitored ? "var(--red)" : o.des === selectedDes ? "var(--amber-bright)" : "var(--amber)",
            textShadow: "0 0 6px currentColor",
            letterSpacing: "0.04em",
            marginLeft: 10,
            marginTop: -5
          }}>
          {o.des === selectedDes ? `${o.des} · ${o.distLd.toFixed(2)}LD` : o.des}
        </span>
        )}
      </div>
      {plotted.length === 0 &&
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-[var(--amber-dim)]">
          ▸ RESOLVING SBDB ORBITAL ELEMENTS…
        </div>
      }
      <div className="pointer-events-none absolute bottom-2 left-2 text-[10px] tracking-wide text-[var(--text-dim)]">
        DRAG · ORBIT &nbsp;|&nbsp; SCROLL · ZOOM
        {mode === "GEO" ?
        <> &nbsp;|&nbsp; TRUE SCALE &nbsp;|&nbsp; {(satellites?.length ?? 0) > 0 ?
          <span><span className="text-[var(--cyan)]">◇ SATELLITES</span> CELESTRAK · <span className="text-[var(--amber)]">◆ ASTEROIDS</span> JPL</span> :
          <span>ZOOM IN ▸ TRACK SATELLITES</span>}</> :
        <> &nbsp;|&nbsp; <span className="text-[var(--orange)]">• CME PARTICLES</span> DONKI &nbsp;|&nbsp; <span className="text-[var(--green)]">◇ SPACECRAFT</span> HOVER · TRAJECTORY</>}
      </div>
    </div>);

}
