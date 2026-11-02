# ResQ AI — frontend

Next.js 15 (App Router, React 19, TypeScript strict, Tailwind 4) web app and PWA for ResQ AI.

**The full documentation lives in the [root README](../README.md)**: architecture, configuration
(every environment variable), the API reference, auth / OAuth, PWA and push setup, Docker and
troubleshooting.

## Quick reference

```bash
cp .env.example .env.local   # then fill in the shared secrets (see the root README)
npm ci
npm run dev                  # http://localhost:3000 (needs the backend on BACKEND_URL)
```

| Script              | What it does                                   |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Development server                             |
| `npm run build`     | Production build (`output: "standalone"`)      |
| `npm start`         | Serve the production build                     |
| `npm run lint`      | ESLint (`eslint .`)                            |
| `npm run typecheck` | TypeScript (`tsc --noEmit`)                    |
| `npm test`          | Vitest unit/component tests (`vitest run`)     |

`next build` needs `NEXTAUTH_SECRET`, `BACKEND_JWT_SECRET` and `NEXTAUTH_URL` in the environment
(dummy values are fine for a build).

## How the browser talks to the backend

The browser never calls FastAPI directly. Every data request goes to the same-origin proxy
`/api/backend/<path>` (`app/api/backend/[...path]/route.ts`), which forwards it to
`${BACKEND_URL}/api/<path>` at runtime and, when the user is signed in, attaches a short-lived
backend JWT. Use the typed helpers in `lib/api.ts` (and `swrKeys` + the global SWR fetcher)
instead of calling `fetch` yourself.

## Where things are

- `app/` — routes (each feature segment has its own `loading.tsx` and `error.tsx`)
- `components/` — shared widgets (`WeatherCard`, `AlertBanner`, `PushToggle`, `SOSFab` ...) and
  `components/ui/` primitives
- `lib/` — API client, types mirroring the backend schemas, auth, geolocation, push, formatting
- `public/sw.js` — hand-written service worker (offline pages, API/tile caching, push)
- `public/icons/` — PWA icons generated from `public/icons/icon.svg`
