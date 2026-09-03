import React, { useEffect, useMemo, useState } from "react";
import type { SpacecraftResponse, SpacecraftVehicle } from "../lib/types";
import { SpacecraftModelView } from "./SpacecraftModelView";

const AMBER = "var(--amber)";
const DIM = "var(--amber-dim)";
const GREEN = "var(--green)";
const CYAN = "var(--cyan)";
const RED = "var(--red)";
const TEXT_DIM = "var(--text-dim)";

interface Props {
  data: SpacecraftResponse | null;
  loading: boolean;
  nowMs: number;
  selectedId?: string | null;
  onSelectedIdChange?: (id: string) => void;
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[rgba(122,90,20,0.34)] py-1.5">
      <span className="text-[11px] tracking-wide text-[var(--text-dim)]">{label}</span>
      <span className="max-w-[64%] truncate text-right text-[13px] tabular-nums glow-text" style={{ color: color ?? "var(--amber-bright)" }}>
        {value}
      </span>
    </div>
  );
}

function line(x1: number, y1: number, x2: number, y2: number, color = AMBER, width = 1) {
  return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={width} vectorEffect="non-scaling-stroke" />;
}

// Stable, illustrative heliocentric angle for a craft — mirrors the 3D solar
// map's placement so this top-down diagram agrees with the big view.
function craftSeed(id: string) {
  return [...id].reduce((sum, ch, i) => sum + ch.charCodeAt(0) * (i + 3), 0);
}
function seeded01(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
function craftHelioAngle(v: SpacecraftVehicle, nowMs: number) {
  const au = Math.max(0.18, v.rangeAu ?? 2);
  const base = seeded01(craftSeed(v.id)) * Math.PI * 2;
  const yrs = (nowMs - Date.parse(v.launchDate)) / (365.25 * 86400000);
  const drift = yrs * (au < 1 ? 1.1 : au < 6 ? 0.22 : 0.025);
  return base + drift;
}
// Log-compressed radial scale so Parker (0.25 AU) and Voyager (~166 AU) both fit.
const HELIO_MAX_AU = 200;
function auToPx(au: number) {
  const inner = 15, outer = 84;
  return inner + (outer - inner) * Math.log1p(Math.max(0, au)) / Math.log1p(HELIO_MAX_AU);
}

// Simple top-down (ecliptic) diagram: Sun at centre, reference planet rings, and
// the selected craft plotted at its heliocentric range + illustrative bearing.
function HelioTopDown({ vehicle, nowMs }: { vehicle: SpacecraftVehicle; nowMs: number }) {
  const au = Math.max(0.18, vehicle.rangeAu ?? 2);
  const a = craftHelioAngle(vehicle, nowMs);
  const r = auToPx(au);
  const cx = 100, cy = 100;
  const sx = cx + Math.cos(a) * r;
  const sy = cy - Math.sin(a) * r; // flip: SVG y grows downward
  const accent = vehicle.status.includes("ACTIVE") ? GREEN : CYAN;
  const refs = [
    { au: 1, color: "var(--blue)" },
    { au: 5.2, color: DIM },
    { au: 30, color: DIM },
  ];
  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" preserveAspectRatio="xMidYMid meet" aria-label={`${vehicle.name} heliocentric position, top down`}>
      {refs.map((ref) => (
        <circle key={ref.au} cx={cx} cy={cy} r={auToPx(ref.au)} fill="none" stroke={ref.color} strokeWidth={0.6} strokeDasharray="2 4" opacity={0.55} />
      ))}
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={accent} strokeWidth={0.7} opacity={0.32} />
      <line x1={cx} y1={cy} x2={sx} y2={sy} stroke={accent} strokeWidth={0.8} opacity={0.7} />
      <circle cx={cx} cy={cy} r={5.5} fill="var(--orange)" />
      <circle cx={cx} cy={cy} r={9.5} fill="none" stroke="var(--orange)" strokeWidth={0.6} opacity={0.5} />
      <circle cx={sx} cy={sy} r={3.4} fill={accent} />
      <circle cx={sx} cy={sy} r={6.6} fill="none" stroke={accent} strokeWidth={0.7} opacity={0.6} />
      <text x={sx} y={sy - 9} textAnchor="middle" fontFamily="var(--font-mono)" fontSize="7" fill={accent}>{vehicle.shortName}</text>
      <text x={cx} y={cy + 20} textAnchor="middle" fontFamily="var(--font-mono)" fontSize="6.5" fill={TEXT_DIM}>SOL</text>
    </svg>
  );
}

function Blueprint({ vehicle }: { vehicle: SpacecraftVehicle }) {
  const accent = vehicle.status.includes("ACTIVE") ? GREEN : vehicle.status.includes("INTERSTELLAR") ? CYAN : AMBER;
  const common = {
    fill: "none",
    stroke: AMBER,
    strokeWidth: 1.2,
    vectorEffect: "non-scaling-stroke" as const,
  };

  const dish = (cx: number, cy: number, r: number) => (
    <g>
      <circle cx={cx} cy={cy} r={r} {...common} />
      <circle cx={cx} cy={cy} r={r * 0.55} {...common} stroke={DIM} />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return <line key={`dish-rib-${i}`} x1={cx} y1={cy} x2={cx + Math.cos(a) * r} y2={cy + Math.sin(a) * r} stroke={DIM} strokeWidth={0.65} vectorEffect="non-scaling-stroke" />;
      })}
    </g>
  );

  const array = (x: number, y: number, w: number, h: number, panels = 5) => (
    <g>
      <rect x={x} y={y} width={w} height={h} {...common} />
      {Array.from({ length: panels - 1 }, (_, i) => (
        <line key={`array-bay-${i}`} x1={x + (w / panels) * (i + 1)} y1={y} x2={x + (w / panels) * (i + 1)} y2={y + h} stroke={DIM} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
      ))}
      <line x1={x} y1={y + h / 2} x2={x + w} y2={y + h / 2} stroke={DIM} strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
    </g>
  );

  const craft = (() => {
    switch (vehicle.schematic) {
      case "voyager":
        return (
          <g>
            {dish(132, 84, 34)}
            <rect x={118} y={120} width={28} height={20} {...common} />
            {line(132, 118, 132, 150, accent, 1.5)}
            {line(146, 130, 242, 168, accent, 1)}
            <rect x={238} y={158} width={36} height={19} {...common} />
            {line(118, 130, 44, 160, accent, 1)}
            <rect x={28} y={151} width={30} height={18} {...common} />
            {line(132, 84, 82, 32, AMBER, 1)}
            {line(82, 32, 60, 22, DIM, 0.8)}
            {line(132, 84, 178, 36, AMBER, 1)}
            <circle cx={178} cy={36} r={4} fill={accent} />
          </g>
        );
      case "new-horizons":
        return (
          <g>
            <path d="M106 64 L168 82 L152 140 L92 124 Z" {...common} />
            {dish(104, 94, 27)}
            <rect x={138} y={104} width={28} height={42} {...common} />
            {line(160, 126, 238, 158, accent, 1.2)}
            <rect x={234} y={150} width={25} height={17} {...common} />
            {line(116, 66, 72, 34, DIM, 0.9)}
            {line(92, 124, 50, 162, DIM, 0.9)}
          </g>
        );
      case "parker":
        return (
          <g>
            <path d="M82 70 Q132 40 182 70 L170 96 Q132 76 94 96 Z" {...common} stroke={accent} />
            <rect x={108} y={100} width={48} height={50} {...common} />
            {array(38, 112, 56, 25, 4)}
            {array(170, 112, 56, 25, 4)}
            {line(94, 124, 108, 124, DIM, 1)}
            {line(156, 124, 170, 124, DIM, 1)}
            {line(132, 150, 132, 178, accent, 1)}
            <circle cx={132} cy={182} r={5} fill={accent} />
          </g>
        );
      case "juno":
        return (
          <g>
            <polygon points="132,77 158,92 158,122 132,137 106,122 106,92" {...common} />
            {dish(132, 107, 19)}
            {line(106, 107, 40, 70, accent, 1.2)}
            {array(10, 44, 72, 25, 6)}
            {line(158, 107, 224, 70, accent, 1.2)}
            {array(182, 44, 72, 25, 6)}
            {line(132, 137, 132, 206, accent, 1.2)}
            {array(96, 204, 72, 25, 6)}
          </g>
        );
      case "cassini":
        return (
          <g>
            {dish(112, 80, 42)}
            <rect x={94} y={124} width={36} height={44} {...common} />
            <rect x={132} y={130} width={26} height={24} {...common} />
            {line(152, 142, 244, 102, accent, 1)}
            <circle cx={248} cy={100} r={5} fill={accent} />
            {line(106, 166, 70, 210, DIM, 0.9)}
            {line(128, 166, 168, 210, DIM, 0.9)}
          </g>
        );
      case "galileo":
        return (
          <g>
            {dish(132, 74, 36)}
            <rect x={112} y={114} width={40} height={44} {...common} />
            <circle cx={132} cy={136} r={14} {...common} stroke={DIM} />
            {line(152, 132, 230, 88, accent, 1)}
            {line(112, 134, 34, 98, accent, 1)}
            {line(132, 158, 132, 214, DIM, 1)}
            <rect x={120} y={210} width={24} height={12} {...common} />
          </g>
        );
      case "pioneer":
        return (
          <g>
            {dish(132, 92, 45)}
            <rect x={114} y={136} width={36} height={26} {...common} />
            {line(114, 148, 42, 186, accent, 1.1)}
            {line(150, 148, 222, 186, accent, 1.1)}
            <rect x={22} y={176} width={34} height={18} {...common} />
            <rect x={208} y={176} width={34} height={18} {...common} />
            {line(132, 58, 132, 24, DIM, 0.9)}
          </g>
        );
      case "psyche":
        return (
          <g>
            <rect x={106} y={84} width={52} height={66} {...common} />
            <rect x={117} y={98} width={30} height={22} {...common} stroke={DIM} />
            {dish(132, 70, 16)}
            {line(106, 116, 76, 116, accent, 1)}
            {line(158, 116, 188, 116, accent, 1)}
            {array(18, 90, 58, 52, 5)}
            {array(188, 90, 58, 52, 5)}
            {line(132, 150, 132, 190, DIM, 0.9)}
          </g>
        );
    }
  })();

  return (
    <svg viewBox="0 0 264 232" className="h-full w-full" preserveAspectRatio="xMidYMid meet" aria-label={`${vehicle.name} schematic`}>
      <defs>
        <pattern id={`grid-${vehicle.id}`} width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M 16 0 L 0 0 0 16" fill="none" stroke="var(--amber-dim)" strokeWidth="0.35" opacity="0.35" />
        </pattern>
      </defs>
      <rect x="0" y="0" width="264" height="232" fill={`url(#grid-${vehicle.id})`} opacity="0.48" />
      <g opacity="0.35">
        {line(132, 10, 132, 222, DIM, 0.6)}
        {line(10, 116, 254, 116, DIM, 0.6)}
        <circle cx={132} cy={116} r={84} fill="none" stroke={DIM} strokeWidth={0.6} strokeDasharray="3 5" />
      </g>
      {craft}
      <g fontFamily="var(--font-mono)" fontSize="7" fill={TEXT_DIM}>
        <text x="8" y="14">{vehicle.shortName}</text>
        <text x="256" y="14" textAnchor="end">SPICE {vehicle.spiceId}</text>
        <text x="8" y="224">HORIZONS {vehicle.horizonsId}</text>
        <text x="256" y="224" textAnchor="end">{vehicle.status}</text>
      </g>
    </svg>
  );
}

export function SpacecraftPanel({ data, loading, nowMs, selectedId, onSelectedIdChange }: Props) {
  const [localSelectedId, setLocalSelectedId] = useState<string>("");
  const [craftFilter, setCraftFilter] = useState<"active" | "ended">("active");
  const [showMobileGrid, setShowMobileGrid] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const vehicles = data?.vehicles ?? [];
  const activeSelectedId = selectedId ?? localSelectedId;
  const isActive = (v: SpacecraftVehicle) => v.status.includes("ACTIVE");
  const activeCount = vehicles.filter(isActive).length;
  const endedCount = vehicles.length - activeCount;
  const filtered = vehicles.filter((v) => (craftFilter === "active" ? isActive(v) : !isActive(v)));

  useEffect(() => {
    if (!activeSelectedId && vehicles.length > 0) setLocalSelectedId(vehicles[0].id);
  }, [activeSelectedId, vehicles]);

  const selected = useMemo(() => vehicles.find((v) => v.id === activeSelectedId) ?? vehicles[0] ?? null, [activeSelectedId, vehicles]);
  const chooseVehicle = (id: string) => {
    setLocalSelectedId(id);
    onSelectedIdChange?.(id);
    setShowMobileGrid(false);
  };
  // Toggling ACTIVE / ENDED filters the strip; if the current craft isn't in the
  // new set, jump the main view to the first one so it never shows a blank strip.
  const switchFilter = (key: "active" | "ended") => {
    setCraftFilter(key);
    const set = vehicles.filter((v) => (key === "active" ? isActive(v) : !isActive(v)));
    if (set.length && (!selected || !set.some((v) => v.id === selected.id))) chooseVehicle(set[0].id);
  };

  if (loading && !data) {
    return <div className="flex h-full items-center justify-center text-[14px] text-[var(--amber-dim)]">▸ ACQUIRING NASA SPACECRAFT ROSTER…</div>;
  }
  if (!selected) {
    return <div className="flex h-full items-center justify-center text-[14px] text-[var(--red)]">▸ SPACECRAFT ROSTER OFFLINE</div>;
  }

  return (
    <div
      className="relative h-full min-h-0 overflow-hidden text-[var(--amber)]"
      style={{
        backgroundColor: "rgb(5,4,10)",
        backgroundImage: [
          "radial-gradient(circle at 14% 18%, rgba(71,255,169,0.48) 0 1px, transparent 1.4px)",
          "radial-gradient(circle at 72% 26%, rgba(112,178,255,0.36) 0 1px, transparent 1.3px)",
          "radial-gradient(circle at 36% 72%, rgba(240,179,42,0.3) 0 0.8px, transparent 1.2px)",
          "linear-gradient(rgba(71,255,169,0.08) 1px, transparent 1px)",
          "linear-gradient(90deg, rgba(71,255,169,0.08) 1px, transparent 1px)",
          "radial-gradient(circle at 50% 42%, rgba(71,255,169,0.06), transparent 44%)",
        ].join(","),
        backgroundSize: "220px 220px, 280px 280px, 180px 180px, 54px 54px, 54px 54px, 100% 100%",
      }}>
      <SpacecraftModelView vehicle={selected} onDetails={() => setShowDetails(true)} />
      <div className="pointer-events-none absolute inset-0 z-10 opacity-30 [background-image:linear-gradient(rgba(240,179,42,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(240,179,42,0.06)_1px,transparent_1px)] [background-size:18px_18px]" />

      <button
        type="button"
        data-sfx="select"
        onClick={() => setShowMobileGrid(true)}
        className="absolute left-[72px] top-2 z-40 inline-flex items-center gap-[6px] rounded-[5px] border-[1.5px] border-[var(--green)] bg-[rgba(5,4,10,0.7)] px-[9px] py-[2px] text-[12px] font-bold uppercase leading-[1.1] tracking-normal text-[var(--green)] shadow-[0_0_8px_rgba(84,255,138,0.34)] [text-shadow:0_0_6px_currentColor] md:hidden">
        more
      </button>

      <div className="pointer-events-none absolute right-2 top-2 z-20 flex max-w-[46vw] flex-col items-end text-right">
        <div className="hud-title text-[var(--amber-bright)] glow-text">
          <em>SENTRY:</em> NEAR EARTH<br />OBJECT ENCOUNTERS
        </div>
        <div className="mt-1 text-[12px] leading-tight text-[var(--text-dim)]">
          <div>SRC · <span className="text-[var(--green)]">{data?.source ?? "NASA/JPL PUBLIC DATA"}</span></div>
          <div className="mt-0.5">
            VEHICLES <span className="text-[var(--amber)]">{vehicles.length}</span>
            &nbsp;·&nbsp;MODEL <span className="text-[var(--green)]">{selected.modelUrl ? "NASA GLB" : "PROXY"}</span>
            {selected.modelUrl && (
              <>
                &nbsp;·&nbsp;
                <a
                  href={selected.modelSourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pointer-events-auto text-[var(--green)] underline-offset-2 hover:text-[var(--amber-bright)] hover:underline">
                  NASA 3D SOURCE
                </a>
              </>
            )}
          </div>
          <div className="mt-0.5">{new Date(nowMs).toISOString().slice(0, 16).replace("T", " ")}Z {data?.cached && <span className="text-[var(--orange)] glow-text">· CACHED</span>}</div>
        </div>
      </div>

      <div className="pointer-events-none fixed right-0 top-[136px] z-20 h-[112px] w-[168px] opacity-85 max-md:top-[92px] max-md:h-[92px] max-md:w-[138px]">
        <HelioTopDown vehicle={selected} nowMs={nowMs} />
      </div>

      <div className="absolute left-2 top-12 z-20 hidden w-[230px] border border-[var(--line)] bg-[rgba(5,4,10,0.62)] px-2.5 py-2 text-[12px] leading-tight backdrop-blur-sm md:block">
        <div className="flex items-center justify-between">
          <span className="text-[var(--orange)] glow-text">▸ SPACECRAFT MODEL</span>
          <span className="text-[var(--text-dim)]">{selected.shortName}</span>
        </div>
        <div className="truncate text-[var(--amber-bright)] glow-text">{selected.name.toUpperCase()}</div>
        <div className="mt-2 flex items-baseline justify-between tabular-nums">
          <span className="text-[var(--text-dim)]">STATUS</span>
          <span style={{ color: selected.status.includes("ACTIVE") ? GREEN : TEXT_DIM }}>{selected.status}</span>
        </div>
        <div className="flex items-baseline justify-between tabular-nums">
          <span className="text-[var(--text-dim)]">REGION</span>
          <span className="max-w-[58%] truncate text-[var(--amber)]">{selected.primaryRegion}</span>
        </div>
        <div className="flex items-baseline justify-between tabular-nums">
          <span className="text-[var(--text-dim)]">RANGE</span>
          <span className="text-[var(--amber)]">{selected.rangeAu == null ? "EPHEMERIS" : `~${selected.rangeAu.toFixed(selected.rangeAu < 1 ? 2 : 0)} AU`}</span>
        </div>
        <div className="flex items-baseline justify-between tabular-nums">
          <span className="text-[var(--text-dim)]">V-REL</span>
          <span style={{ color: selected.speedKms == null ? TEXT_DIM : "var(--red)" }}>{selected.speedKms == null ? "SEE HORIZONS" : `~${selected.speedKms} KM/S`}</span>
        </div>
        <div className="flex items-baseline justify-between tabular-nums">
          <span className="text-[var(--text-dim)]">SIGNAL</span>
          <span className="max-w-[58%] truncate" style={{ color: CYAN }}>{selected.signal}</span>
        </div>
        <div className="mt-1 text-[var(--text-dim)] tabular-nums">LAUNCH {selected.launchDate}</div>
      </div>

      {showDetails && (
        <div className="fixed inset-2 z-50 flex items-center justify-center bg-[rgba(5,4,10,0.45)] p-2 backdrop-blur-[2px]">
          <div className="panel-frame max-h-[calc(100dvh-32px)] w-[min(360px,calc(100vw-20px))] overflow-y-auto overscroll-contain p-3 text-[12px] leading-tight shadow-[0_0_24px_rgba(0,0,0,0.72)]">
            <div className="mb-2 flex items-start justify-between gap-3 border-b border-[var(--line)] pb-2">
              <div className="min-w-0">
                <div className="text-[10px] tracking-widest text-[var(--orange)] glow-text">▸ SPACECRAFT MODEL</div>
                <div className="truncate text-[20px] text-[var(--amber-bright)] glow-text">{selected.name.toUpperCase()}</div>
              </div>
              <button
                type="button"
                data-sfx="close"
                onClick={() => setShowDetails(false)}
                className="shrink-0 rounded border-[1.5px] border-[var(--amber-dim)] px-1.5 text-[13px] leading-tight text-[var(--amber)] hover:bg-[rgba(240,179,42,0.12)]"
                aria-label="Close spacecraft details">
                ✕
              </button>
            </div>
            <Row label="STATUS" value={selected.status} color={selected.status.includes("ACTIVE") ? GREEN : TEXT_DIM} />
            <Row label="REGION" value={selected.primaryRegion} />
            <Row label="RANGE" value={selected.rangeAu == null ? "EPHEMERIS" : `~${selected.rangeAu.toFixed(selected.rangeAu < 1 ? 2 : 0)} AU`} />
            <Row label="V-REL" value={selected.speedKms == null ? "SEE HORIZONS" : `~${selected.speedKms} KM/S`} color={selected.speedKms == null ? TEXT_DIM : RED} />
            <Row label="SIGNAL" value={selected.signal} color={CYAN} />
            <Row label="LAUNCH" value={selected.launchDate} color={TEXT_DIM} />
            <Row label="HORIZONS" value={selected.horizonsId} />
            <Row label="SPICE" value={selected.spiceId} />
            <div className="mt-2 text-[10px] leading-tight text-[var(--text-dim)]">
              SOURCE: NASA Images · JPL Horizons · NAIF/SPICE · NASA mission archives
            </div>
            {selected.modelUrl && (
              <a
                href={selected.modelSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-[var(--green)] underline-offset-2 hover:text-[var(--amber-bright)] hover:underline">
                NASA 3D SOURCE
              </a>
            )}
          </div>
        </div>
      )}

      {showMobileGrid && (
        <div className="fixed inset-2 z-50 flex items-end bg-[rgba(5,4,10,0.52)] p-2 backdrop-blur-[2px] md:hidden">
          <div className="panel-frame max-h-[calc(100dvh-32px)] w-full overflow-y-auto overscroll-contain p-2 shadow-[0_0_24px_rgba(0,0,0,0.72)]">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] tracking-widest text-[var(--orange)] glow-text">▸ VEHICLE INDEX</div>
                <div className="text-[16px] text-[var(--amber-bright)] glow-text">NASA SPACECRAFT</div>
              </div>
              <button
                type="button"
                data-sfx="close"
                onClick={() => setShowMobileGrid(false)}
                className="rounded border-[1.5px] border-[var(--amber-dim)] px-1.5 text-[13px] leading-tight text-[var(--amber)] hover:bg-[rgba(240,179,42,0.12)]"
                aria-label="Close spacecraft menu">
                ✕
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {vehicles.map((v) => {
                const on = v.id === selected.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    data-sfx="select"
                    onClick={() => chooseVehicle(v.id)}
                    className="relative h-[104px] overflow-hidden border border-[rgba(122,90,20,0.58)] bg-[rgba(5,4,10,0.34)] text-left"
                    style={{ color: on ? "var(--amber-bright)" : "var(--amber)" }}>
                    <div className="absolute inset-1 opacity-70">
                      <Blueprint vehicle={v} />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 bg-[linear-gradient(0deg,rgba(5,4,10,0.96),rgba(5,4,10,0.58),transparent)] px-2 pb-1 pt-6">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[12px] glow-text">{v.shortName}</span>
                        <span className="text-[9px]" style={{ color: v.status.includes("ACTIVE") ? GREEN : TEXT_DIM }}>
                          {v.status.includes("ACTIVE") ? "LIVE" : "ARC"}
                        </span>
                      </div>
                      <div className="truncate text-[9px] text-[var(--text-dim)]">{v.primaryRegion}</div>
                    </div>
                    {on && <span className="absolute bottom-0 left-0 h-[2px] w-full bg-[var(--green)] shadow-[0_0_8px_var(--green)]" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-2 left-2 right-2 z-20 hidden flex-col gap-1 md:flex">
        {/* ACTIVE / ENDED toggle — keeps each set small enough to show every craft
            at once with no horizontal scrolling. */}
        <div className="flex gap-1 self-start">
          {(["active", "ended"] as const).map((key) => {
            const on = craftFilter === key;
            const tint = key === "active" ? GREEN : CYAN;
            return (
              <button
                key={key}
                type="button"
                data-sfx="confirm"
                aria-pressed={on}
                onClick={() => switchFilter(key)}
                className="inline-flex h-6 items-center gap-1.5 rounded border-[1.5px] px-2 text-[10px] font-bold uppercase tracking-wide transition-colors hover:bg-[rgba(240,179,42,0.1)]"
                style={{
                  borderColor: on ? tint : "var(--line)",
                  color: on ? tint : "var(--text-dim)",
                  background: on ? "rgba(5,4,10,0.72)" : "rgba(5,4,10,0.48)",
                }}>
                <span className={on ? "glow-text" : undefined}>{key}</span>
                <span className="text-[var(--text-dim)]">{key === "active" ? activeCount : endedCount}</span>
              </button>
            );
          })}
        </div>
        <div className="flex h-[104px] border-y border-[var(--line)] bg-[rgba(5,4,10,0.34)] backdrop-blur-sm">
          {filtered.map((v) => {
            const on = v.id === selected.id;
            return (
              <button
                key={v.id}
                type="button"
                data-sfx="select"
                onClick={() => chooseVehicle(v.id)}
                className="relative block h-[102px] min-w-0 max-w-[240px] flex-1 border-r border-[rgba(122,90,20,0.42)] bg-[rgba(5,4,10,0.2)] text-left transition-colors last:border-r-0 hover:bg-[rgba(240,179,42,0.08)]"
                style={{ color: on ? "var(--amber-bright)" : "var(--amber)" }}>
                <div className="absolute inset-1 opacity-75">
                  <Blueprint vehicle={v} />
                </div>
                <div className="absolute inset-x-0 bottom-0 bg-[linear-gradient(0deg,rgba(5,4,10,0.96),rgba(5,4,10,0.52),transparent)] px-2 pb-1 pt-5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[12px] glow-text">{v.shortName}</span>
                    <span className="text-[9px]" style={{ color: v.status.includes("ACTIVE") ? GREEN : TEXT_DIM }}>
                      {v.status.includes("ACTIVE") ? "LIVE" : "ARC"}
                    </span>
                  </div>
                  <div className="truncate text-[9px] text-[var(--text-dim)]">{v.primaryRegion}</div>
                </div>
                {on && <span className="absolute bottom-0 left-0 h-[2px] w-full bg-[var(--green)] shadow-[0_0_8px_var(--green)]" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
