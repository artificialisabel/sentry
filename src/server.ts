import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCD } from "./lib/format";
import { AU_TO_LD, MU_EARTH, satEclipticKm } from "./lib/astro";
import type { CadResponse, CmeEvent, ElementsResponse, FlareClass, FlareEvent, GeoStormEvent, KpSample, NeoObject, OrbitElements, SatElements, SatResponse, SbdbResponse, SentryInfo, SpaceWeatherResponse } from "./lib/types";

type StoredSnapshotFile = { snapshots: Array<{ payload: SatResponse; savedAt: number }> };
const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = process.env.VERCEL
  ? "/tmp/sentry-satellite-snapshots.json"
  : join(__dirname, "..", ".cache", "satellite-snapshots.json");

async function readSnapshotFile(): Promise<StoredSnapshotFile> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf8")) as StoredSnapshotFile;
  } catch {
    return { snapshots: [] };
  }
}

async function writeSnapshotPayload(payload: SatResponse): Promise<void> {
  const current = await readSnapshotFile();
  const next: StoredSnapshotFile = {
    snapshots: [{ payload, savedAt: Date.now() }, ...current.snapshots].slice(0, 3),
  };
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(next, null, 2));
}

async function readSnapshotResponse(): Promise<{ snapshot: StoredSnap | null }> {
  const file = await readSnapshotFile();
  return { snapshot: file.snapshots[0] ?? null };
}



const JPL_HEADERS = {
  "user-agent": "near-earth-encounter-scope/1.0 (educational orbital visualiser)",
  accept: "application/json",
};

// Small in-isolate cache to be a courteous API consumer (JPL/NASA guidelines
// ask clients to avoid hammering the public endpoints).
const cache = new Map<string, { t: number; body: any }>();
// Only these fixed public science endpoints may ever be contacted. The app
// never fetches a viewer-supplied URL — callers build URLs from one of these
// hosts plus app-specific query parameters.
// The two fixed public science origins this app is allowed to contact. The
// origin is ALWAYS a literal here; callers may only choose a known endpoint
// path and supply app-specific query parameters (date windows, object
// designations, catalogue group). No viewer-supplied URL ever reaches fetch.
const API_ORIGINS = {
  jpl: "https://ssd-api.jpl.nasa.gov",
  celestrak: "https://celestrak.org",
  // DONKI space-weather API (NASA). Served through api.nasa.gov, which the
  // running host can reach reliably (the underlying CCMC origin is not always
  // routable from a server runtime). Requires an api_key — DEMO_KEY works out
  // of the box thanks to the multi-hour cache below; set NASA_API_KEY to use a
  // personal key (free, instant at https://api.nasa.gov) for higher limits.
  donki: "https://api.nasa.gov",
} as const;

// NASA api.nasa.gov key. DEMO_KEY is rate-limited (30/hr, 50/day per IP) but
// our 6h server-side cache means at most a handful of calls per day.
const NASA_API_KEY = process.env.NASA_API_KEY ?? "DEMO_KEY";
type ApiHost = keyof typeof API_ORIGINS;

async function fetchJSON(
  host: ApiHost,
  path: string,
  params: Record<string, string>,
  ttlMs: number,
): Promise<{ status: number; body: any }> {
  // new URL(path, literalOrigin) pins the origin to a constant; query params
  // are appended via the URLSearchParams API, never string-concatenated.
  const u = new URL(path, API_ORIGINS[host]);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const key = `${host}:${u.pathname}${u.search}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return { status: 200, body: hit.body };
  let res: Response;
  if (host === "jpl") {
    res = await fetch(new URL(`${u.pathname}${u.search}`, "https://ssd-api.jpl.nasa.gov"), { headers: JPL_HEADERS });
  } else if (host === "donki") {
    res = await fetch(new URL(`${u.pathname}${u.search}`, "https://api.nasa.gov"), { headers: JPL_HEADERS });
  } else {
    res = await fetch(new URL(`${u.pathname}${u.search}`, "https://celestrak.org"), { headers: JPL_HEADERS });
  }
  const body = await res.json().catch(() => null);
  if (res.ok && body) cache.set(key, { t: Date.now(), body });
  return { status: res.status, body };
}

const normDes = (s: string) => s.replace(/[()]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

// Asteroid close-approach data refreshes slowly, so we only hit the JPL CAD +
// Sentry endpoints at most once every 12 hours and keep the last successful
// payload in-isolate so a JPL outage still serves the most recent known catalogue.
const CAD_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
let lastGoodCad: CadResponse | null = null;

function serveCachedCad(requests: CadResponse["requests"]): Response | null {
  if (!lastGoodCad) return null;
  const payload: CadResponse = {
    ...lastGoodCad,
    cached: true,
    cachedAt: lastGoodCad.computedAt ?? Date.now(),
    requests: [...requests, ...lastGoodCad.requests],
  };
  return Response.json(payload, { headers: { "cache-control": "no-store" } });
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function handleCad(): Promise<Response> {
  const now = Date.now();
  const min = new Date(now - 20 * 86400000);
  const max = new Date(now + 70 * 86400000);
  const cadParams = {
    "date-min": ymd(min),
    "date-max": ymd(max),
    "dist-max": "0.05",
    "body": "Earth",
    "sort": "date",
    "fullname": "true",
  };
  const cadUrl = "https://ssd-api.jpl.nasa.gov/cad.api?" + new URLSearchParams(cadParams).toString();
  const sentryUrl = "https://ssd-api.jpl.nasa.gov/sentry.api";

  const requests: CadResponse["requests"] = [];
  let objects: NeoObject[] = [];
  let source = "JPL SSD/CNEOS";
  let version = "";
  let raw = "";

  try {
    const cad = await fetchJSON("jpl", "/cad.api", cadParams, CAD_TTL_MS);
    requests.push({ label: "JPL CAD", url: cadUrl, status: cad.status, count: cad.body?.data?.length ?? 0 });
    if (!cad.body || !Array.isArray(cad.body.data)) {
      return serveCachedCad(requests) ?? Response.json({ ok: false, error: "CAD returned no data", requests } satisfies Partial<CadResponse>, { status: 502 });
    }
    source = cad.body.signature?.source ?? source;
    version = cad.body.signature?.version ?? "";
    const f: string[] = cad.body.fields;
    const col = (n: string) => f.indexOf(n);
    const ci = {
      des: col("des"), cd: col("cd"), jd: col("jd"), dist: col("dist"),
      distMin: col("dist_min"), distMax: col("dist_max"), vRel: col("v_rel"),
      vInf: col("v_inf"), t: col("t_sigma_f"), h: col("h"), orbit: col("orbit_id"),
      full: col("fullname"),
    };
    raw = JSON.stringify(cad.body.data.slice(0, 6), null, 1);

    // Sentry: objects with nonzero impact probability.
    const sentryMap = new Map<string, SentryInfo>();
    let sentryCount = 0;
    try {
      const sentry = await fetchJSON("jpl", "/sentry.api", {}, CAD_TTL_MS);
      requests.push({ label: "JPL Sentry", url: sentryUrl, status: sentry.status, count: sentry.body?.data?.length ?? 0 });
      if (Array.isArray(sentry.body?.data)) {
        sentryCount = sentry.body.data.length;
        for (const row of sentry.body.data) {
          const key = normDes(String(row.des ?? ""));
          sentryMap.set(key, {
            ip: row.ip != null ? +row.ip : null,
            ps: row.ps_max != null ? +row.ps_max : null,
            ts: row.ts_max != null ? +row.ts_max : null,
            nImp: row.n_imp != null ? +row.n_imp : null,
          });
        }
      }
    } catch {
      requests.push({ label: "JPL Sentry", url: sentryUrl, status: 0, count: 0 });
    }

    objects = (cad.body.data as any[][])
      .map((row, idx): NeoObject => {
        const distAu = parseFloat(row[ci.dist]);
        const des = String(row[ci.des]);
        const key = normDes(des);
        const sentry = sentryMap.get(key) ?? null;
        return {
          id: `${des}-${row[ci.jd]}-${idx}`,
          des,
          fullname: ci.full >= 0 ? String(row[ci.full]).trim() : des,
          orbitId: ci.orbit >= 0 ? String(row[ci.orbit]) : "",
          jd: parseFloat(row[ci.jd]),
          cd: String(row[ci.cd]),
          epochMs: parseCD(String(row[ci.cd])),
          distLd: distAu * AU_TO_LD,
          distMinLd: parseFloat(row[ci.distMin]) * AU_TO_LD,
          distMaxLd: parseFloat(row[ci.distMax]) * AU_TO_LD,
          vRelKms: parseFloat(row[ci.vRel]),
          vInfKms: parseFloat(row[ci.vInf]),
          tSigma: ci.t >= 0 ? String(row[ci.t]) : "n/a",
          h: ci.h >= 0 && row[ci.h] != null && row[ci.h] !== "" ? parseFloat(row[ci.h]) : null,
          monitored: !!sentry,
          sentry,
        };
      })
      .filter((o) => isFinite(o.epochMs))
      .sort((a, b) => a.epochMs - b.epochMs)
      .slice(0, 120);

    const payload: CadResponse = {
      ok: true,
      source,
      version,
      windowMin: min.getTime(),
      windowMax: max.getTime(),
      count: objects.length,
      sentryCount,
      requests,
      objects,
      raw,
      computedAt: Date.now(),
    };
    lastGoodCad = payload;
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (err: any) {
    return serveCachedCad(requests) ?? Response.json({ ok: false, error: String(err?.message ?? err), requests } satisfies Partial<CadResponse>, { status: 502 });
  }
}

async function handleSbdb(des: string): Promise<Response> {
  const url = "https://ssd-api.jpl.nasa.gov/sbdb.api?" + new URLSearchParams({ sstr: des, "full-prec": "false" }).toString();
  try {
    const r = await fetchJSON("jpl", "/sbdb.api", { sstr: des, "full-prec": "false" }, 30 * 60000);
    const body = r.body;
    const els: any[] = body?.orbit?.elements ?? [];
    const get = (n: string) => {
      const el = els.find((e) => e.name === n);
      return el && el.value != null ? parseFloat(el.value) : null;
    };
    const payload: SbdbResponse = {
      ok: !!body?.orbit,
      fullname: body?.object?.fullname ?? des,
      source: "JPL SBDB",
      a: get("a"),
      e: get("e"),
      i: get("i"),
      om: get("om"),
      w: get("w"),
      ma: get("ma"),
      epochJD: body?.orbit?.epoch != null ? parseFloat(body.orbit.epoch) : null,
      per: get("per"),
      q: get("q"),
      ad: get("ad"),
      classType: body?.object?.orbit_class?.name ?? body?.orbit?.orbit_class?.name ?? "",
      request: { label: "JPL SBDB", url, status: r.status, count: els.length },
      raw: JSON.stringify({ object: body?.object?.fullname, epoch: body?.orbit?.epoch, elements: els?.slice(0, 8) }, null, 1),
    };
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (err: any) {
    return Response.json({ ok: false, error: String(err?.message ?? err) } satisfies Partial<SbdbResponse>, { status: 502 });
  }
}

// Batch SBDB orbital-element fetch for plotting real NEO paths in 3D. Capped and
// throttled to stay courteous to the JPL public endpoints (results are cached).
async function handleElements(desList: string[]): Promise<Response> {
  const unique = [...new Set(desList.map((s) => s.trim()).filter(Boolean))].slice(0, 22);
  const elements: Record<string, OrbitElements> = {};

  const fetchOne = async (des: string) => {
    const url = "https://ssd-api.jpl.nasa.gov/sbdb.api?" + new URLSearchParams({ sstr: des, "full-prec": "false" }).toString();
    try {
      const r = await fetchJSON("jpl", "/sbdb.api", { sstr: des, "full-prec": "false" }, 6 * 60 * 60000);
      const els: any[] = r.body?.orbit?.elements ?? [];
      const get = (n: string) => {
        const el = els.find((e) => e.name === n);
        return el && el.value != null ? parseFloat(el.value) : null;
      };
      const a = get("a"), e = get("e"), i = get("i"), om = get("om"), w = get("w"), ma = get("ma");
      const epochJD = r.body?.orbit?.epoch != null ? parseFloat(r.body.orbit.epoch) : null;
      if (a != null && e != null && i != null && om != null && w != null && ma != null && epochJD != null) {
        elements[des] = { a, e, i, om, w, ma, epochJD };
      }
    } catch {
      /* skip object on failure — only real, resolved elements are returned */
    }
  };

  // SEQUENTIAL — the JPL SSD/CNEOS API guidelines ask clients to issue queries
  // one at a time rather than firing parallel/simultaneous requests at the
  // public endpoints. Cached results make repeat passes cheap.
  for (const des of unique) {
    await fetchOne(des);
  }

  return Response.json({ ok: true, elements } satisfies ElementsResponse, { headers: { "cache-control": "no-store" } });
}

// Live satellite catalogue from CelesTrak's GP (General Perturbations) API.
// Per CelesTrak's access guidelines we (1) identify with a descriptive
// User-Agent, (2) query the GP endpoint sequentially — one GROUP at a time,
// never in parallel — and (3) cache each group for a FULL WEEK so the public
// service is hit at most once a week per group. Positions are then propagated
// locally in the browser from these mean elements; we never re-fetch to animate.
const SATELLITE_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // one week
const ISS_NORAD = 25544;

type SatCat = SatElements["cat"];

const SAT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // back off 12h after a failed live fetch
let satelliteRetryAfter = 0;

type StoredSnap = { payload: SatResponse; savedAt: number };

async function readSnapshot(): Promise<StoredSnap | null> {
  try {
    const j = await readSnapshotResponse();
    const snap = j?.snapshot;
    if (snap && snap.payload && Array.isArray(snap.payload.sats) && snap.payload.sats.length > 0) return snap;
  } catch {/* no usable snapshot */}
  return null;
}

async function storeSnapshot(payload: SatResponse): Promise<void> {
  try {
    await writeSnapshotPayload(payload);
  } catch {/* best effort */}
}

// The TRUE capture time of the catalogue (when CelesTrak was actually read),
// preserved across cooldown re-stamps so freshness is judged on real data age
// rather than the moment we last touched the row.
const snapCaptureAt = (snap: StoredSnap): number => snap.payload.computedAt ?? snap.savedAt;

function serveCachedSnapshot(snap: StoredSnap, requests: SatResponse["requests"]): Response {
  return Response.json({
    ...snap.payload,
    ok: true,
    cached: true,
    cachedAt: snapCaptureAt(snap),
    requests: [...requests, ...(snap.payload.requests ?? [])],
  } satisfies SatResponse, { headers: { "cache-control": "no-store" } });
}

function emptySat(requests: SatResponse["requests"], error: string): Response {
  return Response.json({
    ok: false, sats: [], counts: { starlink: 0, oneweb: 0, weather: 0, gps: 0, geo: 0, other: 0 },
    total: 0, dotScale: 10, requests, error,
  } satisfies SatResponse, { headers: { "cache-control": "no-store" } });
}

// Cache-first satellite policy. The 12h cooldown is persisted INSIDE the stored
// snapshot payload (as `retryAfter`), so only the local snapshot JSON file is
// needed — no external cache service:
//   (i)   read the local satellite snapshot first
//   (ii)  if the captured data is fresher than 7 days, serve it immediately
//   (iii) only contact CelesTrak when there is no snapshot captured inside 7 days
//   (iv)  if CelesTrak fails, stamp a 12h cooldown and serve the stale snapshot
async function handleSats(): Promise<Response> {
  const requests: SatResponse["requests"] = [];
  const nowMs = Date.now();

  // (i) snapshot first.
  const snap = await readSnapshot();

  // (ii) serve a snapshot whose data was captured within the last 7 days.
  if (snap && nowMs - snapCaptureAt(snap) < SATELLITE_REFRESH_MS) {
    requests.push({ label: "LOCAL satellite snapshot", url: "cache://satellite-snapshots", status: 200, count: snap.payload.sats.length });
    return serveCachedSnapshot(snap, requests);
  }

  // (iv) honour an active cooldown stamped onto the snapshot after a prior fail.
  const retryAfter = Number(snap?.payload.retryAfter ?? 0);
  if (snap && retryAfter > nowMs) {
    requests.push({ label: "CELESTRAK cooldown", url: "cooldown://12h", status: 0, count: 0 });
    return serveCachedSnapshot(snap, requests);
  }
  if (!snap && satelliteRetryAfter > nowMs) {
    requests.push({ label: "CELESTRAK cooldown", url: "cooldown://12h", status: 0, count: 0 });
    return emptySat(requests, "CelesTrak retry cooldown active");
  }

  // (iii) no fresh snapshot and not in cooldown — pull the live catalogue.
  const live = await fetchCelestrak(requests, nowMs);
  if (live) return Response.json(live, { headers: { "cache-control": "no-store" } });

  // Live fetch failed — stamp a 12h cooldown onto the stale snapshot (preserving
  // its real capture time via computedAt) so we will not retry for 12h.
  if (snap) {
    const restamped: SatResponse = { ...snap.payload, retryAfter: nowMs + SAT_COOLDOWN_MS };
    await storeSnapshot(restamped);
    return serveCachedSnapshot({ payload: restamped, savedAt: nowMs }, requests);
  }
  satelliteRetryAfter = nowMs + SAT_COOLDOWN_MS;
  return emptySat(requests, "CelesTrak unreachable and no cached snapshot available");
}

// Pull the live ACTIVE catalogue from CelesTrak, classify + propagate it, store
// the snapshot, and return the payload — or null when the upstream gave nothing.
async function fetchCelestrak(requests: SatResponse["requests"], computedAt: number): Promise<SatResponse | null> {
  // ONE request: the ACTIVE catalogue (operational payloads only — CelesTrak
  // excludes debris, spent rocket bodies and decayed objects from this set).
  // Fetching a single group instead of nine keeps us well under CelesTrak's
  // rate limit, which is what caused the empty (0-satellite) responses.
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json`;
  const active = new Map<number, any>();
  try {
    const r = await fetchJSON("celestrak", "/NORAD/elements/gp.php", { GROUP: "active", FORMAT: "json" }, SATELLITE_REFRESH_MS);
    const arr: any[] = Array.isArray(r.body) ? r.body : [];
    requests.push({ label: "CELESTRAK active", url, status: r.status, count: arr.length });
    for (const o of arr) {
      const id = Number(o?.NORAD_CAT_ID);
      if (isFinite(id)) active.set(id, o);
    }
  } catch {
    requests.push({ label: "CELESTRAK active", url, status: 0, count: 0 });
  }

  // Classify each real payload from its catalogue OBJECT_NAME (and orbit shape
  // for the geostationary belt). Every value comes straight from CelesTrak — we
  // only group the objects, we never invent membership.
  const GNSS_RE = /\b(GPS|NAVSTAR|GLONASS|GALILEO|GSAT|BEIDOU|IRNSS|NAVIC|QZS)\b/;
  const WX_RE = /\b(NOAA|METEOR|METOP|GOES|DMSP|FENGYUN|FY-|HIMAWARI|ELEKTRO|INSAT|JPSS|SUOMI|TERRA|AQUA)\b/;
  const classify = (o: any): SatCat => {
    const n = String(o?.OBJECT_NAME ?? "").toUpperCase();
    if (n.startsWith("STARLINK")) return "starlink";
    if (n.startsWith("ONEWEB")) return "oneweb";
    if (GNSS_RE.test(n)) return "gps";
    if (WX_RE.test(n)) return "weather";
    // Geostationary belt: ~1 sidereal revolution/day, near-circular, near-equatorial.
    const mm = Number(o?.MEAN_MOTION), e = Number(o?.ECCENTRICITY), inc = Number(o?.INCLINATION);
    if (isFinite(mm) && mm > 0.9 && mm < 1.1 && isFinite(e) && e < 0.05 && isFinite(inc) && inc < 15) return "geo";
    return "other";
  };

  const counts: Record<SatCat, number> = { starlink: 0, oneweb: 0, weather: 0, gps: 0, geo: 0, other: 0 };
  const buckets: Record<SatCat, any[]> = { starlink: [], oneweb: [], weather: [], gps: [], geo: [], other: [] };
  for (const [, o] of active) {
    const cat = classify(o);
    counts[cat]++;
    buckets[cat].push(o);
  }
  const total = active.size;

  // Each plotted dot stands for DOT_SCALE satellites: we keep every Nth payload
  // per class so the rendered field preserves real proportions while staying
  // light enough to propagate ~1k orbits per frame in the browser.
  const DOT_SCALE = 10;
  const sats: SatElements[] = [];
  const push = (o: any, cat: SatCat): boolean => {
    const id = Number(o?.NORAD_CAT_ID);
    const mm = Number(o?.MEAN_MOTION); // rev/day
    if (!isFinite(mm) || mm <= 0) return false;
    const nRad = mm * 2 * Math.PI / 86400; // a = (mu / n^2)^(1/3)
    const a = Math.cbrt(MU_EARTH / (nRad * nRad));
    const epochMs = Date.parse(String(o?.EPOCH).endsWith("Z") ? o.EPOCH : `${o?.EPOCH}Z`);
    const e = Number(o?.ECCENTRICITY), i = Number(o?.INCLINATION);
    const om = Number(o?.RA_OF_ASC_NODE), w = Number(o?.ARG_OF_PERICENTER), ma = Number(o?.MEAN_ANOMALY);
    if (![a, e, i, om, w, ma, epochMs].every((v) => isFinite(v))) return false;
    sats.push({ name: String(o?.OBJECT_NAME ?? `NORAD ${id}`).trim(), noradId: id, a, e, i, om, w, ma, epochMs, cat });
    return true;
  };

  for (const cat of Object.keys(buckets) as SatCat[]) {
    const arr = buckets[cat];
    for (let k = 0; k < arr.length; k += DOT_SCALE) push(arr[k], cat);
  }
  // Always plot the ISS itself (it gets a distinctive icon client-side).
  const iss = active.get(ISS_NORAD);
  if (iss && !sats.some((s) => s.noradId === ISS_NORAD)) push(iss, classify(iss));

  // Propagate each real satellite from its published mean elements to the fetch
  // instant and attach the resulting geocentric ecliptic position (km). These
  // vectors are stored in the snapshot cache so the catalogue carries actual
  // positions, not just orbital elements. The live scene still re-propagates.
  const now = new Date(computedAt);
  for (const s of sats) {
    const p = satEclipticKm(s, now);
    if (isFinite(p.x) && isFinite(p.y) && isFinite(p.z)) {
      s.pos = { x: p.x, y: p.y, z: p.z };
      s.posAt = computedAt;
    }
  }

  // Nothing usable came back (rate-limited / blocked / down).
  if (!(total > 0 && sats.length > 0)) return null;

  // Persist as the last-known-good snapshot, then return the live payload.
  const payload: SatResponse = { ok: true, sats, counts, total, dotScale: DOT_SCALE, computedAt, requests };
  try {
    await writeSnapshotPayload(payload);
  } catch {/* snapshot store is best-effort */}
  return payload;
}

// ---- DONKI space weather ------------------------------------------------
// Solar activity changes on a scale of hours/days, so we hit DONKI at most
// once every 3 hours and keep the last good payload in-isolate so an outage
// still serves the most recent known solar picture.
const SW_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
let lastGoodSpaceWeather: SpaceWeatherResponse | null = null;

const toMs = (s: unknown): number => {
  if (typeof s !== "string" || !s) return NaN;
  // DONKI stamps are "YYYY-MM-DDThh:mmZ" (sometimes without the Z) — treat as UTC.
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
};

// Soft X-ray flux floor per GOES flare class (W/m^2). Multiply by the numeric
// magnitude to get the absolute flux — the basis for a log intensity scale.
const FLARE_FLUX_BASE: Record<FlareClass, number> = {
  A: 1e-8, B: 1e-7, C: 1e-6, M: 1e-5, X: 1e-4,
};

// Parse a heliographic source string like "S09E57" or "N15W30" into signed
// [lat, lon] degrees (N/W positive, S/E negative — Stonyhurst convention).
function parseHelioLoc(s: string): { lat: number | null; lon: number | null } {
  const m = /^([NS])(\d+(?:\.\d+)?)([EW])(\d+(?:\.\d+)?)/i.exec(s.trim());
  if (!m) return { lat: null, lon: null };
  const lat = (m[1].toUpperCase() === "S" ? -1 : 1) * parseFloat(m[2]);
  const lon = (m[3].toUpperCase() === "E" ? -1 : 1) * parseFloat(m[4]);
  return { lat, lon };
}

function normalizeCmes(rows: any[]): CmeEvent[] {
  const out: CmeEvent[] = [];
  for (const c of rows) {
    const startMs = toMs(c?.startTime);
    if (!isFinite(startMs)) continue;
    const analyses: any[] = Array.isArray(c?.cmeAnalyses) ? c.cmeAnalyses : [];
    // Prefer the analyst-flagged most-accurate fit, else the fastest one.
    const a = analyses.find((x) => x?.isMostAccurate) ??
      [...analyses].sort((p, q) => (+q?.speed || 0) - (+p?.speed || 0))[0] ?? null;
    // Earth impact / arrival: scan every Enlil run on every analysis.
    let earthDirected = false, glancing = false, arrivalMs: number | null = null;
    for (const an of analyses) {
      for (const en of (Array.isArray(an?.enlilList) ? an.enlilList : [])) {
        if (en?.isEarthGB || en?.isEarthMinorImpact) earthDirected = true;
        for (const im of (Array.isArray(en?.impactList) ? en.impactList : [])) {
          if (String(im?.location ?? "").toLowerCase().includes("earth")) {
            earthDirected = true;
            if (im?.isGlancingBlow) glancing = true;
            const at = toMs(im?.arrivalTime);
            if (isFinite(at)) arrivalMs = arrivalMs == null ? at : Math.min(arrivalMs, at);
          }
        }
        const sat = toMs(en?.estimatedShockArrivalTime);
        if (isFinite(sat)) { earthDirected = true; arrivalMs = arrivalMs == null ? sat : Math.min(arrivalMs, sat); }
      }
    }
    const lon = a?.longitude != null ? +a.longitude : null;
    const lat = a?.latitude != null ? +a.latitude : null;
    // A small Earth-facing source is treated as Earth-directed even without Enlil.
    if (!earthDirected && lon != null && lat != null && Math.abs(lon) < 35 && Math.abs(lat) < 35) {
      earthDirected = true;
    }
    out.push({
      id: String(c?.activityID ?? `${startMs}`),
      startMs,
      lat,
      lon,
      halfAngle: a?.halfAngle != null ? +a.halfAngle : null,
      speed: a?.speed != null ? +a.speed : null,
      type: (a?.type ?? "") as CmeEvent["type"],
      note: String(c?.note ?? "").slice(0, 280),
      earthDirected,
      arrivalMs,
      glancing,
    });
  }
  return out.sort((p, q) => p.startMs - q.startMs);
}

function normalizeFlares(rows: any[]): FlareEvent[] {
  const out: FlareEvent[] = [];
  for (const f of rows) {
    const beginMs = toMs(f?.beginTime);
    const peakMs = toMs(f?.peakTime);
    if (!isFinite(peakMs) && !isFinite(beginMs)) continue;
    const raw = String(f?.classType ?? "").trim().toUpperCase();
    const cm = /^([ABCMX])(\d+(?:\.\d+)?)?/.exec(raw);
    const cls = (cm?.[1] ?? "C") as FlareClass;
    const magnitude = cm?.[2] ? parseFloat(cm[2]) : 1;
    const loc = parseHelioLoc(String(f?.sourceLocation ?? ""));
    out.push({
      id: String(f?.flrID ?? `${peakMs}`),
      beginMs: isFinite(beginMs) ? beginMs : peakMs,
      peakMs: isFinite(peakMs) ? peakMs : beginMs,
      endMs: isFinite(toMs(f?.endTime)) ? toMs(f?.endTime) : null,
      classType: raw,
      cls,
      magnitude,
      flux: (FLARE_FLUX_BASE[cls] ?? FLARE_FLUX_BASE.C) * magnitude,
      sourceLocation: String(f?.sourceLocation ?? ""),
      lat: loc.lat,
      lon: loc.lon,
      activeRegion: f?.activeRegionNum != null ? +f.activeRegionNum : null,
    });
  }
  return out.sort((p, q) => p.peakMs - q.peakMs);
}

function normalizeStorms(rows: any[]): { storms: GeoStormEvent[]; kp: KpSample[] } {
  const storms: GeoStormEvent[] = [];
  const allKp: KpSample[] = [];
  for (const g of rows) {
    const startMs = toMs(g?.startTime);
    if (!isFinite(startMs)) continue;
    const kp: KpSample[] = [];
    for (const k of (Array.isArray(g?.allKpIndex) ? g.allKpIndex : [])) {
      const tMs = toMs(k?.observedTime);
      const v = k?.kpIndex != null ? +k.kpIndex : NaN;
      if (isFinite(tMs) && isFinite(v)) { kp.push({ tMs, kp: v }); allKp.push({ tMs, kp: v }); }
    }
    kp.sort((p, q) => p.tMs - q.tMs);
    storms.push({
      id: String(g?.gstID ?? `${startMs}`),
      startMs,
      maxKp: kp.reduce((m, s) => Math.max(m, s.kp), 0),
      kp,
    });
  }
  // De-duplicate the flattened series by timestamp, keeping the strongest sample.
  const byT = new Map<number, number>();
  for (const s of allKp) byT.set(s.tMs, Math.max(byT.get(s.tMs) ?? 0, s.kp));
  const kp = [...byT.entries()].map(([tMs, v]) => ({ tMs, kp: v })).sort((p, q) => p.tMs - q.tMs);
  return { storms: storms.sort((p, q) => p.startMs - q.startMs), kp };
}

function serveCachedSpaceWeather(requests: SpaceWeatherResponse["requests"]): Response | null {
  if (!lastGoodSpaceWeather) return null;
  return Response.json({
    ...lastGoodSpaceWeather,
    cached: true,
    cachedAt: lastGoodSpaceWeather.computedAt ?? Date.now(),
    requests: [...requests, ...lastGoodSpaceWeather.requests],
  } satisfies SpaceWeatherResponse, { headers: { "cache-control": "no-store" } });
}

async function handleSpaceWeather(): Promise<Response> {
  const now = Date.now();
  const min = new Date(now - 30 * 86400000); // 30 days of solar history
  const max = new Date(now + 3 * 86400000); // a little into the future for arrivals
  const range = { startDate: ymd(min), endDate: ymd(max) };
  const params = { ...range, api_key: NASA_API_KEY };
  const requests: SpaceWeatherResponse["requests"] = [];

  // SEQUENTIAL fetches — one DONKI endpoint at a time, courteous to the public
  // NASA service (results are cached for 3h). The api_key is kept out of the
  // logged URL so a personal key is never surfaced to the client.
  const pull = async (label: string, path: string): Promise<any[]> => {
    const url = "https://api.nasa.gov" + path + "?" + new URLSearchParams(range).toString();
    try {
      const r = await fetchJSON("donki", path, params, SW_TTL_MS);
      const arr = Array.isArray(r.body) ? r.body : [];
      requests.push({ label, url, status: r.status, count: arr.length });
      return arr;
    } catch {
      requests.push({ label, url, status: 0, count: 0 });
      return [];
    }
  };

  try {
    const cmeRows = await pull("DONKI CME", "/DONKI/CME");
    const flrRows = await pull("DONKI FLR", "/DONKI/FLR");
    const gstRows = await pull("DONKI GST", "/DONKI/GST");

    // Treat a total wipe-out (every endpoint errored) as an outage → serve cache.
    if (requests.every((r) => r.status !== 200)) {
      const cached = serveCachedSpaceWeather(requests);
      if (cached) return cached;
    }

    const cmes = normalizeCmes(cmeRows);
    const flares = normalizeFlares(flrRows);
    const { storms, kp } = normalizeStorms(gstRows);

    const payload: SpaceWeatherResponse = {
      ok: true,
      source: "NASA DONKI",
      windowMin: min.getTime(),
      windowMax: max.getTime(),
      cmes,
      flares,
      storms,
      kp,
      requests,
      computedAt: Date.now(),
    };
    lastGoodSpaceWeather = payload;
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (err: any) {
    return serveCachedSpaceWeather(requests) ??
      Response.json({ ok: false, error: String(err?.message ?? err), requests } satisfies Partial<SpaceWeatherResponse>, { status: 502 });
  }
}

export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method !== "GET" && req.method !== "HEAD") {
    return Response.json(
      { ok: false, error: "method not allowed" },
      { status: 405, headers: { allow: "GET, HEAD" } },
    );
  }

  if (url.pathname === "/app-api/cad") return handleCad();
  if (url.pathname === "/app-api/spaceweather") return handleSpaceWeather();
  if (url.pathname === "/app-api/sats") return handleSats();
  if (url.pathname === "/app-api/sfx") {
    return Response.json({
      ok: false,
      enabled: false,
      reason: "LOCAL_AUDIO_MANIFEST_NOT_CONFIGURED",
      sfx: {},
    });
  }
  if (url.pathname === "/app-api/sbdb") {
    const des = url.searchParams.get("des") ?? "";
    if (!des) return Response.json({ ok: false, error: "missing des" }, { status: 400 });
    if (des.length > 80 || !/^[a-z0-9 ()+._\/-]+$/i.test(des)) {
      return Response.json({ ok: false, error: "invalid designation" }, { status: 400 });
    }
    return handleSbdb(des);
  }
  if (url.pathname === "/app-api/elements") {
    const des = url.searchParams.get("des") ?? "";
    if (!des) return Response.json({ ok: true, elements: {} } satisfies ElementsResponse);
    if (des.length > 1_800 || !/^[a-z0-9 (),+._\/-]+$/i.test(des)) {
      return Response.json({ ok: false, error: "invalid designations" }, { status: 400 });
    }
    return handleElements(des.split(","));
  }

  return Response.json({ ok: false, error: "not found" }, { status: 404 });
}
