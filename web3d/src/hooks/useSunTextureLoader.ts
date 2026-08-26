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

// The opening frame: a real 171 A disk, baked into the build.
//
// This replaces the old baked 304 A stand-in, which was dropped because it
// was the WRONG CHANNEL — the film opens on 171, so the page turned red and
// then yellow (Gilly, 2026-08-25). Dropping it entirely was one step too far:
// the landing frame then had nothing photographic at all for the first
// several seconds, and audit-in-Chrome found the film opening on a black void
// and then a soft procedural blob. A generative ball is a WEAKER claim than a
// real photograph of a different day, not a stronger one: the plasma is not
// the Sun on any date, whereas this is a genuine AIA frame (2014-10-24, the
// AR 2192 disk the backend already uses as its canonical default).
//
// So it paints instantly, at the right colour, and the visitor's own frame
// dissolves over it seconds later via the anchor cross-fade. It is 24 KB of
// WebP against the old 638 KB PNG, so it costs the landing almost nothing.
//
// It NEVER overwrites a real frame: the adopt below refuses once anything
// for the true identity has arrived, and it is skipped entirely for a
// deep-link that lands mid-film with a date already chosen.
const OPENING_SUN = `${import.meta.env.BASE_URL}sun_171.webp`;

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

  // Instant first paint. Runs once, before anything else can have arrived, and
  // refuses to touch the sphere if a real frame beat it there.
  useEffect(() => {
    let alive = true;
    loader.load(OPENING_SUN, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      const st = useStore.getState();
      if (!alive || st.currentTexture !== null || st.texStatus === "ready") return;
      st.setTexture(tex);
      // status stays "loading": this is not their Sun yet, and the HUD's
      // "developing your Sun…" must keep running until the real one lands.
    });
    return () => { alive = false; };
  }, []);

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
        // 256, not 512. An anchor is a transient the eye sweeps past at
        // drag speed, and its job is to land BEFORE the lag grows — a
        // quarter of the bytes means it does. The frame anyone actually
        // studies is the full-res one that follows the release.
        const anchorUrl = thumbUrl(date, time, CHANNELS[channel].angstrom, 256);
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
    // New identity. The old rule was "fall back to procedural immediately,
    // never the wrong Sun" — but the shader can now re-project a nearby-date
    // frame honestly (Sun.tsx uSpinRel), so nulling here threw away a frame
    // the renderer could keep showing truthfully and put a plasma dip between
    // every drag release and the full-res arrival. Keep the held frame when
    // it is the SAME wavelength and within re-projection range; the anchor
    // cross-fade then dissolves it into the real frame when that lands.
    // A different wavelength (or a frame too far away) still nulls: those the
    // shader cannot honestly bridge.
    {
      const held = useStore.getState().currentTexture;
      const src = (held as { image?: { src?: string } } | null)?.image?.src ?? "";
      const reusable =
        held &&
        src.includes(`wavelength=${CHANNELS[channel].angstrom}&`) &&
        Math.abs(relativeSpin(held, date)) < 1.2;
      if (!reusable) setTexture(null);
    }
    setTexStatus("loading");
    let alive = true;
    const t = setTimeout(() => {
      // Progressive: a small stand-in and the 1024 go out TOGETHER, and
      // whichever is on screen when the big one lands gets dissolved into it
      // by the anchor cross-fade. On a cold landing or a slow link the sphere
      // is photographic seconds before the full frame arrives — this is what
      // "mostly seeing a generic ball" was: one big request, nothing to show
      // until all of it came (Gilly, 2026-08-25). The small frame only ever
      // paints while the sphere has nothing real (currentTexture null and the
      // big one not landed), so it can never downgrade anything.
      let bigLanded = false;
      // 256: first paint is a race, and a 256 is ~4x fewer bytes than a 512
      // for a sphere the visitor sees for the couple of seconds before the
      // full frame dissolves over it. Measured on a 1.2 Mbps throttle: the
      // 512 stand-in landed at +6.7s; the page's own JS chunks were eating
      // the link, so the stand-in has to be nearly free to arrive early.
      // Shares the anchor cache below, so a scrub that follows costs nothing.
      const smallUrl = thumbUrl(date, time, CHANNELS[channel].angstrom, 256);
      // NO fetchPriority warm-up here, though it looks like the obvious next
      // lever. It was tried (2026-08-25) and TRIPLED time-to-first-photo on a
      // throttled link, measured at +4.8s -> +15s: /api/helioviewer_thumb
      // sends no Cache-Control and no ETag, so the warm-up Image's bytes are
      // not reusable by the loader's own request — every frame downloaded
      // twice, and at High priority the duplicates also starved the JS chunks
      // the page needs to boot. If the worker ever makes thumbs cacheable,
      // the idea becomes sound; until then it is pure harm.
      const smallHit = cache.get(smallUrl);
      const adoptSmall = (tex: THREE.Texture) => {
        if (!alive || bigLanded) return;
        if (useStore.getState().currentTexture === null) setTexture(tex);
        // status stays "loading": the full-res fetch is still in flight
      };
      if (smallHit) adoptSmall(smallHit);
      else
        loader.load(smallUrl, (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          put(smallUrl, tex);
          adoptSmall(tex);
        });
      loader.load(
        url,
        (tex) => {
          bigLanded = true;
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
