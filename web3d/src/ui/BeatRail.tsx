import { useEffect, useRef } from "react";
import { useStore, BEAT_STOPS, SPACES } from "../store";

// Where you are in the film, and a way to get anywhere in it.
//
// The arrows already step beat to beat, but they answer "what's next?", never
// "how much of this is there, and where am I in it?". A nine-beat scroll film
// with no position indicator asks the visitor to trust that it ends.
//
// Written imperatively for the same reason Arrows is: `progress` ticks at
// 60Hz, and a React subscription to it would re-render this list on every
// frame. The subscription writes DOM attributes directly and the component
// itself renders once.
//
// The labels are the beats' own keys, title-cased. They are deliberately not
// the poster copy ("The light that lit your day") — that is the line the beat
// delivers, far too long for a tick, and repeating it here would steal the
// reveal.
const LABELS: Record<string, string> = {
  threshold: "Your date",
  surface: "The Sun",
  aperture: "Eight lights",
  crossing: "The crossing",
  sky: "Your sky",
  darkroom: "Your wall",
  room: "The print",
  gift: "The gift",
  gallery: "Everything else",
};

export default function BeatRail() {
  const scrollToProgress = useStore((s) => s.scrollToProgress);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const ticks = Array.from(root.querySelectorAll<HTMLButtonElement>(".beatrail__tick"));
    const fill = root.querySelector<HTMLElement>(".beatrail__fill");

    const write = (progress: number) => {
      // Which beat owns the playhead right now: the last one we have reached.
      // Uses the SPACES slice starts, not proximity to BEAT_STOPS, so the
      // label matches the beat actually on screen even mid-transition.
      let active = 0;
      SPACES.forEach((s, i) => {
        if (progress >= s.start) active = i;
      });
      ticks.forEach((el, i) => {
        el.classList.toggle("is-active", i === active);
        el.classList.toggle("is-done", i < active);
        // aria-current is the accessible half of the same fact; without it the
        // rail is a list of nine identical-sounding buttons to a screen reader.
        if (i === active) el.setAttribute("aria-current", "step");
        else el.removeAttribute("aria-current");
      });
      if (fill) fill.style.transform = `scaleY(${Math.min(1, Math.max(0, progress))})`;
    };

    write(useStore.getState().progress);
    return useStore.subscribe((s) => write(s.progress));
  }, []);

  return (
    <nav ref={rootRef} className="beatrail" aria-label="Film chapters">
      <span className="beatrail__track" aria-hidden="true">
        <span className="beatrail__fill" />
      </span>
      <ol className="beatrail__list">
        {SPACES.map((s, i) => (
          <li key={s.key}>
            <button
              type="button"
              className="beatrail__tick"
              onClick={() => scrollToProgress(BEAT_STOPS[i])}
            >
              {/* Label FIRST, dot last: the dots then line up in a single
                  column against the rail's right edge with the labels running
                  out to their left, instead of each dot being pushed around by
                  the width of the word next to it (Gilly, 2026-08-25). */}
              <span className="beatrail__label">{LABELS[s.key] ?? s.key}</span>
              <span className="beatrail__dot" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
