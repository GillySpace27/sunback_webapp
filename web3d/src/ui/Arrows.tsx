import { useEffect, useRef } from "react";
import { useStore, BEAT_STOPS } from "../store";

// Left/right timeline controls: each jumps to the previous / next beat at its
// best-framed moment, so the entire film is reachable with the arrows alone —
// no scrolling required.
export default function Arrows() {
  const scrollToProgress = useStore((s) => s.scrollToProgress);
  // rare change (flips once, on first pick) — a normal selector is fine here;
  // only `progress` ticks at 60Hz and that is handled imperatively below.
  const dateChosen = useStore((s) => s.dateChosen);
  const prevRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  // latest jump targets, read by the click handlers — kept out of React state
  // so a scroll tick never triggers a re-render.
  const targets = useRef<{ prev?: number; next?: number }>({});

  useEffect(() => {
    const write = (progress: number) => {
      const next = BEAT_STOPS.find((c) => c > progress + 0.015);
      const prevs = BEAT_STOPS.filter((c) => c < progress - 0.015);
      const prev = prevs.length ? prevs[prevs.length - 1] : undefined;
      targets.current = { prev, next };
      // soft nudge on the opening beat until a date is picked: pulse "next"
      const nudge = !dateChosen && progress < 0.08;
      if (prevRef.current) prevRef.current.disabled = prev === undefined;
      if (nextRef.current) {
        nextRef.current.disabled = next === undefined;
        nextRef.current.classList.toggle("arrow--nudge", nudge);
      }
    };
    write(useStore.getState().progress);
    return useStore.subscribe((s) => write(s.progress));
    // re-subscribe (cheap; fires at most once) when dateChosen flips, so the
    // closure's nudge condition stays current without a 60Hz dependency.
  }, [dateChosen]);

  return (
    <div className="arrows">
      <button
        ref={prevRef}
        className="arrow arrow--prev"
        aria-label="Previous"
        onClick={() => targets.current.prev !== undefined && scrollToProgress(targets.current.prev)}
      >
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        ref={nextRef}
        className="arrow arrow--next"
        aria-label="Next"
        onClick={() => targets.current.next !== undefined && scrollToProgress(targets.current.next)}
      >
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
