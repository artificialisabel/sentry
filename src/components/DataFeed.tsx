import React, { useRef } from "react";
import type { CadResponse, NeoObject, SatElements, SpacecraftResponse } from "../lib/types";
import { fmtDateShort } from "../lib/format";

interface Props {
  data: CadResponse | null;
  events: string[];
  onSelect: (o: NeoObject) => void;
  selectedId: string | null;
  sats: SatElements[];
  spacecraft?: SpacecraftResponse | null;
  selectedCraftId?: string | null;
}

const EARTH_R_KM = 6371.0;
const SAT_GROUP: Record<string, {abbr: string;color: string;}> = {
  starlink: { abbr: "STL", color: "#39d6c8" },
  oneweb: { abbr: "OWB", color: "#5f7bff" },
  weather: { abbr: "WX", color: "#cfd6e6" },
  gps: { abbr: "NAV", color: "#54ff8a" },
  geo: { abbr: "GEO", color: "#ff8a3c" },
  other: { abbr: "OTH", color: "#8a93b5" }
};

export function DataFeed({ data, events, onSelect, selectedId, sats, spacecraft, selectedCraftId }: Props) {
  // Feed stays anchored at the top so the uplink header reads first.
  const listRef = useRef<HTMLDivElement | null>(null);
  const selectedCraft = spacecraft?.vehicles.find((v) => v.id === selectedCraftId) ?? spacecraft?.vehicles[0] ?? null;

  return (
    <div className="flex h-full flex-col overflow-hidden text-[12px] leading-tight">
      <div ref={listRef} className="flex-1 overflow-y-auto pr-1">
        {/* uplink log */}
        <div className="text-[var(--orange)] glow-text">▸ DATA UPLINK / RAW RETURN</div>
        {data &&
        <div className="mb-1 text-[var(--green)]">
            <div>SRC {data.source}</div>
            {data.requests.map((r, i) =>
          <div key={i} className={r.status === 200 ? "text-[var(--green)]" : "text-[var(--red)]"}>
                {r.label.toUpperCase().padEnd(11, " ")} {r.status === 200 ? "200 OK" : `ERR ${r.status}`} · {r.count} REC
              </div>
          )}
          </div>
        }
        {events.map((e, i) =>
        <div key={i} className="text-[var(--green)] opacity-90">{e}</div>
        )}

        {selectedCraft &&
        <div className="mt-2 pt-1">
            <div className="text-[var(--orange)]">SPACECRAFT PUBLIC DATA · {selectedCraft.shortName}</div>
            <div className="text-[var(--green)]">SRC {spacecraft?.source ?? "NASA/JPL PUBLIC DATA"}</div>
            {selectedCraft.dataSources.map((s) => (
              <a
                key={s.label}
                href={s.endpoint}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-[var(--green)] opacity-90 hover:text-[var(--amber-bright)]">
                {s.label.toUpperCase().padEnd(16, " ")} {s.source}
              </a>
            ))}
            {selectedCraft.assets.slice(0, 3).map((a) => (
              <a
                key={a.nasaId || a.href}
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block truncate text-[var(--cyan)] opacity-90 hover:text-[var(--amber-bright)]">
                NASA IMAGE {a.nasaId || "ASSET"} · {a.title}
              </a>
            ))}
          </div>
        }

        {/* object stream */}
        {data &&
        <div className="mt-2 pt-1">
            <div className="text-[var(--orange)]">CLOSE-APPROACH STREAM · {data.count} OBJ</div>
            <div className="mt-0.5 flex text-[var(--text-dim)]">
              <span className="w-[88px]">DES</span><span className="w-[44px]">DATE</span><span className="w-[44px] text-right">LD</span><span className="flex-1 text-right">KM/S</span>
            </div>
            {data.objects.map((o, i) => {
            const sel = o.id === selectedId;
            return (
              <button key={o.id} data-sfx="select" onClick={() => onSelect(o)}
              className="flex w-full items-center text-left tabular-nums hover:bg-[rgba(240,179,42,0.08)]"
              style={{ color: o.monitored ? "var(--red)" : sel ? "var(--amber-bright)" : "var(--green)", background: sel ? "rgba(240,179,42,0.10)" : undefined }}>
                  <span className="w-[88px] truncate">{String(i + 1).padStart(3, "0")} {o.des}</span>
                  <span className="w-[44px]">{fmtDateShort(o.epochMs)}</span>
                  <span className="w-[44px] text-right">{o.distLd.toFixed(2)}</span>
                  <span className="flex-1 text-right">{o.vRelKms.toFixed(1)}</span>
                </button>);

          })}
          </div>
        }

        {/* satellite catalogue stream — live CelesTrak GP elements */}
        {sats.length > 0 &&
        <div className="mt-2 pt-1">
            <div className="text-[var(--orange)]">ORBITAL CATALOGUE STREAM · {sats.length} DOTS</div>
            <div className="mt-0.5 flex text-[var(--text-dim)]">
              <span className="w-[96px]">OBJECT</span><span className="w-[34px]">GRP</span><span className="flex-1 text-right">ALT KM</span>
            </div>
            {sats.map((s, i) => {
            const g = SAT_GROUP[s.cat] ?? { abbr: s.cat.slice(0, 3).toUpperCase(), color: "var(--green)" };
            const alt = Math.max(0, s.a * (1 - s.e) - EARTH_R_KM);
            return (
              <div key={s.noradId} className="flex items-center tabular-nums" style={{ color: g.color }}>
                  <span className="w-[96px] truncate">{String(i + 1).padStart(3, "0")} {s.name}</span>
                  <span className="w-[34px]">{g.abbr}</span>
                  <span className="flex-1 text-right">{Math.round(alt).toLocaleString()}</span>
                </div>);

          })}
          </div>
        }

        {data?.raw &&
        <div className="mt-2 pt-1">
            <div className="text-[var(--orange)]">RAW PACKET [cad.api]</div>
            <pre className="whitespace-pre-wrap break-all text-[10px] text-[var(--text-dim)]">{data.raw}</pre>
          </div>
        }
      </div>
    </div>);

}
