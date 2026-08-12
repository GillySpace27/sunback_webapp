import { useEffect, useState } from "react";
import * as THREE from "three";
import { CHANNELS } from "../data/wavelengths";
import { thumbUrl } from "../lib/handoff";

// Loads the real SDO/AIA disk in ALL nine wavelengths for the chosen date, so
// the filter wheel can show each as a pie slice of the same Sun (like the
// classic SDO multi-wavelength fan). Smaller size than the hero (slices).
const cache = new Map<string, THREE.Texture>();
const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");
const WHEEL_SIZE = 512;

export function useWheelTextures(date: string, time: string) {
  const [texes, setTexes] = useState<(THREE.Texture | null)[]>(() =>
    CHANNELS.map((ch) => cache.get(thumbUrl(date, time, ch.angstrom, WHEEL_SIZE)) ?? null)
  );

  useEffect(() => {
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
  }, [date, time]);

  return texes;
}
