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

// The baked 304 A stand-in is GONE (Gilly, 2026-08-25: "instead of starting
// the page with the red sun and then loading the yellow one when it's ready").
//
// It was a real, correctly-framed disk — but of the wrong wavelength and the
// wrong date, so the film's first statement was a Sun belonging to nobody,
// replaced seconds later by the visitor's actual one. Worse, 304 A is
// chromospheric and nearly bare off-limb, so the opening frame was the one
// channel where the enhancement this product sells has nothing to show.
//
// What replaces it is not another stand-in: useWheelTextures now fetches all
// eight channels of the RIGHT instant up front, and the hook below adopts the
// current channel's frame the moment it lands. Until then the Sun is the
// procedural plasma, which is at least tinted to the channel actually
// selected, so the opening colour is already correct even before the
// photograph is.

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
  const frontierReady = useStore((s) => s.frontierReady);
  const setTexture = useStore((s) => s.setTexture);
  const setTexStatus = useStore((s) => s.setTexStatus);
  const url = thumbUrl(date, time, CHANNELS[channel].angstrom);

  useEffect(() => {
    // Wait for the real archive bounds before asking for a texture: firing
    // against the still-conservative guess (or an empty, just-cleared date)
    // is how a pre-frontier 404 burst happens. The wheel set is gated on the
    // same flag, so during this wait the Sun is the procedural plasma.
    if (!(frontierReady && date)) return;
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
  }, [url, setTexture, setTexStatus, frontierReady, date]);

  // Stand in with the wheel's 512px frame of the SAME identity while the
  // 1024px hero frame is still in flight.
  //
  // This is not the old baked-default compromise: it is the visitor's date,
  // their time and their wavelength, just at half the resolution, so nothing
  // on screen is ever a Sun that belongs to someone else. Declared AFTER the
  // effect above so that on a channel change the ordering is null-then-fill
  // rather than fill-then-null.
  const wheel = useStore((s) => s.wheelTextures);
  useEffect(() => {
    const stand = wheel[channel];
    if (!stand) return;
    const s = useStore.getState();
    if (s.currentTexture !== null) return;
    s.setTexture(stand);
    // "ready", not "loading". What is on screen IS this visitor's Sun for
    // this date, time and wavelength — the only thing still in flight is the
    // same frame at double the resolution, which arrives invisibly. Leaving
    // the status at "loading" made the HUD read "developing your Sun…"
    // continuously while the aperture beat cycled channels, over a Sun that
    // was fully rendered the whole time.
    s.setTexStatus("ready");
  }, [wheel, channel]);
}
