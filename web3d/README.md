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

## Deliberately stubbed (add when real assets land)

- GLTF instrument model + KTX2/meshopt pipeline. Current instrument is procedural
  geometry, so the app runs with zero downloaded assets.
- The full art of spaces 5–7 (darkroom, room, gift): the camera path and copy
  beats exist; the interiors are lighting/copy, not modeled sets yet.
- Print render-to-texture onto paper, and the audio layer (solar p-mode drone).
- GSAP ScrollTrigger per-element scrubbed timelines (Lenis drives progress today).
