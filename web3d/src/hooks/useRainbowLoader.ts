import { useEffect } from "react";
import * as THREE from "three";
import { useStore } from "../store";
import { RAINBOW_RGB } from "../data/wavelengths";
import { API_BASE } from "../lib/handoff";

// The rainbow Sun: 171/193/211 RHEF frames mapped to R/G/B.
//
// Recipe is sunback's own RainbowRGBImageProcessor (rgb1), so this is the same
// composite already published as rhef_rainbow_1k.png rather than a new look
// invented here.
//
// Uses the GREYSCALE RHEF product (preview_gray_url), not the colour-mapped
// one. The first version of this composited the colour-mapped pngs by taking
// each one's luminance, which is wrong: sdoaiaNNN is a nonlinear, hue-dependent
// ramp, so luminance does not recover the equalised value that went into it and
// the composite came out pastel. RHEF's actual output belongs in the colour
// channel; anything else is compositing three colourmaps together.
//
// Still three RHEF generations for a cold date, each a FITS fetch plus a filter
// pass, which is why the rainbow is a deliberate choice rather than a default.
const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");

function preview(date: string, time: string, wl: number): Promise<string | null> {
  return fetch(`${API_BASE}/api/generate_preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, time: time || "12:00", wavelength: wl }),
  })
    .then((r) => (r.ok ? r.json() : null))
    // gray is what we want; preview_url only tells us the job finished
    .then((j) => (j?.preview_url ? (j.preview_gray_url ?? null) : null))
    .catch(() => null);
}

function loadTex(url: string): Promise<THREE.Texture | null> {
  return new Promise((res) =>
    loader.load(url, (t) => { t.colorSpace = THREE.SRGBColorSpace; res(t); }, undefined, () => res(null))
  );
}

export function useRainbowLoader() {
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const rainbow = useStore((s) => s.rainbow);
  const frontierReady = useStore((s) => s.frontierReady);

  useEffect(() => {
    if (!rainbow || !date || !frontierReady) return;
    let alive = true;
    useStore.getState().setRainbowStatus("loading");

    (async () => {
      // All three in parallel: they are independent backend jobs, and serially
      // this would be three cold FITS fetches back to back.
      const urls = await Promise.all(
        RAINBOW_RGB.map(async (wl) => {
          for (let i = 0; i < 24 && alive; i++) {
            const u = await preview(date, time, wl);
            if (u) return u.startsWith("http") ? u : `${API_BASE}${u}`;
            // preview_url present but no gray means an older cached render from
            // before greyscale existed; nothing to do but keep waiting for a
            // fresh one rather than silently compositing colourmaps again
            await new Promise((r) => setTimeout(r, i < 6 ? 2500 : 5000));
          }
          return null;
        })
      );
      if (!alive) return;
      if (urls.some((u) => !u)) {
        useStore.getState().setRainbowStatus("error");
        return;
      }
      const texes = await Promise.all(urls.map((u) => loadTex(u as string)));
      if (!alive) return;
      if (texes.some((t) => !t)) {
        useStore.getState().setRainbowStatus("error");
        return;
      }
      useStore.getState().setRainbow3(texes as THREE.Texture[]);
      useStore.getState().setRainbowStatus("ready");
    })();

    return () => { alive = false; };
  }, [date, time, rainbow, frontierReady]);
}
