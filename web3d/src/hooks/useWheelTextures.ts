import { useEffect, useState } from "react";
import * as THREE from "three";
import { CHANNELS } from "../data/wavelengths";
import { thumbUrl } from "../lib/handoff";
import { useStore } from "../store";

// Loads the real SDO/AIA disk in ALL nine wavelengths for the chosen date, so
// the filter wheel can show each as a pie slice of the same Sun (like the
// classic SDO multi-wavelength fan). Smaller size than the hero (slices).
//
// Lazy: the nine fetches used to fire at Scene mount, ahead of the hero's own
// texture on a cold load, for a wheel that isn't visible until progress ~0.2.
// Now they wait until the visitor is actually approaching the aperture beat
// (progress >= 0.08, one-shot). Deep links that land mid-film start above the
// threshold, so they load immediately as before.
//
// The cache is scoped to ONE date at a time rather than growing forever: it
// used to keep nine textures per date visited, undisposed, for the life of
// the page. clearForDate() disposes the previous date's set the moment a new
// one is requested: the smallest fix that actually bounds VRAM.
const cache = new Map<string, THREE.Texture>();
let cachedDate: string | null = null;
function clearForDate(date: string) {
  if (cachedDate === date) return;
  for (const t of cache.values()) t.dispose();
  cache.clear();
  cachedDate = date;
}
const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");
const WHEEL_SIZE = 512;
const WHEEL_LOAD_AT = 0.08; // well before the wheel fades in at ~0.205

export function useWheelTextures(date: string, time: string) {
  const [armed, setArmed] = useState(() => useStore.getState().progress >= WHEEL_LOAD_AT);
  // Same frontier gate as the hero loader (useSunTextureLoader): no request
  // before the real archive bounds are known, or with an empty just-cleared
  // date, so the wheel can't fire its nine fetches into a pre-frontier 404
  // burst either.
  const frontierReady = useStore((s) => s.frontierReady);
  const ready = armed && frontierReady && !!date;
  const [texes, setTexes] = useState<(THREE.Texture | null)[]>(() =>
    CHANNELS.map((ch) => cache.get(thumbUrl(date, time, ch.angstrom, WHEEL_SIZE)) ?? null)
  );

  useEffect(() => {
    if (armed) return;
    const unsub = useStore.subscribe((s) => {
      if (s.progress >= WHEEL_LOAD_AT) {
        setArmed(true);
        unsub();
      }
    });
    return unsub;
  }, [armed]);

  useEffect(() => {
    if (!ready) return;
    clearForDate(date);
    let alive = true;
    setTexes(CHANNELS.map((ch) => cache.get(thumbUrl(date, time, ch.angstrom, WHEEL_SIZE)) ?? null));
    CHANNELS.forEach((ch, i) => {
      const url = thumbUrl(date, time, ch.angstrom, WHEEL_SIZE);
      if (cache.get(url)) return;
      loader.load(
        url,
        (t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          cache.set(url, t);
          if (alive)
            setTexes((prev) => {
              const n = [...prev];
              n[i] = t;
              return n;
            });
        },
        undefined,
        () => {}
      );
    });
    return () => {
      alive = false;
    };
  }, [date, time, ready]);

  return texes;
}
