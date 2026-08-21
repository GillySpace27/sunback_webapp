import { useEffect } from "react";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { thumbUrl } from "../lib/handoff";

// A real time-lapse of the visitor's day.
//
// This exists because "can we spin the Sun?" has an honest answer of no: the
// texture is one snapshot of the Earth-facing hemisphere, so rotating it either
// spins the image like a wheel or invents longitudes nobody observed. And the
// real rotation is ~13.2 deg/day, which over a minute of scrolling is 0.009 deg
// — invisible. Any spin fast enough to see is, by construction, not rotation.
//
// What IS real is EVOLUTION. Frames hours apart across the same day show loops
// brightening, filaments shifting, active regions churning, and on an active day
// a flare actually erupting — all of it something the Sun did. That is far more
// visible than rotation, and every frame of it is a real observation.
//
// Cheap on purpose: these are Helioviewer thumbs (~1s, edge-cached), not the
// FITS/RHEF path, where each frame would be an archive fetch plus a filter pass.
//
// The fidelity gap this opens is deliberate and closed elsewhere: motion cannot
// be printed, so the sequence is a CHOOSER — the visitor scrubs the day and buys
// the instant they stop on. Nothing is shown that cannot be bought.
const HOURS = [0, 4, 8, 12, 16, 20];

const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");

function load(url: string): Promise<THREE.Texture | null> {
  return new Promise((res) => {
    loader.load(
      url,
      (t) => { t.colorSpace = THREE.SRGBColorSpace; res(t); },
      undefined,
      () => res(null)
    );
  });
}

export function useTimelapseLoader() {
  const date = useStore((s) => s.date);
  const channel = useStore((s) => s.channel);
  const frontierReady = useStore((s) => s.frontierReady);
  const enabled = useStore((s) => s.timelapse);

  useEffect(() => {
    if (!enabled || !date || !frontierReady) return;
    let alive = true;
    const wl = CHANNELS[channel].angstrom;
    useStore.getState().setSequence([]);

    (async () => {
      const frames: THREE.Texture[] = [];
      for (const h of HOURS) {
        if (!alive) break;
        const t = await load(thumbUrl(date, `${String(h).padStart(2, "0")}:00`, wl));
        // A missing hour is normal, not an error: the archive has gaps, and a
        // date inside JSOC's ingest lag may only have part of a day. Keep what
        // exists — five frames still evolve, and one is simply a still.
        if (t && alive) {
          frames.push(t);
          useStore.getState().setSequence([...frames]);
        }
      }
    })();

    return () => {
      alive = false;
      // the store owns disposal of the previous sequence
    };
  }, [date, channel, frontierReady, enabled]);
}
