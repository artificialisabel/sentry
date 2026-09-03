import React, { useEffect, useState } from "react";
import type { CmeEvent, FlareEvent, KpSample, SpaceWeatherResponse } from "../lib/types";
import { fmtDateShort, fmtDuration } from "../lib/format";

// Honour the OS reduced-motion setting (the console disables its sweeps/pulses
// for motion-sensitive viewers, matching the WebGL scene and the CSS chrome).
function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduce(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

const AMBER = "#f0b32a";
const AMBER_DIM = "#6b551f";
const ORANGE = "#ff8a3c";
const RED = "#ff3b2f";
const GREEN = "#54ff8a";
const TEXTDIM = "var(--text-dim)";

const FLARE_COLOR: Record<string, string> = {
  X: RED, M: ORANGE, C: "#ffd76b", B: AMBER_DIM, A: AMBER_DIM,
};

// G-scale band for a planetary K index (NOAA geomagnetic storm scale).
function gScale(kp: number): { g: string; color: string; label: string } {
  if (kp >= 9) return { g: "G5", color: RED, label: "EXTREME" };
  if (kp >= 8) return { g: "G4", color: RED, label: "SEVERE" };
  if (kp >= 7) return { g: "G3", color: ORANGE, label: "STRONG" };
  if (kp >= 6) return { g: "G2", color: ORANGE, label: "MODERATE" };
  if (kp >= 5) return { g: "G1", color: "#ffd76b", label: "MINOR" };
  return { g: "G0", color: GREEN, label: "QUIET" };
}

function polar(cx: number, cy: number, angDeg: number, r: number): [number, number] {
  const a = (angDeg - 90) * Math.PI / 180; // 0° = up, clockwise
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// =========================================================================
// SOLAR WIND MAP — locked Sun → Earth top view. It reads like a compact space-
// weather diagram: solar wind/protons stream from the Sun, cosmic rays arc in
// around the magnetosphere, and DONKI Earth-directed CMEs compress the bow.
// =========================================================================
export function SolarWindMap({ cmes, kp, nowMs }: { cmes: CmeEvent[]; kp: KpSample[]; nowMs: number }) {
  const reduce = useReducedMotion();
  const earthDirected = cmes.filter((c) => c.earthDirected);
  const recent = earthDirected.filter((c) => nowMs - c.startMs > 0 && nowMs - c.startMs < 8 * 86400000);
  const fastest = earthDirected.reduce((m, c) => Math.max(m, c.speed ?? 0), 0);
  const latestKp = [...kp].sort((a, b) => b.tMs - a.tMs)[0]?.kp ?? 0;
  const pressure = Math.max(0, Math.min(1, recent.length / 5 + latestKp / 18));
  const frame = { x: 18, y: 16, w: 198, h: 108 };
  const earthX = frame.x + frame.w * 0.78 - pressure * 10;
  const earthY = frame.y + frame.h * 0.55;
  const dots = Array.from({ length: 170 }, (_, i) => ({
    x: frame.x + 6 + (i % 34) * 4.9,
    y: frame.y + frame.h - 10 - Math.floor(i / 34) * 8.5 + Math.sin(i * 0.9) * 2.4,
    op: 0.18 + (i % 7) * 0.08,
    col: i % 11 === 0 ? GREEN : i % 5 === 0 ? ORANGE : AMBER,
  }));
  const streamLines = Array.from({ length: 13 }, (_, i) => i);
  const stems = Array.from({ length: 38 }, (_, i) => i);
  const trace = Array.from({ length: 28 }, (_, i) => {
    const t = i / 27;
    const surge = Math.exp(-Math.pow((t - 0.22) / 0.12, 2)) * (0.38 + pressure * 0.38);
    const baseline = 0.12 + 0.05 * Math.sin(i * 0.8);
    return { x: frame.x + t * frame.w, y: frame.y + frame.h - (baseline + surge) * frame.h };
  });

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className="text-[var(--orange)] glow-text">▸ SUN–EARTH PARTICLE PLOT</span>
        <span className="tabular-nums" style={{ color: recent.length ? RED : TEXTDIM }}>
          {recent.length} ACTIVE · {fastest ? `${Math.round(fastest)} KM/S` : "QUIET"}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <svg viewBox="0 0 240 150" className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
          <defs>
            <pattern id="crtDots" width="5" height="5" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.45" fill={AMBER_DIM} opacity="0.45" />
            </pattern>
          </defs>

          <rect x="0" y="0" width="240" height="150" fill="rgba(5,4,10,0.22)" />
          <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill="url(#crtDots)" opacity="0.55" />
          <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill="none" stroke={AMBER} strokeWidth="1.1" opacity="0.84" />

          {/* plot ticks */}
          {Array.from({ length: 18 }, (_, i) => (
            <g key={`xt-${i}`}>
              <line x1={frame.x + i * frame.w / 17} y1={frame.y + frame.h} x2={frame.x + i * frame.w / 17} y2={frame.y + frame.h + (i % 2 ? 3 : 6)} stroke={AMBER} strokeWidth="0.55" opacity="0.72" />
              {i % 4 === 0 && <text x={frame.x + i * frame.w / 17} y={frame.y + frame.h + 13} textAnchor="middle" fill={AMBER_DIM} fontSize="5" fontFamily="var(--font-mono)">{i}</text>}
            </g>
          ))}
          {Array.from({ length: 9 }, (_, i) => (
            <g key={`yt-${i}`}>
              <line x1={frame.x - (i % 2 ? 3 : 6)} y1={frame.y + i * frame.h / 8} x2={frame.x} y2={frame.y + i * frame.h / 8} stroke={AMBER} strokeWidth="0.55" opacity="0.72" />
              {i % 2 === 0 && <text x={frame.x - 8} y={frame.y + i * frame.h / 8 + 1.5} textAnchor="end" fill={AMBER_DIM} fontSize="5" fontFamily="var(--font-mono)">{8 - i}</text>}
            </g>
          ))}

          <text x={frame.x + 2} y={frame.y - 6} fill={AMBER} fontSize="5.5" fontFamily="var(--font-mono)">DONKI SOL-WIND-SPECT</text>
          <text x={frame.x + frame.w - 2} y={frame.y - 6} textAnchor="end" fill={AMBER_DIM} fontSize="5.5" fontFamily="var(--font-mono)">T+ {Math.round((nowMs / 3600000) % 24).toString().padStart(2, "0")}:00</text>
          <text x={frame.x + frame.w / 2} y={144} textAnchor="middle" fill={AMBER_DIM} fontSize="5.5" fontFamily="var(--font-mono)">SUN → EARTH AXIS</text>

          {/* left solar emitter strip */}
          <rect x={frame.x + 1} y={frame.y + 1} width="18" height={frame.h - 2} fill={RED} opacity="0.18" />
          {Array.from({ length: 24 }, (_, i) => (
            <line key={`sun-${i}`} x1={frame.x + 2 + i % 7 * 2.4} y1={frame.y + 3 + i * 4.2} x2={frame.x + 14 + i % 5 * 1.5} y2={frame.y + 8 + i * 4.2} stroke={i % 3 ? ORANGE : "#ffd76b"} strokeWidth="0.8" opacity="0.46" />
          ))}

          {/* vertical instrument stems and dot matrix */}
          {stems.map((i) => {
            const x = frame.x + 24 + i * 4.4;
            const amp = 18 + 50 * Math.exp(-Math.pow((i - 7) / 5, 2)) + pressure * 12 * Math.exp(-Math.pow((i - 26) / 7, 2));
            return <line key={`stem-${i}`} x1={x} y1={frame.y + frame.h - 6} x2={x} y2={frame.y + frame.h - 6 - amp} stroke={i < 14 ? RED : AMBER} strokeWidth="0.75" opacity={0.35 + Math.min(0.45, amp / 110)} />;
          })}
          {dots.map((d, i) => (
            <circle key={`dot-${i}`} cx={d.x} cy={d.y} r={i % 13 === 0 ? 1.25 : 0.72} fill={d.col} opacity={d.op}>
              {!reduce && <animateTransform attributeName="transform" type="translate" from="-10 0" to="18 0" dur={`${2.6 + i % 6 * 0.3}s`} begin={`${-(i % 11) * 0.16}s`} repeatCount="indefinite" />}
            </circle>
          ))}

          {/* density trace */}
          <polyline points={trace.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke="#ffd76b" strokeWidth="1.05" opacity="0.88" />
          <polyline points={trace.map((p, i) => `${p.x},${p.y + 5 + Math.sin(i) * 2}`).join(" ")} fill="none" stroke={RED} strokeWidth="0.85" opacity="0.68" />
          {streamLines.map((i) => (
            <path key={`stream-${i}`} d={`M ${frame.x + 13} ${frame.y + 20 + i * 6.1} C ${frame.x + 70} ${frame.y + 8 + i * 5.8}, ${earthX - 34} ${earthY - 32 + i * 4.9}, ${earthX} ${earthY + (i - 6) * 3.2}`} fill="none" stroke={i % 3 === 0 ? RED : AMBER} strokeWidth="0.45" opacity="0.34" />
          ))}

          {recent.map((c, i) => {
            const y = frame.y + 36 + (i % 5) * 10;
            return (
              <path key={c.id} d={`M ${frame.x + 18} ${y} C ${frame.x + 74} ${y - 14}, ${earthX - 48} ${y + 12}, ${earthX - 8} ${earthY + (i - 2) * 5}`} fill="none" stroke={c.speed && c.speed > 900 ? RED : ORANGE} strokeWidth="1.15" opacity={0.68}>
                {!reduce && <animate attributeName="stroke-opacity" values="0.2;0.9;0.2" dur="2.6s" begin={`${i * 0.25}s`} repeatCount="indefinite" />}
              </path>
            );
          })}

          {/* Earth / magnetosphere marker */}
          <path d={`M ${earthX - 8} ${earthY} C ${earthX + 8} ${earthY - 24}, ${earthX + 42} ${earthY - 18}, ${earthX + 50} ${earthY - 9} M ${earthX - 8} ${earthY} C ${earthX + 8} ${earthY + 24}, ${earthX + 42} ${earthY + 18}, ${earthX + 50} ${earthY + 9}`} fill="none" stroke={GREEN} strokeWidth="0.7" opacity="0.68" />
          {[6, 11, 16].map((r, i) => (
            <ellipse key={`belt-${r}`} cx={earthX} cy={earthY} rx={r * 1.35} ry={r} fill="none" stroke={i === 0 ? "#ffd76b" : AMBER} strokeWidth="0.55" opacity={0.65 - i * 0.12} />
          ))}
          <circle cx={earthX} cy={earthY} r="3.8" fill={GREEN} opacity="0.82" />
          <circle cx={earthX} cy={earthY} r="1.5" fill="#fff0a0" />

          <text x={frame.x + 3} y={frame.y + frame.h - 4} fill={RED} fontSize="5.5" fontFamily="var(--font-mono)">SOL</text>
          <text x={earthX + 8} y={earthY - 8} fill={GREEN} fontSize="5.5" fontFamily="var(--font-mono)">EARTH</text>
          <text x={frame.x + 31} y={frame.y + 33} fill={AMBER_DIM} fontSize="5.5" fontFamily="var(--font-mono)">PARTICLE DENSITY</text>
          <text x={earthX - 10} y={frame.y + frame.h - 9} fill={AMBER_DIM} fontSize="5.5" fontFamily="var(--font-mono)">MAG FIELD</text>
        </svg>
      </div>
    </div>
  );
}

// =========================================================================
// FLARE TIMELINE — soft X-ray flares as bars over the past ~30 days; height
// is log intensity, colour is GOES class (C/M/X). A cursor marks the clock.
// =========================================================================
export function FlareTimeline({ flares, windowMin, nowMs, scrubberMs }:
  { flares: FlareEvent[]; windowMin: number; nowMs: number; scrubberMs: number }) {
  const W = 200, H = 88, PADX = 4, PADB = 12, PADT = 6;
  const tMin = windowMin, tMax = nowMs;
  const span = Math.max(1, tMax - tMin);
  const xFor = (t: number) => PADX + Math.max(0, Math.min(1, (t - tMin) / span)) * (W - 2 * PADX);
  // log flux mapped from C (1e-6) .. above-X (1e-3) into the bar area.
  const yFor = (flux: number) => {
    const lo = -6.3, hi = -3; // log10 W/m^2
    const v = Math.max(0, Math.min(1, (Math.log10(Math.max(flux, 1e-9)) - lo) / (hi - lo)));
    return H - PADB - v * (H - PADB - PADT);
  };
  const classLines: Array<[string, number]> = [["C", 1e-6], ["M", 1e-5], ["X", 1e-4]];
  const inWin = flares.filter((f) => f.peakMs >= tMin && f.peakMs <= tMax + 5 * 86400000);
  const biggest = inWin.reduce<FlareEvent | null>((m, f) => (!m || f.flux > m.flux ? f : m), null);
  const scrubX = xFor(scrubberMs);

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className="text-[var(--orange)] glow-text">▸ SOLAR FLARE INTENSITY · 30D</span>
        {biggest && <span className="tabular-nums" style={{ color: FLARE_COLOR[biggest.cls] }}>MAX {biggest.classType}</span>}
      </div>
      <div className="relative min-h-0 flex-1">
        <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
          {/* class gridlines */}
          {classLines.map(([lbl, flux]) => {
            const y = yFor(flux);
            return (
              <g key={lbl}>
                <line x1={PADX} y1={y} x2={W - PADX} y2={y} stroke={AMBER_DIM} strokeWidth={0.4} opacity={0.4} strokeDasharray="2 2" />
                <text x={PADX + 1} y={y - 1} fontSize={5} fill={TEXTDIM} fontFamily="var(--font-mono)">{lbl}</text>
              </g>
            );
          })}
          {/* baseline */}
          <line x1={PADX} y1={H - PADB} x2={W - PADX} y2={H - PADB} stroke={AMBER} strokeWidth={0.5} opacity={0.6} />
          {/* flare bars */}
          {inWin.map((f, i) => {
            const x = xFor(f.peakMs);
            const y = yFor(f.flux);
            return <line key={f.id + i} x1={x} y1={H - PADB} x2={x} y2={y} stroke={FLARE_COLOR[f.cls] ?? AMBER} strokeWidth={f.cls === "X" ? 1.4 : 1} opacity={0.92} />;
          })}
          {/* scrub clock cursor */}
          <line x1={scrubX} y1={PADT - 2} x2={scrubX} y2={H - PADB} stroke={GREEN} strokeWidth={0.5} opacity={0.7} />
          {/* date ticks */}
          <text x={PADX} y={H - 3} fontSize={5} fill={TEXTDIM} fontFamily="var(--font-mono)">{fmtDateShort(tMin)}</text>
          <text x={W - PADX} y={H - 3} fontSize={5} fill={TEXTDIM} textAnchor="end" fontFamily="var(--font-mono)">NOW</text>
        </svg>
        {inWin.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[var(--amber-dim)]">▸ NO FLARES LOGGED</div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Kp GAUGE — a half-dial of the planetary K index (0–9) on the NOAA G-scale,
// driven by the most recent observed sample, with a recent Kp sparkline.
// =========================================================================
export function KpGauge({ kp, nowMs }: { kp: KpSample[]; nowMs: number }) {
  // Current = latest sample within the last 24h; peak = max over last 3 days.
  const recent = kp.filter((s) => nowMs - s.tMs < 3 * 86400000);
  const latest = [...kp].sort((a, b) => b.tMs - a.tMs)[0] ?? null;
  const current = latest && nowMs - latest.tMs < 24 * 86400000 ? latest.kp : 0;
  const peak = recent.reduce((m, s) => Math.max(m, s.kp), 0);
  const g = gScale(current);

  const C = 100, CY = 96, R = 76;
  // 180° dial: Kp 0 at 180° (left), Kp 9 at 0° (right) → angle from -90..+90 top.
  const angFor = (v: number) => -90 + Math.max(0, Math.min(9, v)) / 9 * 180;
  const [nx, ny] = polar(C, CY, angFor(current), R - 8);

  // arc path helper across the gauge
  const arc = (v0: number, v1: number, r: number) => {
    const [x0, y0] = polar(C, CY, angFor(v0), r);
    const [x1, y1] = polar(C, CY, angFor(v1), r);
    const large = angFor(v1) - angFor(v0) > 180 ? 1 : 0;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
  };
  const bands: Array<[number, number, string]> = [
    [0, 5, GREEN], [5, 6, "#ffd76b"], [6, 7, ORANGE], [7, 9, RED],
  ];

  // sparkline of recent samples
  const spark = [...recent].sort((a, b) => a.tMs - b.tMs);
  const sMin = nowMs - 3 * 86400000;
  const sx = (t: number) => 6 + Math.max(0, Math.min(1, (t - sMin) / (nowMs - sMin))) * 188;
  const sy = (v: number) => 150 - Math.max(0, Math.min(9, v)) / 9 * 28;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className="text-[var(--orange)] glow-text">▸ EARTH Kp STORM SCALE</span>
        <span className="tabular-nums" style={{ color: g.color }}>{g.g} · {g.label}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <svg viewBox="0 0 200 160" className="absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid meet">
          {/* colour bands */}
          {bands.map(([a, b, c], i) => (
            <path key={i} d={arc(a, b, R)} fill="none" stroke={c} strokeWidth={7} opacity={0.85} strokeLinecap="butt" />
          ))}
          {/* tick labels 0..9 */}
          {[0, 3, 5, 6, 7, 9].map((v) => {
            const [tx, ty] = polar(C, CY, angFor(v), R + 9);
            return <text key={v} x={tx} y={ty} fontSize={6} fill={TEXTDIM} textAnchor="middle" fontFamily="var(--font-mono)">{v}</text>;
          })}
          {/* needle */}
          <line x1={C} y1={CY} x2={nx} y2={ny} stroke={g.color} strokeWidth={2} />
          <circle cx={C} cy={CY} r={3} fill={g.color} />
          {/* readout */}
          <text x={C} y={CY - 22} fontSize={26} fill={g.color} textAnchor="middle" fontFamily="var(--font-mono)" className="glow-text">{current.toFixed(1)}</text>
          <text x={C} y={CY - 10} fontSize={6} fill={TEXTDIM} textAnchor="middle" fontFamily="var(--font-mono)">PEAK 3D {peak.toFixed(1)}</text>

          {/* sparkline */}
          <line x1={6} y1={150} x2={194} y2={150} stroke={AMBER_DIM} strokeWidth={0.4} opacity={0.5} />
          {spark.length > 1 && (
            <polyline
              points={spark.map((s) => `${sx(s.tMs)},${sy(s.kp)}`).join(" ")}
              fill="none" stroke={AMBER} strokeWidth={0.8} opacity={0.85} />
          )}
        </svg>
      </div>
    </div>
  );
}

// Compact one-line space-weather status for the heliocentric HUD.
export function spaceWeatherStatus(sw: SpaceWeatherResponse | null, nowMs: number): string | null {
  if (!sw || !sw.ok) return null;
  const parts: string[] = [];
  const lastFlare = [...sw.flares].sort((a, b) => b.peakMs - a.peakMs)[0];
  if (lastFlare && nowMs - lastFlare.peakMs < 5 * 86400000) {
    parts.push(`${lastFlare.classType} FLARE ${fmtDuration(Math.abs(nowMs - lastFlare.peakMs))} AGO`);
  }
  const inbound = sw.cmes
    .filter((c) => c.earthDirected && c.arrivalMs != null && c.arrivalMs >= nowMs)
    .sort((a, b) => (a.arrivalMs ?? 0) - (b.arrivalMs ?? 0))[0];
  if (inbound) parts.push(`CME ETA ${fmtDuration((inbound.arrivalMs ?? nowMs) - nowMs)}`);
  const latestKp = [...sw.kp].sort((a, b) => b.tMs - a.tMs)[0];
  if (latestKp && nowMs - latestKp.tMs < 24 * 86400000) {
    const g = gScale(latestKp.kp);
    if (latestKp.kp >= 5) parts.push(`Kp ${latestKp.kp.toFixed(0)} (${g.g})`);
  }
  return parts.length ? parts.join(" · ") : "SOLAR ACTIVITY NOMINAL";
}
