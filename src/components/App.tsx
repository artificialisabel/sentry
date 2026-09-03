import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CadResponse, ElementsResponse, NeoObject, OrbitElements, SatCat, SatElements, SatResponse, SbdbResponse, SpaceWeatherResponse } from "../lib/types";
import { Scene3D } from "./Scene3D";
import type { SceneLayers } from "./Scene3D";
import { RadarMap } from "./RadarMap";
import { DataFeed } from "./DataFeed";
import { DetailPanel } from "./DetailPanel";
import { TimeScrubber } from "./TimeScrubber";
import { SolarWindMap, FlareTimeline, KpGauge, spaceWeatherStatus } from "./SpaceWeather";
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
const HELIO_LAYER_BUTTONS: Array<{ key: keyof SceneLayers; label: string; mark: string; color: string; hint: string; }> = [
  { key: "orbits", label: "ORB", mark: "◎", color: "var(--amber)", hint: "JPL SBDB asteroid and planet orbit paths." },
  { key: "cmes", label: "CME", mark: "•", color: "var(--orange)", hint: "DONKI coronal-mass-ejection particle streamers." },
  { key: "flares", label: "FLR", mark: "✦", color: "var(--red)", hint: "DONKI solar-flare bursts at active-region bearings." },
  { key: "solar", label: "SOL", mark: "☉", color: "var(--green)", hint: "Stylised solar surface particles and magnetic loops." },
];


// Rounded label tag used for every panel title (matches the reference chrome).
function TitleTag({ children }: {children: React.ReactNode;}) {
  return <span className="title-tag">{children}</span>;
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

type Mode = "GEO" | "HELIO";

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
  const [helioLayers, setHelioLayers] = useState<SceneLayers>({ orbits: true, cmes: false, flares: false, solar: false });
  const [soundOn, setSoundOn] = useState(true);
  const [sfxReady, setSfxReady] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  const sbdbCache = useRef<Map<string, SbdbResponse>>(new Map());

  const log = useCallback((s: string) => setEvents((e) => [...e.slice(-40), s]), []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
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
  const otherMode: Mode = mode === "GEO" ? "HELIO" : "GEO";
  const monitoredCount = data ? data.objects.filter((o) => o.monitored).length : 0;
  const plottedCount = useMemo(
    () => data ? data.objects.filter((o) => elements[o.des]).length : 0,
    [data, elements]
  );

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

  return (
    <div className="flex h-full w-full flex-col bg-[var(--bg)] p-2 text-[var(--amber)]">
      {/* body — one console frame, panels split by hairline dividers + crosshairs */}
      <div className="console-grid relative min-h-0 flex-1 border border-[var(--line)]">
        {/* frame corners */}
        <Plus at="tl" /><Plus at="tr" /><Plus at="bl" /><Plus at="br" />
        {/* geo/other-mode mini map */}
        <section className="area-mini relative flex min-h-0 flex-col overflow-hidden border-b border-r border-[var(--line)]">
            <div className="absolute left-2 top-2 z-20"><TitleTag>{otherMode === "GEO" ? "EARTH MINI MAP" : "SOLAR MINI MAP"}</TitleTag></div>
            <Plus at="bl" /><Plus at="br" />
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
          </section>
          <section className="area-radar relative flex min-h-0 flex-col overflow-hidden border-r border-[var(--line)] md:border-b">
            <div className="absolute left-2 top-2 z-20"><TitleTag>TIME / DISTANCE RADAR</TitleTag></div>
            <Plus at="bl" /><Plus at="br" />
            <div className="relative min-h-0 flex-1">
              {status === "ready" && data ?
            <RadarMap
              objects={data.objects}
              windowMin={data.windowMin}
              windowMax={data.windowMax}
              scrubberMs={scrubberMs}
              selectedId={selected?.id ?? null}
              onSelect={onSelect} /> :
            <div className="flex h-full items-center justify-center text-[11px] text-[var(--amber-dim)]">▸ STANDBY</div>}
            </div>
          </section>
          <section className="area-feed relative flex min-h-0 flex-col border-[var(--line)] md:border-r">
            <div className="px-2 pt-2"><TitleTag>SOURCE / OBJECT FEED</TitleTag></div>
            <div className="min-h-0 flex-1 p-2">
              <DataFeed data={data} events={events} onSelect={onSelect} selectedId={selected?.id ?? null} sats={sats} />
            </div>
          </section>

        {/* main map: interactive 3D scene */}
        <div className="area-main relative flex min-h-0 flex-col border-b border-[var(--line)] md:border-b-0">
          <section className="relative flex min-h-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              {status === "ready" && data &&
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
                layers={mode === "HELIO" ? helioLayers : undefined} />
              }
              {status === "loading" &&
              <div className="flex h-full items-center justify-center text-[14px] text-[var(--amber-dim)]">▸ ACQUIRING CNEOS CLOSE-APPROACH DATA…</div>
              }
              {status === "error" &&
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[14px] text-[var(--red)]">
                  <div>UPLINK FAILURE</div>
                  <div className="max-w-[60%] text-[12px] text-[var(--text-dim)]">{err}</div>
                </div>
              }

              {/* single map label — top left */}
              <div className="absolute left-2 top-2 z-20"><TitleTag>{mode === "GEO" ? "GEOCENTRIC EARTH MAP" : "HELIOCENTRIC SOLAR MAP"}</TitleTag></div>

              {mode === "HELIO" &&
              <div className="absolute left-2 top-11 z-30 flex max-w-[58vw] flex-wrap gap-1.5">
                {HELIO_LAYER_BUTTONS.map((b) => {
                  const on = helioLayers[b.key];
                  return (
                    <button
                      key={b.key}
                      type="button"
                      data-sfx="confirm"
                      aria-pressed={on}
                      aria-label={`${on ? "Hide" : "Show"} ${b.label}`}
                      title={b.hint}
                      onClick={() => toggleHelioLayer(b.key)}
                      className="group relative inline-flex h-7 items-center gap-1.5 rounded border-[1.5px] px-2 text-[11px] font-bold tracking-wide transition-colors hover:bg-[rgba(240,179,42,0.1)] focus:outline-none focus-visible:border-[var(--amber-bright)]"
                      style={{
                        borderColor: on ? b.color : "var(--line)",
                        color: on ? b.color : "var(--text-dim)",
                        background: on ? "rgba(5,4,10,0.72)" : "rgba(5,4,10,0.48)",
                        boxShadow: on ? `0 0 8px color-mix(in srgb, ${b.color} 42%, transparent)` : undefined
                      }}>
                      <span className={on ? "glow-text" : undefined}>{b.mark}</span>
                      <span>{b.label}</span>
                      <span
                        className="pointer-events-none absolute left-0 top-[calc(100%+6px)] hidden w-[230px] border border-[var(--line)] bg-[rgba(5,4,10,0.88)] px-2 py-1.5 text-left text-[10px] leading-tight text-[var(--text-dim)] shadow-[0_0_14px_rgba(0,0,0,0.75)] backdrop-blur-sm group-hover:block group-focus-visible:block"
                        style={{ color: on ? b.color : "var(--text-dim)" }}>
                        <span className="text-[var(--orange)] glow-text">{b.label}</span>{" "}
                        {b.hint}
                      </span>
                    </button>);
                })}
              </div>}

              {/* nearest approach panel — desktop only, overlays the map top-left */}
              {nextApproach &&
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
              </div>

              {/* detail overlay */}
              {selected &&
              <div className="absolute right-2 bottom-2 z-20">
                  <DetailPanel obj={selected} sbdb={sbdb} sbdbLoading={sbdbLoading} scrubberMs={scrubberMs} onClose={() => setSelected(null)} />
                </div>
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

        {/* right rail — NASA DONKI space-weather console (heliocentric context) */}
        <section className="area-sw-cme relative flex min-h-0 flex-col overflow-hidden border-l border-b border-[var(--line)] p-2">
          <Plus at="tl" /><Plus at="bl" />
          {sw ?
          <SolarWindMap cmes={sw.cmes} kp={sw.kp} nowMs={scrubberMs} /> :
          <SwStandby />}
        </section>
        <section className="area-sw-flare relative flex min-h-0 flex-col overflow-hidden border-l border-b border-[var(--line)] p-2">
          <Plus at="bl" />
          {sw ?
          <FlareTimeline flares={sw.flares} windowMin={sw.windowMin} nowMs={nowMs} scrubberMs={scrubberMs} /> :
          <SwStandby />}
        </section>
        <section className="area-sw-kp relative flex min-h-0 flex-col overflow-hidden border-l border-[var(--line)] p-2">
          {sw ?
          <KpGauge kp={sw.kp} nowMs={scrubberMs} /> :
          <SwStandby />}
        </section>
      </div>
    </div>);

}

// Placeholder shown in the space-weather column until the DONKI uplink resolves.
function SwStandby() {
  return (
    <div className="flex h-full items-center justify-center text-[11px] text-[var(--amber-dim)]">
      ▸ DONKI UPLINK…
    </div>);

}
