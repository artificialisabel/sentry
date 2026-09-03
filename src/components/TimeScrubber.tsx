import React from "react";
import { fmtUTC } from "../lib/format";

interface Props {
  min: number;
  max: number;
  value: number;
  nowMs: number;
  playing: boolean;
  onChange: (v: number) => void;
  onTogglePlay: () => void;
  onNow: () => void;
}

export function TimeScrubber({ min, max, value, nowMs, playing, onChange, onTogglePlay, onNow }: Props) {
  const nowFrac = max > min ? (nowMs - min) / (max - min) : 0;
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <button onClick={onTogglePlay} data-sfx={playing ? "pause" : "confirm"}
      className="flex h-7 w-9 items-center justify-center rounded border-[1.5px] border-[var(--amber-dim)] text-[var(--amber)] hover:bg-[rgba(240,179,42,0.1)]"
      aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <button onClick={onNow}
      className="h-7 rounded border-[1.5px] border-[var(--amber-dim)] px-3 text-[12px] font-bold text-[var(--amber)] hover:bg-[rgba(240,179,42,0.1)]">
        NOW
      </button>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[12px] font-bold text-[var(--text-dim)]">MISSION TIME</span>
          <span className="clock-font text-[14px] text-[var(--amber-bright)] glow-text">{fmtUTC(value)}</span>
        </div>
        <div className="relative">
          <input type="range" min={min} max={max} step={3600000} value={value}
          onChange={(e) => onChange(Number(e.target.value))} className="w-full" aria-label="Mission time scrubber" />
          <div className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-[var(--green)]"
          style={{ left: `${nowFrac * 100}%`, boxShadow: "0 0 5px var(--green)" }} />
        </div>
      </div>
    </div>);

}