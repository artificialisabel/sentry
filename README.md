# SENTRY

A retro-futurist tracking console for asteroids passing close to Earth.

**Live demo:** [sentry.artificialisabel.com](https://sentry.artificialisabel.com)

It pulls the live close-approach catalogue from NASA/JPL, joins it against JPL's Sentry
impact-risk table, fetches real orbital elements for the objects worth plotting, and
draws the whole thing as an interactive WebGL scope — with a scrubbable mission clock,
two live miniature views, a collapsible data rail, a per-object readout and a browser
for landmark deep-space missions.

Asteroid and satellite catalogue values come from public science APIs or standard
astronomical formulae evaluated locally. Spacecraft status, range and trail values are
clearly presented as curated overview data. Stars, solar particles and other scene
effects are deliberately stylised procedural graphics; they are not measurements.

## the console

- **Main map** — a three.js scene in three modes. `GEOCENTRIC` puts Earth at the
  centre with the Moon, lunar-distance rings, each asteroid's modelled position, and the
  live active-satellite field once you fly in close. `HELIOCENTRIC` steps out to the
  solar system with the planets and each object's real orbit path. `SPACECRAFT` opens
  a browseable archive of eight NASA/JPL missions with interactive 3D models,
  locally drawn schematics, mission metadata and authoritative source links.
- **Two mini maps** — the two inactive modes are always visible in the left rail.
  Click either one to promote it to the main view; the other two automatically become
  the miniatures.
- **Data feed** — the object list plus a running log of uplink status, cache hits,
  catalogue counts and public spacecraft sources.
- **Adjustable panels** — all three left-rail panels collapse independently, and the
  column and row dividers can be dragged on desktop and mobile.
- **Space weather layers** — recent coronal mass ejections and solar flares from
  NASA DONKI can be toggled directly on the heliocentric map.

Selecting an object opens a detail panel: closest approach, miss distance, relative
velocity, whether it is on Sentry watch, and its orbit class and period once SBDB
resolves. The `MISSION TIME` scrubber runs the whole encounter window.

Spacecraft ranges, speeds and overview-map trails are curated, illustrative snapshots;
they are not live ephemerides. Each craft links directly to JPL Horizons and NAIF/SPICE
for precision vectors and mission geometry.

## run it

```bash
npm install
npm run dev
```

That starts two processes together: a Vite dev server on `:5173` and a small Node API
on `:8787`. Vite proxies `/app-api` to it. Open http://127.0.0.1:5173.

```bash
npm run build     # type-check + client build + serverless API bundle
npm run preview
```

## why there is a server

The browser can't call these APIs directly. Celestrak sends
`access-control-allow-origin: *`, but JPL sends no CORS header at all — so the
close-approach, SBDB and Sentry-risk data, which is most of the app, has to come through
a proxy. `src/server.ts` is the platform-neutral request handler, `src/dev-server.ts`
wraps it for local Node development, and `api/app-api/[...path].js` adapts it for
Vercel. Close approaches are cached for 12 hours, satellite catalogues for a week,
and space weather for three hours so the public endpoints aren't hammered. Failed
satellite requests also enter a 12-hour retry cooldown.

It only ever talks to fixed public-science origins and a fixed allowlist of NASA model
files, all written as literals in the source. No viewer-supplied URL ever reaches
`fetch`.

## data sources

| | |
|---|---|
| Close approaches, SBDB, Sentry risk | [JPL Solar System Dynamics](https://ssd-api.jpl.nasa.gov) |
| Active satellite catalogue | [Celestrak](https://celestrak.org) |
| Space weather (CMEs, flares, Kp) | [NASA DONKI](https://api.nasa.gov) |
| Spacecraft imagery and 3D models | [NASA Image Library](https://images.nasa.gov) · [NASA 3D Resources](https://science.nasa.gov/3d-resources/) |
| Spacecraft vectors and geometry | [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) · [NAIF/SPICE](https://naif.jpl.nasa.gov/naif/) |

DONKI needs an API key. It falls back to NASA's public `DEMO_KEY`, which is rate-limited
to 30 requests an hour — fine here, because the three-hour cache means only a handful of
calls a day. For a personal key (free, instant from https://api.nasa.gov):

```bash
NASA_API_KEY=your_key npm run dev
```

## sound

The console has an ambient drone and a set of UI blips, served from `public/audio/`. They play
through pooled `HTMLAudioElement`s rather than the Web Audio API, so playback works
without cross-origin decode permissions.

The WebGL scene honours `prefers-reduced-motion` and drops its sweeps and pulses when
it is set.

## built with

three.js · React 19 · Vite · TypeScript · Tailwind (compiled at build time)
