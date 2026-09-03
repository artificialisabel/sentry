import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CadResponse, ElementsResponse, NeoObject, OrbitElements, SatCat, SatElements, SatResponse, SbdbResponse, SpaceWeatherResponse, SpacecraftResponse } from "../lib/types";
import { Scene3D } from "./Scene3D";
import type { SceneLayers } from "./Scene3D";
import { DataFeed } from "./DataFeed";
import { DetailPanel } from "./DetailPanel";
import { TimeScrubber } from "./TimeScrubber";
import { spaceWeatherStatus } from "./SpaceWeather";
import { SpacecraftPanel } from "./SpacecraftPanel";
import { SpacecraftModelView } from "./SpacecraftModelView";
import { fmtUTC, fmtDuration } from "../lib/format";
import { audio, installUiSounds } from "../lib/audio";

// Earth's mean radius expressed in lunar distances — used to decide whether a
// modelled close approach actually intersects the planet (i.e. an impact).
const EARTH_RADIUS_LD = 6371.0 / 384400;
const SAT_LEGEND: Array<{cat: SatCat;color: string;label: string;}> = [
{ cat: "starlink", color: "#39d6c8", label: "STARLINK" },
{ cat: "oneweb", color: "#5f7bff", label: "ONEWEB" },
{ cat: "weather", color: "#cfd6e6", label: "WEATHER" },
{ cat: "gps", color: "#54ff8a", label: "GPS / GNSS" },
{ cat: "geo", color: "#ff8a3c", label: "GEO BELT" },
{ cat: "other", color: "#8a93b5", label: "OTHER" }];

const EMPTY_COUNTS: Record<SatCat, number> = { starlink: 0, oneweb: 0, weather: 0, gps: 0, geo: 0, other: 0 };
const HELIO_LAYER_BUTTONS: Array<{ key: keyof SceneLayers; label: string; mark: string; color: string; hint?: string; }> = [
  { key: "orbits", label: "ORB", mark: "◎", color: "var(--amber)" },
  { key: "cmes", label: "CME", mark: "•", color: "var(--orange)", hint: "CME shows NASA DONKI coronal-mass-ejection particle streamers moving through the inner heliosphere." },
  { key: "flares", label: "FLR", mark: "✦", color: "var(--red)", hint: "FLR shows DONKI solar-flare bursts at their reported active-region bearings on the Sun." },
  { key: "solar", label: "SOL", mark: "☉", color: "var(--green)", hint: "SOL adds the stylised solar surface particles, corona, and magnetic-loop activity around the Sun." },
];


// Rounded label tag used for every panel title (matches the reference chrome).
function TitleTag({ children }: {children: React.ReactNode;}) {
  return <span className="title-tag">{children}</span>;
}

function CollapseButton({ collapsed, onToggle, label }: { collapsed: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      data-sfx="select"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className="collapse-marker absolute right-2 top-2 z-30"
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}>
      {collapsed ? "▸" : "▾"}
    </button>
  );
}

// Small crosshair glyph dropped at divider junctions / frame corners.
const PLUS_POS: Record<string, string> = {
  tl: "left-0 top-0 -translate-x-1/2 -translate-y-1/2",
  tr: "right-0 top-0 translate-x-1/2 -translate-y-1/2",
  bl: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2",
  br: "right-0 bottom-0 translate-x-1/2 translate-y-1/2"
};
function Plus({ at }: {at: "tl" | "tr" | "bl" | "br";}) {
  return (
    <span className={`pointer-events-none absolute z-30 select-none text-[13px] leading-none text-[var(--amber)] glow-text ${PLUS_POS[at]}`}>+</span>);

}

type Mode = "GEO" | "HELIO" | "VEHICLES";
type PanelKey = "mini" | "radar" | "feed";
type ResizeKind = "desktop-left" | "desktop-mini" | "desktop-radar" | "mobile-main" | "mobile-left";
type PanelSizes = { left: number; mini: number; radar: number; mobileMain: number; mobileLeft: number };

const PANEL_MIN = 38;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function resizeLimits(
  kind: ResizeKind,
  width: number,
  height: number,
  sizes: PanelSizes,
  collapsed: Record<PanelKey, boolean>
) {
  if (kind === "desktop-left") return { min: 220, max: Math.max(260, width - 360) };
  if (kind === "desktop-mini") {
    const radarMin = collapsed.radar ? PANEL_MIN : 112;
    const feedMin = collapsed.feed ? PANEL_MIN : 132;
    return { min: 74, max: Math.max(74, height - radarMin - feedMin) };
  }
  if (kind === "desktop-radar") {
    const miniHeight = collapsed.mini ? PANEL_MIN : sizes.mini;
    const feedMin = collapsed.feed ? PANEL_MIN : 132;
    return { min: 86, max: Math.max(86, height - miniHeight - feedMin) };
  }
  if (kind === "mobile-main") return { min: 36, max: 74 };
  return { min: 32, max: 68 };
}

export function App() {
  const [data, setData] = useState<CadResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<NeoObject | null>(null);
  const [sbdb, setSbdb] = useState<SbdbResponse | null>(null);
  const [sbdbLoading, setSbdbLoading] = useState(false);
  const [events, setEvents] = useState<string[]>(["▸ BOOT · CNEOS UPLINK INIT"]);
  const [scrubberMs, setScrubberMs] = useState(Date.now());
  const [playing, setPlaying] = useState(false);
  const [elements, setElements] = useState<Record<string, OrbitElements>>({});
  const [mode, setMode] = useState<Mode>("GEO");
  const [sats, setSats] = useState<SatElements[]>([]);
  const [satCounts, setSatCounts] = useState<Record<SatCat, number>>(EMPTY_COUNTS);
  const [satTotal, setSatTotal] = useState(0);
  const [satLoading, setSatLoading] = useState(false);
  const [dotScale, setDotScale] = useState(10);
  const [satCached, setSatCached] = useState<number | null>(null);
  const satReq = useRef(false);
  const [sw, setSw] = useState<SpaceWeatherResponse | null>(null);
  const [spacecraft, setSpacecraft] = useState<SpacecraftResponse | null>(null);
  const [spacecraftLoading, setSpacecraftLoading] = useState(false);
  const [selectedCraftId, setSelectedCraftId] = useState<string | null>(null);
  const [helioLayers, setHelioLayers] = useState<SceneLayers>({ orbits: true, cmes: true, flares: true, solar: true });
  const [helioLayerHint, setHelioLayerHint] = useState<string | null>(null);
  const [soundOn, setSoundOn] = useState(true);
  const [sfxReady, setSfxReady] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<PanelKey, boolean>>({ mini: false, radar: false, feed: false });
  const [panelSizes, setPanelSizes] = useState<PanelSizes>({ left: 300, mini: 190, radar: 210, mobileMain: 60, mobileLeft: 50 });
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const sbdbCache = useRef<Map<string, SbdbResponse>>(new Map());

  const log = useCallback((s: string) => setEvents((e) => [...e.slice(-40), s]), []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const updateGridSize = () => {
      const { width, height } = grid.getBoundingClientRect();
      setGridSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    updateGridSize();
    const observer = new ResizeObserver(updateGridSize);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  // Bring the console to life with retro-futurist audio: a spacecraft ambient
  // drone plus generated UI blips wired to every control via event delegation.
  useEffect(() => {
    installUiSounds();
    let alive = true;
    fetch("/app-api/sfx").
    then((r) => r.json()).
    then((d: {enabled?: boolean;sfx?: Record<string, string>;}) => {
      if (!alive) return;
      if (d?.enabled && d.sfx && Object.keys(d.sfx).length > 0) {
        audio.load(d.sfx);
        setSfxReady(true);
        log("▸ AUDIO UPLINK · SFX SYNTH ONLINE · AMBIENT ARMED");
      } else {
        log("▸ AUDIO OFFLINE · SFX TOOL DISABLED");
      }
    }).
    catch(() => {if (alive) log("▸ AUDIO UPLINK ERR");});
    return () => {alive = false;};
  }, [log]);

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      audio.setOn(next);
      return next;
    });
  }, []);

  const toggleHelioLayer = useCallback((key: keyof SceneLayers) => {
    setHelioLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const togglePanel = useCallback((panel: PanelKey) => {
    setCollapsed((prev) => ({ ...prev, [panel]: !prev[panel] }));
  }, []);

  const beginResize = useCallback((kind: ResizeKind) => (event: React.PointerEvent<HTMLDivElement>) => {
    const grid = gridRef.current;
    if (!grid) return;
    event.preventDefault();
    if (kind === "desktop-mini") setCollapsed((prev) => ({ ...prev, mini: false }));
    if (kind === "desktop-radar") setCollapsed((prev) => ({ ...prev, radar: false }));

    document.body.classList.add("resizing-panels");
    const move = (pointerEvent: PointerEvent) => {
      const rect = grid.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setPanelSizes((prev) => {
        if (kind === "desktop-left") {
          return { ...prev, left: clamp(pointerEvent.clientX - rect.left, 220, Math.max(260, rect.width - 360)) };
        }
        if (kind === "desktop-mini") {
          const radarMin = collapsed.radar ? PANEL_MIN : 112;
          const feedMin = collapsed.feed ? PANEL_MIN : 132;
          const max = Math.max(74, rect.height - radarMin - feedMin);
          return { ...prev, mini: clamp(pointerEvent.clientY - rect.top, 74, max) };
        }
        if (kind === "desktop-radar") {
          const miniHeight = collapsed.mini ? PANEL_MIN : prev.mini;
          const feedMin = collapsed.feed ? PANEL_MIN : 132;
          const max = Math.max(86, rect.height - miniHeight - feedMin);
          return { ...prev, radar: clamp(pointerEvent.clientY - rect.top - miniHeight, 86, max) };
        }
        if (kind === "mobile-main") {
          return { ...prev, mobileMain: clamp((pointerEvent.clientY - rect.top) / rect.height * 100, 36, 74) };
        }
        return { ...prev, mobileLeft: clamp((pointerEvent.clientX - rect.left) / rect.width * 100, 32, 68) };
      });
    };
    const end = () => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, [collapsed]);

  const resizeWithKeyboard = useCallback((kind: ResizeKind) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    const vertical = kind === "desktop-left" || kind === "mobile-left";
    const decreaseKey = vertical ? "ArrowLeft" : "ArrowUp";
    const increaseKey = vertical ? "ArrowRight" : "ArrowDown";
    if (event.key !== decreaseKey && event.key !== increaseKey && event.key !== "Home" && event.key !== "End") return;

    const grid = gridRef.current;
    if (!grid) return;
    event.preventDefault();
    if (kind === "desktop-mini") setCollapsed((prev) => ({ ...prev, mini: false }));
    if (kind === "desktop-radar") setCollapsed((prev) => ({ ...prev, radar: false }));

    const { width, height } = grid.getBoundingClientRect();
    setPanelSizes((prev) => {
      const { min, max } = resizeLimits(kind, width, height, prev, collapsed);
      const step = kind === "mobile-main" || kind === "mobile-left" ? 2 : 10;
      const delta = event.key === decreaseKey ? -step : step;
      const next = (current: number) => event.key === "Home" ? min : event.key === "End" ? max : clamp(current + delta, min, max);

      if (kind === "desktop-left") return { ...prev, left: next(prev.left) };
      if (kind === "desktop-mini") return { ...prev, mini: next(prev.mini) };
      if (kind === "desktop-radar") return { ...prev, radar: next(prev.radar) };
      if (kind === "mobile-main") return { ...prev, mobileMain: next(prev.mobileMain) };
      return { ...prev, mobileLeft: next(prev.mobileLeft) };
    });
  }, [collapsed]);

  useEffect(() => {
    let alive = true;
    fetch("/app-api/cad").
    then((r) => r.json()).
    then((d: CadResponse) => {
      if (!alive) return;
      if (!d.ok) {setStatus("error");setErr(d.error || "uplink failed");return;}
      setData(d);
      setStatus("ready");
      const mid = Math.min(Math.max(Date.now(), d.windowMin), d.windowMax);
      setScrubberMs(mid);
      if (d.cached) {
        const age = d.cachedAt ? new Date(d.cachedAt).toISOString().slice(0, 16).replace("T", " ") : "";
        log(`▸ CNEOS OFFLINE · SERVING CACHED ENCOUNTERS ${age}Z`);
      }
      log(`▸ CAD WINDOW ${new Date(d.windowMin).toISOString().slice(0, 10)} → ${new Date(d.windowMax).toISOString().slice(0, 10)}`);
      log(`▸ ${d.count} CLOSE APPROACHES · ${d.objects.filter((o) => o.monitored).length} ON SENTRY WATCH`);

      // Pull real orbital elements for the most relevant objects so the 3D
      // plots can draw genuine paths (Sentry-monitored first, then nearest passes).
      const ranked = [...d.objects].sort((a, b) => {
        if (a.monitored !== b.monitored) return a.monitored ? -1 : 1;
        return a.distLd - b.distLd;
      });
      const desList = [...new Set(ranked.map((o) => o.des))].slice(0, 22);
      log(`▸ SBDB BATCH · ${desList.length} ORBIT QUERIES`);
      fetch(`/app-api/elements?des=${encodeURIComponent(desList.join(","))}`).
      then((r) => r.json()).
      then((e: ElementsResponse) => {
        if (!alive) return;
        const n = Object.keys(e.elements ?? {}).length;
        setElements(e.elements ?? {});
        log(`▸ ${n} ORBITS RESOLVED · 3D PLOT READY`);
      }).
      catch(() => {if (alive) log("▸ SBDB BATCH ERR");});
    }).
    catch((e) => {if (alive) {setStatus("error");setErr(String(e));}});
    return () => {alive = false;};
  }, [log]);

  // Space weather (NASA DONKI via CCMC) — one cached request on boot feeds the
  // right-hand console column and the heliocentric CME plumes / flare flashes.
  useEffect(() => {
    let alive = true;
    fetch("/app-api/spaceweather").
    then((r) => r.json()).
    then((d: SpaceWeatherResponse) => {
      if (!alive) return;
      if (!d.ok) {log("▸ DONKI UPLINK ERR");return;}
      setSw(d);
      if (d.cached) {
        const age = d.cachedAt ? new Date(d.cachedAt).toISOString().slice(0, 16).replace("T", " ") : "";
        log(`▸ DONKI OFFLINE · SERVING CACHED SOLAR LOG ${age}Z`);
      }
      log(`▸ DONKI · ${d.cmes.length} CME · ${d.flares.length} FLR · ${d.storms.length} GST`);
      const earthDir = d.cmes.filter((c) => c.earthDirected).length;
      if (earthDir) log(`▸ ${earthDir} EARTH-DIRECTED CME${earthDir > 1 ? "S" : ""} · ENLIL FLAGGED`);
    }).
    catch(() => {if (alive) log("▸ DONKI UPLINK ERR");});
    return () => {alive = false;};
  }, [log]);

  // The spacecraft archive is a curated NASA/JPL roster with public model and
  // reference links. Loading it independently keeps asteroid tracking usable
  // if one of the archive sources is temporarily unavailable.
  useEffect(() => {
    let alive = true;
    setSpacecraftLoading(true);
    fetch("/app-api/spacecraft").
    then((r) => r.json()).
    then((d: SpacecraftResponse) => {
      if (!alive) return;
      setSpacecraftLoading(false);
      if (!d.ok) {log("▸ SPACECRAFT DATA ERR");return;}
      setSpacecraft(d);
      const imageHits = d.requests.reduce((sum, request) =>
        sum + (request.label.startsWith("NASA Images") ? request.count : 0), 0);
      if (d.cached) {
        const age = d.cachedAt ? new Date(d.cachedAt).toISOString().slice(0, 16).replace("T", " ") : "";
        log(`▸ SPACECRAFT DATA CACHED · ${age}Z`);
      }
      log(`▸ NASA SPACECRAFT DATA · ${d.vehicles.length} CRAFT · ${imageHits} IMAGE RECORDS`);
    }).
    catch(() => {if (alive) {setSpacecraftLoading(false);log("▸ SPACECRAFT DATA ERR");}});
    return () => {alive = false;};
  }, [log]);

  // play loop
  useEffect(() => {
    if (!playing || !data) return;
    let raf = 0;let last = performance.now();
    const span = data.windowMax - data.windowMin;
    const loop = (t: number) => {
      const dt = t - last;last = t;
      setScrubberMs((v) => {
        let nv = v + span / 50000 * dt; // full window in ~50s
        if (nv > data.windowMax) nv = data.windowMin;
        return nv;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, data]);

  const onSelect = useCallback((o: NeoObject) => {
    setSelected(o);
    const cached = sbdbCache.current.get(o.des);
    if (cached) {setSbdb(cached);setSbdbLoading(false);return;}
    setSbdb(null);setSbdbLoading(true);
    log(`▸ SBDB QUERY · ${o.des}`);
    fetch(`/app-api/sbdb?des=${encodeURIComponent(o.des)}`).
    then((r) => r.json()).
    then((d: SbdbResponse) => {
      sbdbCache.current.set(o.des, d);
      setSbdb(d);setSbdbLoading(false);
      log(`▸ SBDB ${d.ok ? "OK" : "MISS"} · ${o.des} · ${d.request?.count ?? 0} ELEM`);
      // Make sure the selected orbit is plottable in 3D even if it was not in
      // the initial batch.
      if (d.ok && d.a != null && d.e != null && d.i != null && d.om != null && d.w != null && d.ma != null && d.epochJD != null) {
        setElements((prev) => prev[o.des] ? prev : { ...prev, [o.des]: { a: d.a!, e: d.e!, i: d.i!, om: d.om!, w: d.w!, ma: d.ma!, epochJD: d.epochJD! } });
      }
    }).
    catch(() => {setSbdbLoading(false);log(`▸ SBDB ERR · ${o.des}`);});
  }, [log]);

  // Lazy CelesTrak fetch — only when the operator zooms into Earth's
  // neighbourhood in the geocentric view (one request ever; server caches 1wk).
  const loadSats = useCallback(() => {
    if (satReq.current) return;
    satReq.current = true;
    setSatLoading(true);
    log("▸ CELESTRAK GP UPLINK · SATELLITE CATALOGUE");
    fetch("/app-api/sats").
    then((r) => r.json()).
    then((d: SatResponse) => {
      if (!d.ok || d.sats.length === 0) {
        log(`▸ CELESTRAK ERR${d.error ? ` · ${d.error.toUpperCase()}` : ""}`);
        setSatLoading(false);
        satReq.current = false; // allow a retry on next zoom-in
        return;
      }
      setSats(d.sats);
      audio.play("glitch"); // satellites snapping into the geocentric view
      setSatCounts(d.counts ?? EMPTY_COUNTS);
      setSatTotal(d.total ?? d.sats.length);
      setDotScale(d.dotScale ?? 10);
      setSatCached(d.cached ? d.cachedAt ?? Date.now() : null);
      setSatLoading(false);
      if (d.cached) {
        const age = d.cachedAt ? new Date(d.cachedAt).toISOString().slice(0, 16).replace("T", " ") : "";
        log(`▸ CELESTRAK OFFLINE · SERVING CACHED SNAPSHOT ${age}Z`);
      }
      log(`▸ ${(d.total ?? d.sats.length).toLocaleString()} ACTIVE SATELLITES · ${d.sats.length} DOTS · TWO-BODY PROPAGATION`);
    }).
    catch(() => {log("▸ CELESTRAK ERR");setSatLoading(false);satReq.current = false;});
  }, [log]);

  const swStatus = useMemo(() => spaceWeatherStatus(sw, scrubberMs), [sw, scrubberMs]);
  const otherMode: "GEO" | "HELIO" = mode === "GEO" ? "HELIO" : "GEO";
  const monitoredCount = data ? data.objects.filter((o) => o.monitored).length : 0;
  const plottedCount = useMemo(
    () => data ? data.objects.filter((o) => elements[o.des]).length : 0,
    [data, elements]
  );
  const previewCraft = spacecraft?.vehicles.find((vehicle) => vehicle.id === selectedCraftId) ?? spacecraft?.vehicles[0] ?? null;

  // Next approach = the soonest close encounter still ahead of the active clock
  // (falls back to the most recent if every pass in the window is behind us).
  const nextApproach = useMemo(() => {
    if (!data || data.objects.length === 0) return null;
    const future = data.objects.
    filter((o) => o.epochMs >= scrubberMs).
    sort((a, b) => a.epochMs - b.epochMs);
    if (future.length) return future[0];
    return [...data.objects].sort((a, b) => b.epochMs - a.epochMs)[0] ?? null;
  }, [data, scrubberMs]);

  const gridStyle = useMemo(() => ({
    "--panel-left": `${panelSizes.left}px`,
    "--panel-mini": collapsed.mini ? `${PANEL_MIN}px` : `${panelSizes.mini}px`,
    "--panel-radar": collapsed.radar ? `${PANEL_MIN}px` : collapsed.feed ? `minmax(${panelSizes.radar}px, 1fr)` : `${panelSizes.radar}px`,
    "--panel-feed": collapsed.feed ? `${PANEL_MIN}px` : "minmax(132px, 1fr)",
    "--mobile-main": `${panelSizes.mobileMain}%`,
    "--mobile-left": `${panelSizes.mobileLeft}%`,
    "--mobile-mini": collapsed.mini ? `${PANEL_MIN}px` : "minmax(96px, 1fr)",
    "--mobile-radar": collapsed.radar ? `${PANEL_MIN}px` : "minmax(96px, 1fr)",
  }) as React.CSSProperties, [collapsed, panelSizes]);

  const resizeA11y = useMemo(() => {
    const width = gridSize.width || panelSizes.left + 360;
    const height = gridSize.height || panelSizes.mini + panelSizes.radar + 132;
    const metric = (kind: ResizeKind, rawValue: number, unit: "pixels" | "percent", collapsedPanel = false) => {
      const limits = resizeLimits(kind, width, height, panelSizes, collapsed);
      const value = collapsedPanel ? PANEL_MIN : rawValue;
      const min = collapsedPanel ? PANEL_MIN : limits.min;
      return {
        min,
        max: Math.max(min, limits.max, value),
        now: value,
        text: collapsedPanel ? `Collapsed; ${Math.round(rawValue)} ${unit} when expanded` : `${Math.round(value)} ${unit}`,
      };
    };
    return {
      desktopLeft: metric("desktop-left", panelSizes.left, "pixels"),
      desktopMini: metric("desktop-mini", panelSizes.mini, "pixels", collapsed.mini),
      desktopRadar: metric("desktop-radar", panelSizes.radar, "pixels", collapsed.radar),
      mobileMain: metric("mobile-main", panelSizes.mobileMain, "percent"),
      mobileLeft: metric("mobile-left", panelSizes.mobileLeft, "percent"),
    };
  }, [collapsed, gridSize, panelSizes]);

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)] p-2 text-[var(--amber)]">
      {/* body — one console frame, panels split by hairline dividers + crosshairs */}
      <div ref={gridRef} className="console-grid relative min-h-0 flex-1 border border-[var(--line)]" style={gridStyle}>
        {/* frame corners */}
        <Plus at="tl" /><Plus at="tr" /><Plus at="bl" /><Plus at="br" />
        {/* First inactive map. In craft mode this is the geocentric view. */}
        <section className="area-mini relative flex min-h-0 flex-col overflow-hidden border-b border-r border-[var(--line)]">
            <div className="absolute left-2 top-2 z-20">
              <TitleTag>{otherMode === "GEO" ? "GEOCENTRIC" : "HELIOCENTRIC"}</TitleTag>
            </div>
            <CollapseButton collapsed={collapsed.mini} onToggle={() => togglePanel("mini")} label={`${otherMode} map`} />
            <Plus at="bl" /><Plus at="br" />
            {!collapsed.mini &&
            <div className="min-h-0 flex-1">
              {status === "ready" && data ?
            <Scene3D
              objects={data.objects}
              elements={elements}
              windowMin={data.windowMin}
              windowMax={data.windowMax}
              scrubberMs={scrubberMs}
              selectedId={selected?.id ?? null}
              selectedDes={selected?.des ?? null}
              onSelect={onSelect}
              mode={otherMode}
              variant="mini"
              onActivate={() => setMode(otherMode)} /> :
            <div className="flex h-full items-center justify-center text-[11px] text-[var(--amber-dim)]">▸ STANDBY</div>}
            </div>
            }
          </section>
          <section className="area-radar relative flex min-h-0 flex-col overflow-hidden border-r border-[var(--line)] md:border-b">
            <div className="absolute left-2 top-2 z-20">
              <TitleTag>{mode === "VEHICLES" ? "HELIOCENTRIC" : "CRAFT"}</TitleTag>
            </div>
            <CollapseButton collapsed={collapsed.radar} onToggle={() => togglePanel("radar")} label={mode === "VEHICLES" ? "heliocentric panel" : "craft panel"} />
            <Plus at="bl" /><Plus at="br" />
            {!collapsed.radar &&
            <div className="relative min-h-0 flex-1">
              {mode === "VEHICLES" && status === "ready" && data ?
                <Scene3D
                  objects={data.objects}
                  elements={elements}
                  windowMin={data.windowMin}
                  windowMax={data.windowMax}
                  scrubberMs={scrubberMs}
                  selectedId={selected?.id ?? null}
                  selectedDes={selected?.des ?? null}
                  onSelect={onSelect}
                  mode="HELIO"
                  variant="mini"
                  cmes={sw?.cmes}
                  flares={sw?.flares}
                  layers={helioLayers}
                  spacecraft={spacecraft?.vehicles}
                  onActivate={() => setMode("HELIO")} /> :
                <SpacecraftModelView
                  vehicle={previewCraft}
                  loading={spacecraftLoading}
                  compact
                  onActivate={() => {
                    if (previewCraft) setSelectedCraftId(previewCraft.id);
                    setMode("VEHICLES");
                  }} />}
            </div>
            }
          </section>
          <section className="area-feed relative flex min-h-0 flex-col overflow-hidden border-[var(--line)] md:border-r">
            <div className="px-2 pt-2">
              <TitleTag>SOURCE / OBJECT FEED</TitleTag>
            </div>
            <CollapseButton collapsed={collapsed.feed} onToggle={() => togglePanel("feed")} label="source object feed" />
            {!collapsed.feed &&
            <div className="min-h-0 flex-1 p-2">
              <DataFeed
                data={data}
                events={events}
                onSelect={onSelect}
                selectedId={selected?.id ?? null}
                sats={sats}
                spacecraft={spacecraft}
                selectedCraftId={selectedCraftId} />
            </div>
            }
          </section>

        {/* main map: interactive 3D scene */}
        <div className="area-main relative flex min-h-0 flex-col border-b border-[var(--line)] md:border-b-0">
          <section className="relative flex min-h-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              {mode === "VEHICLES" &&
              <SpacecraftPanel
                data={spacecraft}
                loading={spacecraftLoading}
                nowMs={scrubberMs}
                selectedId={selectedCraftId}
                onSelectedIdChange={setSelectedCraftId} />
              }
              {mode !== "VEHICLES" && status === "ready" && data &&
              <Scene3D
                objects={data.objects}
                elements={elements}
                windowMin={data.windowMin}
                windowMax={data.windowMax}
                scrubberMs={scrubberMs}
                selectedId={selected?.id ?? null}
                selectedDes={selected?.des ?? null}
                onSelect={onSelect}
                mode={mode}
                satellites={sats}
                onNearEarth={loadSats}
                cmes={sw?.cmes}
                flares={sw?.flares}
                layers={mode === "HELIO" ? helioLayers : undefined}
                spacecraft={spacecraft?.vehicles}
                onSelectCraft={(craft) => {
                  setSelectedCraftId(craft.id);
                  setMode("VEHICLES");
                }} />
              }
              {mode !== "VEHICLES" && status === "loading" &&
              <div className="flex h-full items-center justify-center text-[14px] text-[var(--amber-dim)]">▸ ACQUIRING CNEOS CLOSE-APPROACH DATA…</div>
              }
              {mode !== "VEHICLES" && status === "error" &&
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[14px] text-[var(--red)]">
                  <div>UPLINK FAILURE</div>
                  <div className="max-w-[60%] text-[12px] text-[var(--text-dim)]">{err}</div>
                </div>
              }

              {/* The inactive mini panels are the view switcher. */}
              <div className="absolute left-2 top-2 z-30 flex max-w-[62vw] flex-wrap items-center gap-1.5">
                <TitleTag>{mode === "GEO" ? "GEOCENTRIC EARTH MAP" : mode === "HELIO" ? "HELIOCENTRIC SOLAR MAP" : "CRAFT"}</TitleTag>
              </div>

              {mode === "HELIO" &&
              <div className="absolute left-2 top-12 z-30 flex max-w-[58vw] flex-wrap gap-1.5">
                {HELIO_LAYER_BUTTONS.map((b) => {
                  const on = helioLayers[b.key];
                  return (
                    <button
                      key={b.key}
                      type="button"
                      data-sfx="confirm"
                      aria-pressed={on}
                      aria-label={`${on ? "Hide" : "Show"} ${b.label}`}
                      onClick={() => toggleHelioLayer(b.key)}
                      onPointerEnter={() => setHelioLayerHint(b.hint ?? null)}
                      onPointerMove={() => setHelioLayerHint(b.hint ?? null)}
                      onPointerLeave={() => setHelioLayerHint(null)}
                      onFocus={() => setHelioLayerHint(b.hint ?? null)}
                      onBlur={() => setHelioLayerHint(null)}
                      className="inline-flex h-7 items-center gap-1.5 rounded border-[1.5px] px-2 text-[11px] font-bold tracking-wide transition-colors hover:bg-[rgba(240,179,42,0.1)] focus:outline-none focus-visible:border-[var(--amber-bright)]"
                      style={{
                        borderColor: on ? b.color : "var(--line)",
                        color: on ? b.color : "var(--text-dim)",
                        background: on ? "rgba(5,4,10,0.72)" : "rgba(5,4,10,0.48)",
                        boxShadow: on ? `0 0 8px color-mix(in srgb, ${b.color} 42%, transparent)` : undefined
                      }}>
                      <span className={on ? "glow-text" : undefined}>{b.mark}</span>
                      <span>{b.label}</span>
                    </button>);
                })}
              </div>}

              {mode === "HELIO" && helioLayerHint &&
              <div className="pointer-events-none absolute bottom-8 left-2 z-30 max-w-[min(560px,72vw)] border border-[var(--line)] bg-[rgba(5,4,10,0.62)] px-2 py-1 text-[10px] leading-tight text-[var(--green)] backdrop-blur-sm">
                ▸ {helioLayerHint}
              </div>}

              {/* nearest approach panel — desktop only, overlays the map top-left */}
              {mode !== "VEHICLES" && nextApproach &&
              <button
                type="button"
                data-sfx="select"
                onClick={() => onSelect(nextApproach)}
                className="absolute left-2 z-20 hidden w-[230px] flex-col gap-1 border border-[var(--line)] bg-[rgba(5,4,10,0.62)] px-2.5 py-2 text-left text-[12px] leading-tight backdrop-blur-sm transition-colors hover:border-[var(--amber-dim)] md:flex"
                style={{ top: mode === "HELIO" ? 84 : 44 }}>
                <div className="flex items-center justify-between">
                  <span className="text-[var(--orange)] glow-text">▸ NEAREST APPROACH</span>
                  {nextApproach.monitored &&
                  <span className="text-[var(--red)] glow-text">⚠ SENTRY</span>}
                </div>
                <div className="truncate text-[var(--amber-bright)] glow-text">{nextApproach.fullname || nextApproach.des}</div>
                <div className="mt-0.5 flex items-baseline justify-between tabular-nums">
                  <span className="text-[var(--text-dim)]">MISS</span>
                  <span className="text-[var(--amber)]">{nextApproach.distLd.toFixed(3)} LD</span>
                </div>
                <div className="flex items-baseline justify-between tabular-nums">
                  <span className="text-[var(--text-dim)]">&nbsp;</span>
                  <span className="text-[var(--amber-dim)]">{Math.round(nextApproach.distLd * 384400).toLocaleString()} KM</span>
                </div>
                <div className="flex items-baseline justify-between tabular-nums">
                  <span className="text-[var(--text-dim)]">V-REL</span>
                  <span className="text-[var(--amber)]">{nextApproach.vRelKms.toFixed(2)} KM/S</span>
                </div>
                <div className="flex items-baseline justify-between tabular-nums">
                  <span className="text-[var(--text-dim)]">{nextApproach.epochMs >= scrubberMs ? "ETA" : "PASSED"}</span>
                  <span className="text-[var(--green)]">{fmtDuration(Math.abs(nextApproach.epochMs - scrubberMs))}</span>
                </div>
                <div className="mt-0.5 text-[var(--text-dim)] tabular-nums">{fmtUTC(nextApproach.epochMs)}</div>
              </button>}

              {/* satellite catalogue uplink indicator — shows while CelesTrak GP loads */}
              {mode === "GEO" && satLoading && sats.length === 0 &&
              <div className="pointer-events-none absolute left-2 bottom-8 z-20 flex items-center gap-2 border border-[var(--line)] bg-[rgba(5,4,10,0.46)] px-2.5 py-1.5 text-[10px] leading-tight text-[var(--cyan)] backdrop-blur-sm">
                <span className="sat-spin inline-block h-[10px] w-[10px] flex-none rounded-full border-[1.5px] border-[var(--cyan)] border-t-transparent" />
                <span className="tracking-wide glow-text">CELESTRAK UPLINK · RESOLVING ACTIVE CATALOGUE…</span>
              </div>
              }

              {/* satellite type key — horizontal strip above the controls line */}
              {mode === "GEO" && sats.length > 0 &&
              <div className="pointer-events-none absolute left-2 right-2 bottom-7 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 py-0 text-[12px] leading-tight">
                <span className="text-[var(--orange)] glow-text">▸ ACTIVE SATELLITE KEY</span>
                {SAT_LEGEND.map((l) =>
                <span key={l.cat} className="flex items-center gap-1.5 tabular-nums">
                    <span className="inline-block h-[7px] w-[7px] flex-none rounded-full" style={{ background: l.color, boxShadow: `0 0 5px ${l.color}` }} />
                    <span style={{ color: l.color }}>{l.label}</span>
                    <span className="text-[var(--text-dim)]">{satCounts[l.cat].toLocaleString()}</span>
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-[8px] w-[8px] flex-none rotate-45 border border-[var(--green)]" style={{ boxShadow: "0 0 5px var(--green)" }} />
                  <span className="text-[var(--green)]">◆ ISS</span>
                  <span className="text-[var(--text-dim)]">CREWED</span>
                </span>
                <span className="text-[var(--text-dim)]">1 DOT ≈ {dotScale} SATS</span>
                {satCached !== null &&
                <span className="text-[var(--orange)] glow-text">
                  ⚠ CACHED · {new Date(satCached).toISOString().slice(0, 16).replace("T", " ")}Z
                </span>}
              </div>
              }

              {/* title + source — top right of the main map */}
              {mode !== "VEHICLES" &&
              <div className="pointer-events-none absolute right-2 top-2 z-20 flex max-w-[46vw] flex-col items-end text-right">
                <div className="hud-title text-[var(--amber-bright)] glow-text">
                  <em>SENTRY:</em> NEAR EARTH<br />OBJECT ENCOUNTERS
                </div>
                <div className="mt-1 text-[12px] leading-tight text-[var(--text-dim)]">
                  <div>SRC · <span className="text-[var(--green)]">JPL CNEOS · NASA SSD · SBDB</span></div>
                  {mode === "HELIO" && swStatus &&
                  <div className="mt-0.5 text-[var(--orange)] glow-text">☉ {swStatus}</div>}
                  <div className="mt-0.5">
                    TRACKED <span className="text-[var(--amber)]">{data?.count ?? "—"}</span>
                    &nbsp;·&nbsp;PLOTTED <span className="text-[var(--amber)]">{plottedCount}</span>
                    &nbsp;·&nbsp;SENTRY <span className="text-[var(--red)]">{monitoredCount}</span>
                    {mode === "GEO" && sats.length > 0 &&
                    <>&nbsp;·&nbsp;ACTIVE SATS <span className="text-[var(--cyan)]">{satTotal.toLocaleString()}</span></>}
                  </div>
                  <div className="mt-0.5">{fmtUTC(scrubberMs)}</div>
                  <div className="pointer-events-auto mt-0.5 text-[10px] text-[var(--text-dim)]">
                    CREATED BY{" "}
                    <a
                    href="https://www.instagram.com/artificial.isabel/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--amber)] underline-offset-2 hover:text-[var(--amber-bright)] hover:underline">
                      @artificial.isabel
                    </a>{" "}
                    WITH PUBLIC ORBIT DATA
                  </div>
                  <button
                    type="button"
                    data-sfx="confirm"
                    onClick={toggleSound}
                    disabled={!sfxReady}
                    aria-label={soundOn ? "Mute console audio" : "Enable console audio"}
                    className="pointer-events-auto mt-1.5 inline-flex items-center gap-1.5 rounded border-[1.5px] border-[var(--amber-dim)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-[var(--amber)] transition-colors hover:bg-[rgba(240,179,42,0.1)] disabled:opacity-50">
                    <span className={soundOn && sfxReady ? "glow-text text-[var(--amber-bright)]" : "text-[var(--text-dim)]"}>
                      {soundOn && sfxReady ? "◉" : "○"}
                    </span>
                    {sfxReady ? soundOn ? "AUDIO ON" : "AUDIO OFF" : "AUDIO · SYNTH…"}
                  </button>
                </div>
              </div>}

              {/* detail overlay */}
              {mode !== "VEHICLES" && selected &&
              <>
                <div className="fixed inset-2 z-50 flex items-center justify-center bg-[rgba(5,4,10,0.45)] p-2 backdrop-blur-[2px] md:hidden">
                  <DetailPanel obj={selected} sbdb={sbdb} sbdbLoading={sbdbLoading} scrubberMs={scrubberMs} onClose={() => setSelected(null)} modal />
                </div>
                <div className="absolute right-2 bottom-2 z-20 hidden md:block">
                  <DetailPanel obj={selected} sbdb={sbdb} sbdbLoading={sbdbLoading} scrubberMs={scrubberMs} onClose={() => setSelected(null)} />
                </div>
              </>
              }
            </div>
            {/* scrubber */}
            {data &&
            <div className="relative border-t border-[var(--line)]">
                <Plus at="tl" /><Plus at="tr" />
                <TimeScrubber
                min={data.windowMin} max={data.windowMax} value={scrubberMs} nowMs={nowMs}
                playing={playing} onChange={(v) => {setPlaying(false);setScrubberMs(v);}}
                onTogglePlay={() => setPlaying((p) => !p)} onNow={() => {
                  const current = Date.now();
                  setNowMs(current);
                  setPlaying(false);
                  setScrubberMs(Math.min(Math.max(current, data.windowMin), data.windowMax));
                }} />

              </div>
            }
          </section>
        </div>

        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize side panel column"
          aria-orientation="vertical"
          aria-valuemin={resizeA11y.desktopLeft.min}
          aria-valuemax={resizeA11y.desktopLeft.max}
          aria-valuenow={resizeA11y.desktopLeft.now}
          aria-valuetext={resizeA11y.desktopLeft.text}
          className="resize-handle resize-handle-v hidden md:block"
          style={{ gridColumn: "1 / 2", gridRow: "1 / -1", justifySelf: "end" }}
          onKeyDown={resizeWithKeyboard("desktop-left")}
          onPointerDown={beginResize("desktop-left")} />
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize mini map panel"
          aria-orientation="horizontal"
          aria-valuemin={resizeA11y.desktopMini.min}
          aria-valuemax={resizeA11y.desktopMini.max}
          aria-valuenow={resizeA11y.desktopMini.now}
          aria-valuetext={resizeA11y.desktopMini.text}
          className="resize-handle resize-handle-h hidden md:block"
          style={{ gridColumn: "1 / 2", gridRow: "1 / 2", alignSelf: "end" }}
          onKeyDown={resizeWithKeyboard("desktop-mini")}
          onPointerDown={beginResize("desktop-mini")} />
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize craft panel"
          aria-orientation="horizontal"
          aria-valuemin={resizeA11y.desktopRadar.min}
          aria-valuemax={resizeA11y.desktopRadar.max}
          aria-valuenow={resizeA11y.desktopRadar.now}
          aria-valuetext={resizeA11y.desktopRadar.text}
          className="resize-handle resize-handle-h hidden md:block"
          style={{ gridColumn: "1 / 2", gridRow: "2 / 3", alignSelf: "end" }}
          onKeyDown={resizeWithKeyboard("desktop-radar")}
          onPointerDown={beginResize("desktop-radar")} />
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize main map height"
          aria-orientation="horizontal"
          aria-valuemin={resizeA11y.mobileMain.min}
          aria-valuemax={resizeA11y.mobileMain.max}
          aria-valuenow={resizeA11y.mobileMain.now}
          aria-valuetext={resizeA11y.mobileMain.text}
          className="resize-handle resize-handle-h md:hidden"
          style={{ gridColumn: "1 / -1", gridRow: "1 / 2", alignSelf: "end" }}
          onKeyDown={resizeWithKeyboard("mobile-main")}
          onPointerDown={beginResize("mobile-main")} />
        <div
          role="separator"
          tabIndex={0}
          aria-label="Resize mobile side column"
          aria-orientation="vertical"
          aria-valuemin={resizeA11y.mobileLeft.min}
          aria-valuemax={resizeA11y.mobileLeft.max}
          aria-valuenow={resizeA11y.mobileLeft.now}
          aria-valuetext={resizeA11y.mobileLeft.text}
          className="resize-handle resize-handle-v md:hidden"
          style={{ gridColumn: "1 / 2", gridRow: "2 / -1", justifySelf: "end" }}
          onKeyDown={resizeWithKeyboard("mobile-left")}
          onPointerDown={beginResize("mobile-left")} />
      </div>
    </div>);

}
