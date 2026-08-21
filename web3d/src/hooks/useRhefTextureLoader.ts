import { useEffect } from "react";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { API_BASE } from "../lib/handoff";

// The RHEF frame, on its own slower path.
//
// RHEF cannot run on the Helioviewer JP2: that file is already byte-scaled to
// 8 bits, display-stretched and colour-mapped, so the off-disk intensities RHEF
// equalises have been destroyed before it reaches us. It has to come from FITS,
// which means the backend's generate_preview pipeline — a real archive fetch
// plus a filter pass, ~20-25s cold and instant once cached. So this never
// blocks the film: the JP2 paints immediately and this crossfades in behind it.
//
// Only ever fetched for the COMMITTED identity. Speculating across nine
// wavelengths would fire nine FITS downloads per date change.
const CAP = 8;
const cache = new Map<string, THREE.Texture>();
const loader = new THREE.TextureLoader();
loader.setCrossOrigin("anonymous");

// The FITS frame's disk is a different fraction of its field than the JP2's:
// AIA's 2457.6" field against a ~960" solar radius puts the limb at 0.39 of
// the image, where the 3072" Helioviewer thumb puts it at 0.31. Measured 0.398
// on a real preview. Sampling one with the other's radius detaches the disk
// from the sphere's silhouette — it reads as a shader bug, but it is a units
// bug, so the number lives next to the thing that needs it.
export const RHEF_DISC_R = 0.39;

function put(url: string, tex: THREE.Texture) {
  cache.set(url, tex);
  while (cache.size > CAP) {
    const oldest = cache.keys().next().value as string;
    if (oldest === url) break;
    cache.get(oldest)?.dispose();
    cache.delete(oldest);
  }
}

export function useRhefTextureLoader() {
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const channel = useStore((s) => s.channel);
  const look = useStore((s) => s.look);
  const frontierReady = useStore((s) => s.frontierReady);

  useEffect(() => {
    // Nothing to do until someone actually asks for the enhanced look.
    if (look !== "rhef" || !date || !frontierReady) return;
    const wl = CHANNELS[channel].angstrom;
    const key = `${date}T${time}_${wl}`;
    let alive = true;

    const cached = cache.get(key);
    if (cached) {
      useStore.getState().setRhefTexture(cached);
      useStore.getState().setRhefStatus("ready");
      return;
    }

    useStore.getState().setRhefTexture(null);
    useStore.getState().setRhefStatus("loading");

    const ask = async () => {
      // generate_preview returns 202-ish with a null url while it works, so
      // poll rather than assuming one call is enough.
      for (let attempt = 0; attempt < 24 && alive; attempt++) {
        let url: string | null = null;
        try {
          const r = await fetch(`${API_BASE}/api/generate_preview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ date, time: time || "12:00", wavelength: wl }),
          });
          if (r.ok) url = (await r.json())?.preview_url ?? null;
        } catch {
          /* transient; the retry below covers it */
        }
        if (!alive) return;
        if (url) {
          const abs = url.startsWith("http") ? url : `${API_BASE}${url}`;
          loader.load(
            abs,
            (tex) => {
              if (!alive) { tex.dispose(); return; }
              tex.colorSpace = THREE.SRGBColorSpace;
              put(key, tex);
              const st = useStore.getState();
              st.setRhefTexture(tex);
              st.setRhefStatus("ready");
            },
            undefined,
            () => alive && useStore.getState().setRhefStatus("error")
          );
          return;
        }
        await new Promise((res) => setTimeout(res, attempt < 6 ? 2500 : 5000));
      }
      if (alive) useStore.getState().setRhefStatus("error");
    };
    void ask();
    return () => { alive = false; };
  }, [date, time, channel, look, frontierReady]);
}
