export interface SentryInfo {
  ip: number | null; // cumulative impact probability
  ps: number | null; // Palermo scale (max)
  ts: number | null; // Torino scale (max)
  nImp: number | null;
}

export interface NeoObject {
  id: string;
  des: string;
  fullname: string;
  orbitId: string;
  jd: number;
  cd: string;
  epochMs: number;
  distLd: number;
  distMinLd: number;
  distMaxLd: number;
  vRelKms: number;
  vInfKms: number;
  tSigma: string;
  h: number | null;
  monitored: boolean; // on JPL Sentry watch list (nonzero, usually negligible, long-term impact probability)
  sentry: SentryInfo | null;
}

// Real on-orbit satellite, parsed from CelesTrak GP (OMM) mean elements.
export interface SatElements {
  name: string;
  noradId: number;
  a: number; // km, semi-major axis derived from mean motion
  e: number;
  i: number; // deg, inclination
  om: number; // deg, RA of ascending node
  w: number; // deg, argument of perigee
  ma: number; // deg, mean anomaly at epoch
  epochMs: number;
  cat: SatCat; // constellation class: starlink | oneweb | weather | gps | geo | other
  // Geocentric ECLIPTIC position (km), propagated server-side from the real mean
  // elements at `posAt`. Persisted in the snapshot cache so a stored catalogue
  // carries actual positions, not just elements. The live view still re-propagates
  // from the elements above for the current instant.
  pos?: { x: number; y: number; z: number };
  posAt?: number; // epoch ms the position vector was computed for
}

export type SatCat = "starlink" | "oneweb" | "weather" | "gps" | "geo" | "other";

export interface SatResponse {
  ok: boolean;
  sats: SatElements[];
  counts: Record<SatCat, number>; // real active-satellite count per class
  total: number; // total active satellites tracked (no debris / rocket bodies)
  dotScale: number; // satellites represented by each plotted dot
  requests: ApiRequestLog[];
  computedAt?: number; // epoch ms the satellite position vectors were propagated for
  cached?: boolean; // served from the persisted snapshot (CelesTrak unreachable)
  cachedAt?: number; // epoch ms the cached snapshot was captured
  retryAfter?: number; // local cooldown epoch after a failed CelesTrak refresh
  error?: string;
}

export interface ApiRequestLog {
  label: string;
  url: string;
  status: number;
  count: number;
}

export interface CadResponse {
  ok: boolean;
  source: string;
  version: string;
  windowMin: number;
  windowMax: number;
  count: number;
  sentryCount: number;
  requests: ApiRequestLog[];
  objects: NeoObject[];
  raw: string;
  computedAt?: number; // epoch ms the close-approach catalogue was fetched
  cached?: boolean; // served from the last good payload (JPL unreachable)
  cachedAt?: number; // epoch ms the cached catalogue was captured
  error?: string;
}

export interface OrbitElements {
  a: number;
  e: number;
  i: number;
  om: number;
  w: number;
  ma: number;
  epochJD: number;
}

export interface ElementsResponse {
  ok: boolean;
  elements: Record<string, OrbitElements>;
  error?: string;
}

// ---- DONKI space weather (NASA/CCMC) ------------------------------------
// Normalised, compact projections of the raw DONKI CME / FLR / GST records.
// All times are epoch ms; all angles degrees. Nothing is invented — every
// value is carried straight from the DONKI web service.

export type CmeType = "S" | "C" | "O" | "R" | "ER" | ""; // slow → extremely rare

export interface CmeEvent {
  id: string; // DONKI activityID
  startMs: number; // first observation time
  lat: number | null; // heliographic latitude (deg)
  lon: number | null; // Stonyhurst heliographic longitude (deg); 0 = Sun–Earth line
  halfAngle: number | null; // angular half-width of the cone (deg)
  speed: number | null; // km/s, plane-of-sky / radial speed
  type: CmeType;
  note: string;
  earthDirected: boolean; // DONKI/Enlil flags an Earth impact (or |lon|,|lat| small)
  arrivalMs: number | null; // estimated Earth shock-arrival time, if modelled
  glancing: boolean; // Enlil glancing-blow flag
}

export type FlareClass = "A" | "B" | "C" | "M" | "X";

export interface FlareEvent {
  id: string;
  beginMs: number;
  peakMs: number;
  endMs: number | null;
  classType: string; // raw e.g. "M6.8"
  cls: FlareClass; // letter band
  magnitude: number; // numeric part, e.g. 6.8
  flux: number; // absolute soft X-ray flux W/m^2 (for a log scale)
  sourceLocation: string; // raw e.g. "S09E57"
  lat: number | null; // parsed heliographic latitude (deg)
  lon: number | null; // parsed heliographic longitude (deg)
  activeRegion: number | null;
}

export interface KpSample {
  tMs: number;
  kp: number; // planetary K index, 0–9
}

export interface GeoStormEvent {
  id: string;
  startMs: number;
  maxKp: number;
  kp: KpSample[];
}

export interface SpaceWeatherResponse {
  ok: boolean;
  source: string;
  windowMin: number;
  windowMax: number;
  cmes: CmeEvent[];
  flares: FlareEvent[];
  storms: GeoStormEvent[];
  kp: KpSample[]; // flattened, de-duplicated, time-sorted Kp series
  requests: ApiRequestLog[];
  computedAt?: number;
  cached?: boolean; // served from the last good payload (DONKI unreachable)
  cachedAt?: number;
  error?: string;
}

export interface SbdbResponse {
  ok: boolean;
  fullname: string;
  source: string;
  a: number | null;
  e: number | null;
  i: number | null;
  om: number | null;
  w: number | null;
  ma: number | null;
  epochJD: number | null;
  per: number | null;
  q: number | null;
  ad: number | null;
  classType: string;
  request: ApiRequestLog;
  raw: string;
  error?: string;
}
