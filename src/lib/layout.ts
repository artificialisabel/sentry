import type { NeoObject } from "./types";

export const LD_MAX = 20; // outer edge of the scope, in lunar distances
export const RING_LDS = [1, 5, 10, 15, 20];

export interface RadarPoint {
  obj: NeoObject;
  x: number; // screen px (y-down), relative to container
  y: number;
  r: number; // px radius from centre
  angle: number; // radians (screen space, clockwise from top)
  frac: number; // 0..1 position in the time window
}

export interface RadarLayout {
  cx: number;
  cy: number;
  maxR: number;
  earthR: number;
  rings: Array<{ ld: number; r: number }>;
  points: RadarPoint[];
}

// Position in the time window -> angle. Window start at top, sweeping clockwise.
export function timeToAngle(t: number, min: number, max: number): number {
  const frac = max > min ? (t - min) / (max - min) : 0;
  return -Math.PI / 2 + 2 * Math.PI * frac;
}

export function ldToRadius(ld: number, maxR: number): number {
  return (Math.min(Math.max(ld, 0), LD_MAX) / LD_MAX) * maxR;
}

export function radarLayout(objects: NeoObject[], w: number, h: number, min: number, max: number): RadarLayout {
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.max(40, Math.min(w, h) / 2 - 46);
  const earthR = Math.max(10, maxR * 0.06);
  const rings = RING_LDS.map((ld) => ({ ld, r: ldToRadius(ld, maxR) }));
  const points: RadarPoint[] = objects.map((obj) => {
    const frac = max > min ? (obj.epochMs - min) / (max - min) : 0;
    const angle = -Math.PI / 2 + 2 * Math.PI * frac;
    const r = ldToRadius(obj.distLd, maxR);
    return { obj, x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), r, angle, frac };
  });
  return { cx, cy, maxR, earthR, rings, points };
}
