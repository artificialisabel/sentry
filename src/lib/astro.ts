// Real astronomy helpers. All output derived from physical constants and
// standard published formulae (Meeus low-precision lunar terms; Standish
// approximate planetary elements). Nothing here is invented per-object data.

export const AU_KM = 149597870.7;
export const LUNAR_DISTANCE_KM = 384400; // mean Earth–Moon distance
export const AU_TO_LD = AU_KM / LUNAR_DISTANCE_KM; // ≈ 389.17
export const EARTH_RADIUS_KM = 6371.0; // mean volumetric radius
export const MOON_RADIUS_KM = 1737.4;
export const MU_EARTH = 398600.4418; // km^3/s^2, Earth geocentric gravitational constant

const DEG = Math.PI / 180;
const OBLIQUITY = 23.43928 * DEG; // mean obliquity of the ecliptic (J2000)

export function dateToJD(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

function norm360(x: number): number {
  return ((x % 360) + 360) % 360;
}

// Low-precision lunar distance (km). Largest periodic terms from Meeus,
// "Astronomical Algorithms". Accurate to a few hundred km — well within the
// resolution of a lunar-distance scope.
export function moonDistanceKm(date: Date): number {
  const T = (dateToJD(date) - 2451545.0) / 36525;
  const D = norm360(297.8501921 + 445267.1114034 * T) * DEG;
  const M = norm360(357.5291092 + 35999.0502909 * T) * DEG;
  const Mp = norm360(134.9633964 + 477198.8675055 * T) * DEG;
  let r = 385000.56;
  r += -20905.355 * Math.cos(Mp);
  r += -3699.111 * Math.cos(2 * D - Mp);
  r += -2955.968 * Math.cos(2 * D);
  r += -569.925 * Math.cos(2 * Mp);
  r += 48.888 * Math.cos(M);
  r += -3.149 * Math.cos(2 * (93.272095 + 483202.0175233 * T) * DEG);
  r += 246.158 * Math.cos(2 * D - 2 * Mp);
  r += -152.138 * Math.cos(2 * D + Mp - M * 0); // 2D+Mp
  r += -170.733 * Math.cos(2 * D + Mp);
  return r;
}

export function moonDistanceLd(date: Date): number {
  return moonDistanceKm(date) / LUNAR_DISTANCE_KM;
}

// Estimated diameter range from absolute magnitude H (NASA standard relation).
// d(km) = 1329 / sqrt(albedo) * 10^(-0.2 H). Albedo 0.05–0.25 brackets the
// plausible range for an unknown NEO.
export function diameterRangeM(h: number | null): { min: number; max: number } | null {
  if (h == null || !isFinite(h)) return null;
  const f = (albedo: number) => (1329 / Math.sqrt(albedo)) * Math.pow(10, -0.2 * h) * 1000;
  return { min: f(0.25), max: f(0.05) };
}

function solveKepler(M: number, e: number): number {
  // M in radians
  let E = M;
  for (let i = 0; i < 60; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-9) break;
  }
  return E;
}

export interface Elements {
  a: number; // AU
  e: number;
  i: number; // deg
  om: number; // deg, longitude of ascending node
  w: number; // deg, argument of perihelion
  ma: number; // deg, mean anomaly at epoch
  epochJD: number;
  n?: number; // deg/day (optional mean motion)
}

// Heliocentric ecliptic position (AU) for a set of Keplerian elements at date.
export function orbitPosition(el: Elements, date: Date): { x: number; y: number; z: number } {
  const jd = dateToJD(date);
  const n = el.n ?? 0.9856076686 / (el.a * Math.sqrt(el.a)); // deg/day
  const M = norm360(el.ma + n * (jd - el.epochJD)) * DEG;
  const E = solveKepler(M, el.e);
  const xv = el.a * (Math.cos(E) - el.e);
  const yv = el.a * (Math.sqrt(1 - el.e * el.e) * Math.sin(E));
  const w = el.w * DEG;
  const om = el.om * DEG;
  const i = el.i * DEG;
  const xh =
    (Math.cos(w) * Math.cos(om) - Math.sin(w) * Math.sin(om) * Math.cos(i)) * xv +
    (-Math.sin(w) * Math.cos(om) - Math.cos(w) * Math.sin(om) * Math.cos(i)) * yv;
  const yh =
    (Math.cos(w) * Math.sin(om) + Math.sin(w) * Math.cos(om) * Math.cos(i)) * xv +
    (-Math.sin(w) * Math.sin(om) + Math.cos(w) * Math.cos(om) * Math.cos(i)) * yv;
  const zh = (Math.sin(w) * Math.sin(i)) * xv + (Math.cos(w) * Math.sin(i)) * yv;
  return { x: xh, y: yh, z: zh };
}

// Build an ellipse path (heliocentric ecliptic, projected to x/y) for drawing.
export function orbitPath(el: Elements, steps = 180): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  const w = el.w * DEG;
  const om = el.om * DEG;
  const i = el.i * DEG;
  for (let s = 0; s <= steps; s++) {
    const E = (s / steps) * 2 * Math.PI;
    const xv = el.a * (Math.cos(E) - el.e);
    const yv = el.a * (Math.sqrt(1 - el.e * el.e) * Math.sin(E));
    const xh =
      (Math.cos(w) * Math.cos(om) - Math.sin(w) * Math.sin(om) * Math.cos(i)) * xv +
      (-Math.sin(w) * Math.cos(om) - Math.cos(w) * Math.sin(om) * Math.cos(i)) * yv;
    const yh =
      (Math.cos(w) * Math.sin(om) + Math.sin(w) * Math.cos(om) * Math.cos(i)) * xv +
      (-Math.sin(w) * Math.sin(om) + Math.cos(w) * Math.cos(om) * Math.cos(i)) * yv;
    pts.push({ x: xh, y: yh });
  }
  return pts;
}

// Full 3D heliocentric ecliptic orbit path (AU) including z, for WebGL plots.
export function orbitPath3D(el: Elements, steps = 220): Array<{ x: number; y: number; z: number }> {
  const pts: Array<{ x: number; y: number; z: number }> = [];
  const w = el.w * DEG;
  const om = el.om * DEG;
  const i = el.i * DEG;
  for (let s = 0; s <= steps; s++) {
    const E = (s / steps) * 2 * Math.PI;
    const xv = el.a * (Math.cos(E) - el.e);
    const yv = el.a * (Math.sqrt(1 - el.e * el.e) * Math.sin(E));
    const xh =
      (Math.cos(w) * Math.cos(om) - Math.sin(w) * Math.sin(om) * Math.cos(i)) * xv +
      (-Math.sin(w) * Math.cos(om) - Math.cos(w) * Math.sin(om) * Math.cos(i)) * yv;
    const yh =
      (Math.cos(w) * Math.sin(om) + Math.sin(w) * Math.cos(om) * Math.cos(i)) * xv +
      (-Math.sin(w) * Math.sin(om) + Math.cos(w) * Math.cos(om) * Math.cos(i)) * yv;
    const zh = (Math.sin(w) * Math.sin(i)) * xv + (Math.cos(w) * Math.sin(i)) * yv;
    pts.push({ x: xh, y: yh, z: zh });
  }
  return pts;
}

// --- Satellites (CelesTrak GP / OMM mean elements) -----------------------
// Two-body (Keplerian) propagation from the published mean elements. This is a
// simplification of full SGP4 (no drag / J2 secular terms), but the orbital
// elements themselves are the REAL, current values published by CelesTrak, so
// positions are physically grounded — they drift slowly from epoch rather than
// being invented. Good enough for a stylised lunar-distance scope.
export interface Sat {
  a: number; // km
  e: number;
  i: number; // deg
  om: number; // deg, RA of ascending node
  w: number; // deg, argument of perigee
  ma: number; // deg, mean anomaly at epoch
  epochMs: number;
}

// Geocentric EQUATORIAL (ECI-like) position in km.
function satEciKm(s: Sat, date: Date): { x: number; y: number; z: number } {
  const n = Math.sqrt(MU_EARTH / (s.a * s.a * s.a)); // rad/s
  const dt = (date.getTime() - s.epochMs) / 1000; // seconds since epoch
  const M = s.ma * DEG + n * dt;
  const E = solveKepler(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), s.e);
  const xv = s.a * (Math.cos(E) - s.e);
  const yv = s.a * (Math.sqrt(1 - s.e * s.e) * Math.sin(E));
  const w = s.w * DEG, om = s.om * DEG, i = s.i * DEG;
  const x =
    (Math.cos(w) * Math.cos(om) - Math.sin(w) * Math.sin(om) * Math.cos(i)) * xv +
    (-Math.sin(w) * Math.cos(om) - Math.cos(w) * Math.sin(om) * Math.cos(i)) * yv;
  const y =
    (Math.cos(w) * Math.sin(om) + Math.sin(w) * Math.cos(om) * Math.cos(i)) * xv +
    (-Math.sin(w) * Math.sin(om) + Math.cos(w) * Math.cos(om) * Math.cos(i)) * yv;
  const z = (Math.sin(w) * Math.sin(i)) * xv + (Math.cos(w) * Math.sin(i)) * yv;
  return { x, y, z };
}

// Geocentric ECLIPTIC position in km (rotates ECI equatorial by the obliquity)
// so satellites share the same frame as the Moon and the NEO geocentric tracks.
export function satEclipticKm(s: Sat, date: Date): { x: number; y: number; z: number } {
  const p = satEciKm(s, date);
  const ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
  return { x: p.x, y: p.y * ce + p.z * se, z: -p.y * se + p.z * ce };
}

// Approximate elements for a single named planet at a date (Standish set below).
function planetElementsAt(idx: number, date: Date): Elements {
  const p = PLANETS[idx];
  const T = (dateToJD(date) - 2451545.0) / 36525;
  const a = p.base[0] + p.rate[0] * T;
  const e = p.base[1] + p.rate[1] * T;
  const I = p.base[2] + p.rate[2] * T;
  const L = p.base[3] + p.rate[3] * T;
  const peri = p.base[4] + p.rate[4] * T;
  const node = p.base[5] + p.rate[5] * T;
  return { a, e, i: I, om: node, w: peri - node, ma: norm360(L - peri), epochJD: dateToJD(date) };
}

// Heliocentric ecliptic position of Earth (AU) — used to build geocentric tracks.
export function earthPosition(date: Date): { x: number; y: number; z: number } {
  return orbitPosition(planetElementsAt(2, date), date);
}

// Heliocentric ecliptic UNIT direction for a DONKI space-weather source given
// in Stonyhurst heliographic coordinates (lon 0 = the Sun–Earth line, +W, +N).
// We anchor longitude 0 to Earth's current ecliptic longitude so an Earth-
// directed event (lon≈0, lat≈0) points straight at Earth's plotted position,
// and fold heliographic latitude into the ecliptic z. The Sun's 7.25° axial
// tilt is neglected — this is a stylised solar scope, not an ephemeris.
export function helioDirEcliptic(
  lonDeg: number,
  latDeg: number,
  date: Date
): { x: number; y: number; z: number } {
  const ep = earthPosition(date); // heliocentric ecliptic (AU)
  const earthLon = Math.atan2(ep.y, ep.x); // ecliptic longitude of Earth (rad)
  const lon = earthLon + lonDeg * DEG;
  const lat = latDeg * DEG;
  const cl = Math.cos(lat);
  return { x: cl * Math.cos(lon), y: cl * Math.sin(lon), z: Math.sin(lat) };
}

// Low-precision geocentric ecliptic longitude of the Moon (radians), Meeus mean
// longitude term — paired with moonDistanceKm to place the Moon in 3D.
export function moonEclipticLongitude(date: Date): number {
  const T = (dateToJD(date) - 2451545.0) / 36525;
  return norm360(218.3164477 + 481267.88123421 * T) * DEG;
}

// Standish (JPL) approximate elements, valid 1800–2050. [a,e,I,L,peri,node]
// and per-century rates. Source: JPL SSD "Approximate Positions of the Planets".
interface PlanetEl {
  name: string;
  base: [number, number, number, number, number, number];
  rate: [number, number, number, number, number, number];
  color: string;
}

const PLANETS: PlanetEl[] = [
  {
    name: "Mercury",
    base: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
    color: "#7be4d6",
  },
  {
    name: "Venus",
    base: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    rate: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
    color: "#9fe9dd",
  },
  {
    name: "Earth",
    base: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
    rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
    color: "#39d6c8",
  },
  {
    name: "Mars",
    base: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
    color: "#5fd8c8",
  },
  {
    name: "Jupiter",
    base: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
    color: "#4cbfb2",
  },
];

export interface PlanetState {
  name: string;
  a: number;
  x: number;
  y: number;
  color: string;
  path: Array<{ x: number; y: number }>;
}

export interface PlanetState3D {
  name: string;
  a: number;
  color: string;
  pos: { x: number; y: number; z: number };
  path: Array<{ x: number; y: number; z: number }>;
}

export function planetStates3D(date: Date): PlanetState3D[] {
  return PLANETS.map((p, idx) => {
    const el = planetElementsAt(idx, date);
    return { name: p.name, a: el.a, color: p.color, pos: orbitPosition(el, date), path: orbitPath3D(el, 200) };
  });
}

export function planetStates(date: Date): PlanetState[] {
  const T = (dateToJD(date) - 2451545.0) / 36525;
  return PLANETS.map((p) => {
    const a = p.base[0] + p.rate[0] * T;
    const e = p.base[1] + p.rate[1] * T;
    const I = p.base[2] + p.rate[2] * T;
    const L = p.base[3] + p.rate[3] * T;
    const peri = p.base[4] + p.rate[4] * T;
    const node = p.base[5] + p.rate[5] * T;
    const w = peri - node;
    const ma = norm360(L - peri);
    const el: Elements = { a, e, i: I, om: node, w, ma, epochJD: dateToJD(date) };
    const pos = orbitPosition(el, date);
    return { name: p.name, a, x: pos.x, y: pos.y, color: p.color, path: orbitPath(el, 160) };
  });
}
