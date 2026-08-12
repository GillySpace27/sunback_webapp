import { useEffect } from "react";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { thumbUrl } from "../lib/handoff";

// Single owner of the real-Sun texture. Watches the identity (date/time/
// wavelength), debounces bursts, loads the SDO/AIA JPG, and publishes
// {currentTexture, texStatus} to the store so the Sun, the print, and the UI
// all read one source of truth. Key behaviours the review demanded:
//  - never show a stale texture for a different identity (null on change),
//  - surface loading + error (no silent failure of the whole value prop),
//  - bounded LRU with dispose() so exploring dates doesn't leak VRAM.
const CAP = 16;
const cache = new Map<string, THREE.Texture>(); // insertion-ordered LRU
const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");

function put(url: string, tex: THREE.Texture) {
  cache.set(url, tex);
  while (cache.size > CAP) {
    const oldest = cache.keys().next().value as string;
    if (oldest === url) break; // never evict what we just added
    cache.get(oldest)?.dispose();
    cache.delete(oldest);
  }
}

export function useSunTextureLoader() {
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const channel = useStore((s) => s.channel);
  const setTexture = useStore((s) => s.setTexture);
  const setTexStatus = useStore((s) => s.setTexStatus);
  const url = thumbUrl(date, time, CHANNELS[channel].angstrom);

  useEffect(() => {
    const cached = cache.get(url);
    if (cached) {
      setTexture(cached);
      setTexStatus("ready");
      return;
    }
    // new identity: fall back to procedural immediately (never the wrong Sun)
    setTexture(null);
    setTexStatus("loading");
    let alive = true;
    const t = setTimeout(() => {
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          put(url, tex);
          if (alive) {
            setTexture(tex);
            setTexStatus("ready");
          }
        },
        undefined,
        () => {
          if (alive) setTexStatus("error"); // texture stays null -> procedural
        }
      );
    }, 220); // debounce arrow-keying / date scrubbing into one request
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [url, setTexture, setTexStatus]);
}
