// Calendar-date parsing for JPL CAD strings and duration formatting.
const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

// CAD "cd" looks like "2026-Jan-01 12:00" (UTC).
export function parseCD(cd: string): number {
  const m = cd.trim().match(/(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const [, y, mon, d, hh, mm] = m;
  return Date.UTC(+y, MONTHS[mon] ?? 0, +d, +hh, +mm);
}

export function fmtSigned(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  return sign + fmtDuration(Math.abs(ms));
}

export function fmtDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}D ${p(hours)}H ${p(mins)}M`;
  return `${p(hours)}H ${p(mins)}M`;
}

export function fmtUTC(ms: number): string {
  if (!isFinite(ms)) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getUTCMonth()];
  return `${d.getUTCFullYear()}-${mon}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
}

export function fmtDateShort(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getUTCMonth()];
  return `${p(d.getUTCDate())} ${mon}`;
}
