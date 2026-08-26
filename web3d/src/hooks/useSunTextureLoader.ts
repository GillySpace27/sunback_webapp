import { useEffect } from "react";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { thumbUrl } from "../lib/handoff";
import { WHEEL_SIZE } from "./useWheelTextures";
import { relativeSpin } from "../lib/rotation";

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

// How far the Sun may turn away from the frame we are holding before we
// fetch a fresh one MID-SCRUB.
//
// This is the whole answer to "make it look like an actual spinning sun
// without making it slow" (Gilly, 2026-08-25). A frame per day is one request
// per day travelled — 30 days of scrub, 30 requests, and that flood is what
// froze the sphere earlier. But re-projecting a single frame (Sun.tsx's
// uSpinRel) only holds up for modest angles: past roughly 60 degrees the
// incoming half of the disk is material that was a foreshortened sliver at
// the limb when the picture was taken, and it dissolves.
//
// So the requests are budgeted by ANGLE TURNED rather than by date step, and
// the re-projection covers the gaps between them exactly.
//
// 30 degrees (~2.3 days). The threshold is not the whole story: the date keeps
// moving while the anchor is in flight, so the frame actually on screen lags
// by the threshold PLUS whatever the scrub covered during the fetch. Measured
// at 60 degrees on a brisk scrub the lag settled at 8-10 days, which is past
// the angle where re-projection holds up. 30 brings it back into the range
// where the disk stays photographic, and the in-flight limiter below — not
// the threshold — is what actually bounds the request rate.
const ANCHOR_RAD = (30 * Math.PI) / 180;
// At most one anchor in flight. This is the rate limit, and it is a better
// one than any timer: a slow, deliberate scrub gets an anchor whenever it has
// earned one, while a fast flick — which cannot be looked at anyway, and
// where the network is the binding constraint — simply gets fewer and leans
// on the re-projection. Nothing has to guess at a gesture speed.
let anchoring = false;

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
  const dragging = useStore((s) => s.dateDragging);
  const setTexture = useStore((s) => s.setTexture);
  const setTexStatus = useStore((s) => s.setTexStatus);
  const url = thumbUrl(date, time, CHANNELS[channel].angstrom);

  useEffect(() => {
    // Wait for the real archive bounds before asking for a texture: firing
    // against the still-conservative guess (or an empty, just-cleared date)
    // is how a pre-frontier 404 burst happens. The wheel set is gated on the
    // same flag, so during this wait the Sun is the procedural plasma.
    if (!(frontierReady && date)) return;
    // Mid-gesture: show nothing photographic and fetch nothing.
    //
    // A drag walks through a day per ~9px, so every intermediate date is a
    // frame nobody asked to look at. Fetching them made the Sun flicker
    // between the plasma and whichever stray day's image won the race, and
    // the debounce could not help because the queue was upstream of it (see
    // useWheelTextures). The plasma is the honest thing to show here: it is
    // the only rendering that is not claiming to be a particular day's
    // observation, and it now turns with the date.
    if (dragging) {
      // The frame we are holding is KEPT, not dropped. Sun.tsx re-projects it
      // for the date under the hand (see uSpinRel there): the same photograph,
      // rotated to where its surface would be, fading out as the claim gets
      // weaker. Dropping to bare plasma the moment a drag started threw away
      // the only real information available and replaced it with something
      // invented, which is the wrong trade — and it made the gesture feel like
      // it had broken the picture.
      //
      // This is the one place the "never show a texture from another identity"
      // rule is relaxed, and only because the shader is no longer claiming the
      // frame belongs to this date: it is showing what that observation
      // implies about this one, and dissolving where it implies nothing.
      setTexStatus("loading");
      // Re-anchor once the Sun has turned far enough that re-projecting the
      // frame we hold stops being convincing. One image, at wheel resolution
      // because it is a transient the eye is sweeping past, not the frame
      // anyone will study.
      const st0 = useStore.getState();
      if (!anchoring && st0.currentTexture && Math.abs(relativeSpin(st0.currentTexture, date)) > ANCHOR_RAD) {
        const anchorUrl = thumbUrl(date, time, CHANNELS[channel].angstrom, WHEEL_SIZE);
        const hit = cache.get(anchorUrl);
        if (hit) {
          setTexture(hit);
        } else {
          anchoring = true;
          loader.load(
            anchorUrl,
            (tex) => {
              anchoring = false;
              tex.colorSpace = THREE.SRGBColorSpace;
              put(anchorUrl, tex);
              // Only if the hand is STILL down. Once the drag ends the settled
              // path owns the sphere, and a late anchor landing on top of the
              // real full-resolution frame would quietly downgrade it.
              if (useStore.getState().dateDragging) setTexture(tex);
            },
            undefined,
            () => { anchoring = false; }
          );
        }
      }
      return;
    }
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
  }, [url, setTexture, setTexStatus, frontierReady, date, dragging, time, channel]);

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
    if (dragging) return;
    const stand = wheel[channel];
    if (!stand) return;
    // The wheel set is republished as nulls when its own effect re-runs for a
    // new date, but that is a different component's effect and the flush
    // order between the two is not guaranteed — so for one commit after a
    // drag ends `wheel` can still hold the PREVIOUS date's frames. Checking
    // the texture's own URL is exact and makes the ordering irrelevant.
    // Resolved against the document, because thumbUrl returns a same-origin
    // PATH while an <img>'s .src always reads back absolute. Comparing the two
    // raw never matched, which silently disabled this whole stand-in.
    const want = new URL(thumbUrl(date, time, CHANNELS[channel].angstrom, WHEEL_SIZE), location.href).href;
    if (stand.image?.src !== want) return;
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
  }, [wheel, channel, dragging, date, time]);
}
