import React from "react";
import type { NeoObject, SbdbResponse } from "../lib/types";
import { fmtDuration } from "../lib/format";

interface Props {
  obj: NeoObject;
  sbdb: SbdbResponse | null;
  sbdbLoading: boolean;
  scrubberMs: number;
  onClose: () => void;
  modal?: boolean;
}

// Plain-language note for each NEO orbit class returned by JPL SBDB.
function classNote(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("atira") || n.includes("apohele") || n.includes("interior"))
  return "Orbit lies entirely inside Earth's (aphelion < 0.983 AU).";
  if (n.includes("aten"))
  return "Earth-crossing orbit smaller than Earth's (semi-major axis a < 1 AU).";
  if (n.includes("apollo"))
  return "Earth-crossing orbit larger than Earth's (a > 1 AU, dips inside Earth's path).";
  if (n.includes("amor"))
  return "Approaches but does not cross Earth's orbit — sits between Earth and Mars.";
  if (n.includes("hungaria")) return "Inner main-belt group with high-inclination orbits.";
  if (n.includes("comet")) return "Icy body on an elongated heliocentric orbit.";
  return "Near-Earth object tracked by JPL's orbit catalogue.";
}

function Row({ label, value, color }: {label: string;value: string;color?: string;}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="text-[12px] tracking-wide text-[var(--text-dim)]">{label}</span>
      <span className="text-[14px] tabular-nums glow-text" style={{ color: color ?? "var(--amber-bright)" }}>{value}</span>
    </div>);

}

export function DetailPanel({ obj, sbdb, sbdbLoading, scrubberMs, onClose, modal = false }: Props) {
  const delta = obj.epochMs - scrubberMs;
  const ttp = (delta >= 0 ? "T− " : "T+ ") + fmtDuration(Math.abs(delta));
  const km = obj.distLd * 384400;
  const closerThanMoon = obj.distLd < 1;

  const ip = obj.sentry?.ip ?? null;
  const oddsTxt = ip != null && ip > 0 ?
  `1 IN ${Math.round(1 / ip).toLocaleString()}` :
  obj.sentry ? "≈ NEGLIGIBLE" : "NOT LISTED";

  const cls = sbdb && sbdb.ok ? sbdb.classType || "" : "";
  const orbitYrs = sbdb && sbdb.ok && sbdb.per != null ? (sbdb.per / 365.25).toFixed(2) : null;

  return (
    <div className={`panel-frame overflow-y-auto overscroll-contain p-3 text-[var(--amber)] shadow-[0_0_24px_rgba(0,0,0,0.7)] ${
      modal
        ? "max-h-[calc(100dvh-32px)] w-[min(360px,calc(100vw-20px))]"
        : "max-h-[min(430px,calc(100dvh-250px))] w-[286px] max-w-[82vw] md:max-h-[min(520px,calc(100dvh-120px))]"
    }`}>
      <div className="mb-2 flex items-start justify-between pb-1">
        <div className="min-w-0">
          <div className="text-[11px] tracking-widest text-[var(--orange)]">ASTEROID</div>
          <div className="elong truncate text-[22px] text-[var(--amber-bright)] glow-text">{obj.fullname || obj.des}</div>
        </div>
        <button data-sfx="close" onClick={onClose} className="ml-2 rounded border-[1.5px] border-[var(--amber-dim)] px-1.5 text-[13px] leading-tight hover:bg-[rgba(240,179,42,0.12)]" aria-label="Close">✕</button>
      </div>

      <Row label="CLOSEST APPROACH" value={ttp} color={delta >= 0 ? "var(--amber-bright)" : "var(--text-dim)"} />
      <Row label="MISS DISTANCE" value={`${obj.distLd.toFixed(2)} LD`} color={closerThanMoon ? "var(--red)" : "var(--amber-bright)"} />
      <div className="-mt-[2px] mb-[2px] flex justify-end">
        <span className="text-[11px] tabular-nums text-[var(--text-dim)]">{Math.round(km).toLocaleString()} KM</span>
      </div>
      {closerThanMoon &&
      <div className="-mt-[1px] mb-1 text-right text-[10px] leading-tight text-[var(--red)] glow-text">
        ☾ CLOSER THAN THE MOON
      </div>}

      <Row label="RELATIVE VELOCITY" value={`${obj.vRelKms.toFixed(2)} KM/S`} />
      <Row label="SENTRY WATCH" value={obj.sentry ? "MONITORED" : "NOT LISTED"} color={obj.sentry ? "var(--red)" : "var(--green)"} />
      <Row label="IMPACT ODDS (≤100 YR)" value={oddsTxt} color={obj.sentry ? "var(--amber-bright)" : "var(--text-dim)"} />

      <div className="my-2 border-t border-[var(--line)]" />

      {sbdbLoading &&
      <div className="py-1 text-[12px] text-[var(--text-dim)]">▸ QUERYING SBDB…</div>}
      {!sbdbLoading && sbdb && sbdb.ok &&
      <>
        <Row label="CLASS" value={cls || "—"} />
        {cls &&
        <div className="-mt-[1px] mb-1 text-[10px] leading-tight text-[var(--text-dim)]">
          {classNote(cls)}
        </div>}
        <Row label="SUN-ORBIT" value={orbitYrs != null ? `${orbitYrs} YR` : "—"} />
      </>}
      {!sbdbLoading && sbdb && !sbdb.ok &&
      <div className="py-1 text-[12px] text-[var(--text-dim)]">NO ORBIT RECORD RETURNED</div>}

      <div className="mt-2 text-[10px] leading-tight text-[var(--text-dim)]">SOURCE: JPL CNEOS · NASA SENTRY</div>
    </div>);

}
