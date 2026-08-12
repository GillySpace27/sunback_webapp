import { useStore, spaceCenters } from "../store";

// Left/right timeline controls for anyone who finds scrolling fussy: each jumps
// to the previous / next beat (the center of a space, where its copy peaks).
export default function Arrows() {
  const progress = useStore((s) => s.progress);
  const scrollToProgress = useStore((s) => s.scrollToProgress);
  const centers = spaceCenters();

  const next = centers.find((c) => c > progress + 0.01);
  const prevs = centers.filter((c) => c < progress - 0.01);
  const prev = prevs.length ? prevs[prevs.length - 1] : undefined;

  return (
    <div className="arrows">
      <button
        className="arrow arrow--prev"
        aria-label="Previous"
        disabled={prev === undefined}
        onClick={() => prev !== undefined && scrollToProgress(prev)}
      >
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        className="arrow arrow--next"
        aria-label="Next"
        disabled={next === undefined}
        onClick={() => next !== undefined && scrollToProgress(next)}
      >
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
