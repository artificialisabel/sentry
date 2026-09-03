# SENTRY

A retro-futurist tracking console for asteroids passing close to Earth.

It pulls the live close-approach catalogue from NASA/JPL, joins it against JPL's Sentry
impact-risk table, fetches real orbital elements for the objects worth plotting, and
draws the whole thing as an interactive WebGL scope — with a scrubbable mission clock,
an encounter radar, a live data feed, a space-weather panel and a per-object readout.

Every catalogue value on screen comes from a public science API or from standard
astronomical formulae evaluated locally. The stars, solar particles and other scene
effects are deliberately stylised procedural graphics; they are not measurements.

## the console

- **Main map** — a three.js scene in one of two modes. `GEOCENTRIC` puts Earth at the
  centre with the Moon, lunar-distance rings, each asteroid's modelled position, and the
  live active-satellite field once you fly in close. `HELIOCENTRIC` steps out to the
  inner solar system with the planets and each object's real orbit path.
- **Mini map** — the mode you are *not* in, as a thumbnail. Click to swap.
- **Encounter radar** — a polar dial of the same window: angle is the approach date,
  radius is miss distance, with rings at 1, 5, 10, 15 and 20 lunar distances.
- **Data feed** — the object list plus a running log of what the app is doing: uplink
  status, cache hits, catalogue counts.
- **Space weather** — recent coronal mass ejections, solar flares and Kp index, from
  NASA's DONKI feed.

Selecting an object opens a detail panel: closest approach, miss distance, relative
velocity, whether it is on Sentry watch, and its orbit class and period once SBDB
resolves. The `MISSION TIME` scrubber runs the whole encounter window.

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

It only ever talks to three fixed origins, written as literals in the source. No
viewer-supplied URL ever reaches `fetch`.

## data sources

| | |
|---|---|
| Close approaches, SBDB, Sentry risk | [JPL Solar System Dynamics](https://ssd-api.jpl.nasa.gov) |
| Active satellite catalogue | [Celestrak](https://celestrak.org) |
| Space weather (CMEs, flares, Kp) | [NASA DONKI](https://api.nasa.gov) |

DONKI needs an API key. It falls back to NASA's public `DEMO_KEY`, which is rate-limited
to 30 requests an hour — fine here, because the six-hour cache means only a handful of
calls a day. For a personal key (free, instant from https://api.nasa.gov):

```bash
NASA_API_KEY=your_key npm run dev
```

## sound

The console has an ambient drone and a set of UI blips, in `src/audio/`. They play
through pooled `HTMLAudioElement`s rather than the Web Audio API, so playback works
without cross-origin decode permissions.

The space-weather panel and the WebGL scene both honour
`prefers-reduced-motion` and drop their sweeps and pulses when it's set.

## built with

three.js · React 19 · Vite · TypeScript · Tailwind (compiled at build time)
