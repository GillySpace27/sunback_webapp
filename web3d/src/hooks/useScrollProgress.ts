import { useEffect } from "react";
import Lenis from "lenis";
import { useStore } from "../store";

// Lenis smooth-scroll → single normalized progress (0..1) in the store.
// The camera scrubs off this; GSAP-style triggers can read thresholds off it.
// ponytail: Lenis' own rAF drives progress; no separate ScrollTrigger needed
// for the demo. Add GSAP ScrollTrigger when per-element scrubbed timelines land.
export function useScrollProgress() {
  const setProgress = useStore((s) => s.setProgress);
  const reduced = useStore((s) => s.reducedMotion);

  useEffect(() => {
    const lenis = new Lenis({
      duration: reduced ? 0 : 1.1,
      smoothWheel: !reduced,
      wheelMultiplier: 1,
      touchMultiplier: 1.2,
    });

    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0);
    };

    let raf = 0;
    const loop = (t: number) => {
      lenis.raf(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    lenis.on("scroll", onScroll);
    onScroll();

    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, [setProgress, reduced]);
}
