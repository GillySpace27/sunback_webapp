import { useStore, BEAT_STOPS } from "../store";

// Left/right timeline controls: each jumps to the previous / next beat at its
// best-framed moment, so the entire film is reachable with the arrows alone —
// no scrolling required.
export default function Arrows() {
  const progress = useStore((s) => s.progress);
  const scrollToProgress = useStore((s) => s.scrollToProgress);
  const dateChosen = useStore((s) => s.dateChosen);
  // soft nudge on the opening beat until a date is picked: pulse "next"
  const nudge = !dateChosen && progress < 0.08;

  const next = BEAT_STOPS.find((c) => c > progress + 0.015);
  const prevs = BEAT_STOPS.filter((c) => c < progress - 0.015);
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
        className={"arrow arrow--next" + (nudge ? " arrow--nudge" : "")}
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
