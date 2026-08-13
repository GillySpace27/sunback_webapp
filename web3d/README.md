# My Heliograph — web3d

Cinematic 3D counterpart to the My Heliograph shop. Concept: **"Eight Minutes"** —
light leaves the Sun on your chosen date, crosses the dark, is caught through a
wavelength filter, and becomes an object you can hold.

Standalone Vite + React + React Three Fiber app. It does **not** touch the live
Worker site; deploy it separately (subdomain or path) when ready.

## Run

```bash
cd web3d && npm install && npm run dev
```

Build: `npm run build` → `dist/` (static, host anywhere: Cloudflare Pages, Fly static, etc.).

## Architecture

- **One Canvas, one scene** (`src/three/Scene.tsx`). Sections are state, never remounted.
- **One `progress` value** (`src/store.ts`), fed by Lenis smooth-scroll (`hooks/useScrollProgress.ts`).
  The camera *scrubs* this; UI copy cross-fades off it.
- **Camera** rides a Catmull-Rom spline through the seven spaces with damped,
  per-space cursor parallax (`three/CameraRig.tsx`).
- **Sun** is the only heavy shader: procedural fbm plasma that recolors per
  wavelength by lerping two color uniforms (`three/Sun.tsx`).
- **Heliograph** is the "sun-pizza" filter wheel: 10 clickable SDO-channel
  wedges that select the wavelength (`three/Heliograph.tsx`).
- **Accessibility**: the 3D wedges are mirrored by a native radio-group picker
  (`ui/WavelengthPicker.tsx`, arrow-key + screen-reader friendly), sharing state
  through the store. Crawlable `<h1>`/copy live in the DOM; the story survives
  with WebGL removed.
- **Performance**: DPR clamped to 2; drei `PerformanceMonitor` drops quality
  (plasma octaves, bloom, DoF) on sustained frame loss; DoF mounts only in the
  aperture/darkroom window. Respects `prefers-reduced-motion`.
- **Resilience**: `ui/ErrorBoundary.tsx` routes WebGL failures to the 2D shop.
- **SEO**: metadata + Product JSON-LD in `index.html`.

## Identity, real Sun, and handoff

This site owns only the **image identity** (date + wavelength). The buyer picks
their date (`ui/WavelengthPicker.tsx` date field) and wavelength (filter wheel /
picker), and the real SDO/AIA full-disk JPG for that identity is textured onto
the Sun and the framed print (`lib/handoff.ts` `thumbUrl` →
`/api/helioviewer_thumb`, mapped orthographically in `three/Sun.tsx`, shown flat
in `three/Room.tsx`). A procedural plasma is the loading/fallback state.

"Make one" (`ui/BuyLink.tsx`) deep-links to the original front end with the
identity preloaded and warms the backend on buy-intent:

    https://myheliograph.com/?d=YYYY-MM-DD&t=HH:MM&wl=<angstrom>

The original's existing hydration (`d`/`t`/`wl`) runs the same path a real date
submit uses and auto-advances into **product + editor + checkout** — no changes
needed on the original. See `PRODUCT_CREATION_CONTRACT.md`.

### Origin note (required for the texture)

`/api/helioviewer_thumb` is origin-enforced. In **prod** the 3D site must be
served same-origin as the API (or the 3D origin allow-listed server-side) or
uncached thumbs 403. In **dev** `vite.config.ts` proxies `/api` and spoofs an
allow-listed Origin/Referer. Configure `VITE_API_BASE` / `VITE_ORIGINAL_SITE`
(and `VITE_DEV_API` for the dev proxy target) if the origins differ.

## Deliberately stubbed (add when real assets land)

- GLTF instrument model + KTX2/meshopt pipeline. Current instrument is procedural
  geometry, so the app runs with zero downloaded assets.
- The full modeled art of the darkroom transition (the room/gift interiors and
  the framed print are real; the darkroom is still a plasma close-up + copy).
- The audio layer (solar p-mode drone).
- GSAP ScrollTrigger per-element scrubbed timelines (Lenis drives progress today).
- Passing the chosen product id (`&p=`) — the picker collects date + wavelength;
  product selection currently happens on the original after handoff.
