import { useEffect } from "react";
import Lenis from "lenis";
import { useStore, BEAT_STOPS, SPACES } from "../store";

// ?at=<0-based beat index>: which beat an incoming link wants to land on.
// Read once at module scope so it cannot change under a re-render.
const AT_BEAT = (() => {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("at");
  if (raw === null) return null;
  const i = Number(raw);
  return Number.isInteger(i) && i >= 0 && i < BEAT_STOPS.length ? i : null;
})();

// Lenis smooth-scroll → single normalized progress (0..1) in the store.
// The camera scrubs off this; GSAP-style triggers can read thresholds off it.
// ponytail: Lenis' own rAF drives progress; no separate ScrollTrigger needed
// for the demo. Add GSAP ScrollTrigger when per-element scrubbed timelines land.
export function useScrollProgress() {
  const setProgress = useStore((s) => s.setProgress);
  const setScrollToProgress = useStore((s) => s.setScrollToProgress);
  const reduced = useStore((s) => s.reducedMotion);

  useEffect(() => {
    const lenis = new Lenis({
      duration: reduced ? 0 : 1.1,
      smoothWheel: !reduced,
      wheelMultiplier: 1,
      touchMultiplier: 1.2,
    });

    // ── Beat detents ────────────────────────────────────────────────────
    // Each beat is a shallow gravity well: come to rest near one and you
    // settle INTO it, at the composition it was framed for, rather than a few
    // percent off it with the copy half-faded.
    //
    // Deliberately a post-hoc settle, not CSS scroll-snap. Snap points would
    // fight Lenis for control of the same scroller and make fast flicks feel
    // sticky; this never intercepts a gesture, it only tidies up once one is
    // over. Three guards keep it from ever feeling like a fight:
    //
    //   PULL   only snap when already close. Stop deliberately between two
    //          beats and you are left there — the well is shallow, not total.
    //   QUIET  only after scrolling has actually stopped, so it cannot yank
    //          the page mid-flick.
    //   reduced-motion callers get no animated correction at all.
    const PULL = 0.028;   // ~a third of the narrowest gap between stops
    const QUIET = 220;    // ms of stillness that counts as "come to rest"
    // Stretches with nothing composed to rest on. Currently just the
    // atmosphere flash between the crossing and the ground (see below).
    // Both of AtmosphereFlash's windows: the space-to-ground flash and the
    // outside-to-inside-the-cabin one. Kept slightly inside each so a rest at
    // a real stop next door is never dragged.
    const DEAD_ZONES: [number, number][] = [[0.478, 0.556], [0.726, 0.792]];
    let settleTimer = 0;
    let userDriven = false;

    const scheduleSettle = () => {
      if (reduced) return;
      clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (!userDriven) return;
        userDriven = false;
        const limit = lenis.limit;
        if (limit <= 0) return;
        const p = lenis.scroll / limit;
        // Never drag someone off the very top or bottom: those are real
        // resting places (the opening frame, the end of the film) and pulling
        // away from them reads as the page refusing to stay put.
        if (p <= 0.001 || p >= 0.999) return;
        // The date beat HOLDS you inside its own slice until the date is set.
        //
        // This is the "strong nudge" (Gilly, 2026-08-23), not a scroll lock:
        // anywhere inside the surface beat, coming to rest returns you to its
        // framed moment where the date control is. Scroll past the beat and it
        // lets go completely. A hard gate reads as a broken page and traps
        // keyboard and screen-reader users at a control nobody announced.
        //
        // Expressed as "inside the slice", NOT as a bigger pull radius. The
        // radius version was measured inert on 2026-08-23: `near` picks the
        // closest stop FIRST, so past the midpoint to the next stop (0.1975)
        // the aperture stop always won and the deeper well never applied. Slice
        // membership is also the honest rule — it holds you within one beat and
        // never drags you backwards across a boundary you deliberately crossed.
        const undated = !useStore.getState().dateChosen;
        const inDateBeat = p >= SPACES[1].start && p < SPACES[2].start;
        if (undated && inDateBeat) {
          if (Math.abs(BEAT_STOPS[1] - p) > 0.004) {
            lenis.scrollTo(BEAT_STOPS[1] * limit, { duration: 0.55 });
          }
          return;
        }
        const near = BEAT_STOPS.reduce((a, b) => (Math.abs(b - p) < Math.abs(a - p) ? b : a));
        // DEAD_ZONES override PULL: some stretches of the film are transitions
        // with nothing composed to look at, and coming to rest inside one is
        // never what anybody meant to do.
        //
        // The atmosphere flash is the case that forced this. The starfield and
        // the Sun both cut out at 0.51 and the ground has not resolved yet, so
        // the band between them is a blank cream field — and it sits 0.05 from
        // the crossing stop and 0.085 from the sky stop, i.e. outside PULL from
        // BOTH. Stopping there left the film looking crashed, with the crossing
        // copy floating in a grey smudge over nothing (audit in Chrome,
        // 2026-08-26). Inside a dead zone the nearest stop always wins, however
        // far away it is.
        const dead = DEAD_ZONES.some(([a, b]) => p > a && p < b);
        if (!dead && Math.abs(near - p) > PULL) return;
        lenis.scrollTo(near * limit, { duration: dead ? 0.85 : 0.55 });
      }, QUIET);
    };

    // Lenis maintains its own scroll/limit pair, updated by its internal
    // ResizeObserver in the SAME tick. Deriving progress from
    // scrollY / (scrollHeight - innerHeight) instead made progress JUMP
    // discontinuously on mobile whenever the URL bar collapsed mid-scroll
    // (innerHeight changes under the reader), skipping transition ranges
    // outright — one cause of "fast scroll leaves the scene half-composed".
    const onScroll = (e: Lenis) => {
      const limit = e.limit;
      setProgress(limit > 0 ? Math.min(1, Math.max(0, e.scroll / limit)) : 0);
      // Kick the settle timer on every scroll tick, so it expires QUIET ms
      // after motion actually ceases rather than QUIET ms after the last
      // wheel notch. Cheap: one clearTimeout/setTimeout per frame while
      // scrolling, and nothing at all once the page is still.
      scheduleSettle();
    };

    // let the timeline arrows jump to a target progress (0..1) via Lenis
    setScrollToProgress((p: number) => {
      const to = Math.min(1, Math.max(0, p));
      // Duration scales with DISTANCE. A fixed 1.2s meant a jump across half
      // the film travelled thousands of pixels in the same time as a nudge
      // between neighbouring beats, which scrubbed the scenery past far faster
      // than any of it could land — the arrows read as a fast-forward button
      // rather than as moving through a film (Gilly, 2026-08-25). Floored so
      // short hops still feel deliberate, ceilinged so a long jump never turns
      // into a wait.
      const dist = Math.abs(to - (lenis.limit > 0 ? lenis.scroll / lenis.limit : 0));
      const duration = reduced ? 0 : Math.min(2.8, Math.max(1.1, 0.9 + dist * 4.2));
      lenis.scrollTo(to * lenis.limit, { duration });
    });

    // ?at=<beat index> — land mid-film instead of at frame one.
    //
    // Handled HERE rather than in a component, because this is the only place
    // that knows Lenis actually exists. It CANNOT fire on mount, though: the
    // Scene chunk is lazy, so at this moment the document is still viewport-
    // height and `lenis.limit` is 0 — target = stop x 0 = the top, which is
    // precisely the "drops you back at the top" bug this was meant to fix.
    // Measured on dev: limit 0 at mount, 4752 once laid out.
    //
    // So it waits for a real limit inside the rAF loop below and fires once.
    // Jumped without animation: this is where the visitor asked to arrive, so
    // sliding there from the top would replay beats they chose to skip.
    let landed = AT_BEAT === null;
    const tryLand = () => {
      if (landed || lenis.limit <= 0) return;
      landed = true;
      lenis.scrollTo(BEAT_STOPS[AT_BEAT as number] * lenis.limit, { immediate: true });
    };

    // Only settle after input the VISITOR produced. Without this the
    // programmatic scrollTo above would re-trigger the settle, which would
    // re-trigger scrollTo: a loop that never quite lands.
    //
    // Marking is all this does — it deliberately does NOT start the timer.
    // Lenis keeps gliding for ~1.1s after the wheel stops, so a timer keyed to
    // the INPUT fires while the page is still mid-flight, far from any stop,
    // declines the snap, and is never rescheduled because no further input
    // arrives. Measured: a wheel to 1.2% short of a stop settled 71px off it
    // and stayed there. The timer is kicked from onScroll instead, so it
    // measures when MOTION stopped, which is the thing actually being waited
    // for.
    const markUser = () => { userDriven = true; };
    window.addEventListener("wheel", markUser, { passive: true });
    window.addEventListener("touchmove", markUser, { passive: true });
    window.addEventListener("keydown", markUser, { passive: true });

    let raf = 0;
    const loop = (t: number) => {
      lenis.raf(t);
      tryLand();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    lenis.on("scroll", onScroll);
    onScroll(lenis);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(settleTimer);
      window.removeEventListener("wheel", markUser);
      window.removeEventListener("touchmove", markUser);
      window.removeEventListener("keydown", markUser);
      lenis.destroy();
    };
  }, [setProgress, setScrollToProgress, reduced]);
}
