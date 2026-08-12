import { useEffect, useState } from "react";
import * as THREE from "three";
import { thumbUrl } from "../lib/handoff";

// Load the real SDO/AIA full-disk JPG for a date + wavelength and cache it.
// Returns the last successfully loaded texture (null until the first arrives),
// so the procedural plasma stays as the graceful fallback / loading state.
const cache = new Map<string, THREE.Texture>();
const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");

export function useSunTexture(date: string, time: string, angstrom: number, size = 1024) {
  const url = thumbUrl(date, time, angstrom, size);
  const [tex, setTex] = useState<THREE.Texture | null>(() => cache.get(url) ?? null);

  useEffect(() => {
    const cached = cache.get(url);
    if (cached) {
      setTex(cached);
      return;
    }
    let alive = true;
    loader.load(
      url,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        cache.set(url, t);
        if (alive) setTex(t); // swap in; keep the old sun visible until it lands
      },
      undefined,
      () => {
        /* keep the previous texture / procedural fallback on error */
      }
    );
    return () => {
      alive = false;
    };
  }, [url]);

  return tex;
}
