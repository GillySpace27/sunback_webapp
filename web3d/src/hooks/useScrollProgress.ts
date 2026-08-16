import { useEffect } from "react";
import Lenis from "lenis";
import { useStore } from "../store";

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

    // Lenis maintains its own scroll/limit pair, updated by its internal
    // ResizeObserver in the SAME tick. Deriving progress from
    // scrollY / (scrollHeight - innerHeight) instead made progress JUMP
    // discontinuously on mobile whenever the URL bar collapsed mid-scroll
    // (innerHeight changes under the reader), skipping transition ranges
    // outright — one cause of "fast scroll leaves the scene half-composed".
    const onScroll = (e: Lenis) => {
      const limit = e.limit;
      setProgress(limit > 0 ? Math.min(1, Math.max(0, e.scroll / limit)) : 0);
    };

    // let the timeline arrows jump to a target progress (0..1) via Lenis
    setScrollToProgress((p: number) => {
      lenis.scrollTo(Math.min(1, Math.max(0, p)) * lenis.limit, { duration: reduced ? 0 : 1.2 });
    });

    let raf = 0;
    const loop = (t: number) => {
      lenis.raf(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    lenis.on("scroll", onScroll);
    onScroll(lenis);

    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, [setProgress, setScrollToProgress, reduced]);
}
