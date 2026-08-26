import { useEffect, useRef } from "react";
import { useStore } from "../store";

// The opening frame's scroll cue, and nothing else.
//
// It used to carry a SECOND date field (plus a list explaining where the other
// controls lived). Both are gone: there is now exactly one date readout in the
// film — the HUD's — and the HUD reveals from this beat onward, so the ask and
// the field the visitor will keep using for the rest of the film are the same
// control (Gilly, 2026-08-24: "let there only be one date readout anywhere").
// The guide list went with it: every control it described is now visible in the
// HUD, so it was captioning things you can already see.
export default function HeroDate() {
  const dateChosen = useStore((s) => s.dateChosen);
  // progress ticks at 60Hz — write opacity straight to the DOM from a store
  // subscription instead of re-rendering through React.
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const write = (progress: number) => {
      const el = ref.current;
      if (!el) return;
      // Full at the top, gone as the HUD rises at 0.10.
      const cue = Math.max(0, 1 - progress / 0.09);
      el.style.opacity = String(cue);
      el.style.transform = `translateX(var(--hero-x, -50%))`;
      el.style.pointerEvents = "none";
    };
    write(useStore.getState().progress);
    return useStore.subscribe((s) => write(s.progress));
  }, []);

  return (
    <div ref={ref} className={"hero-date" + (!dateChosen ? " hero-date--nudge" : "")}>
      <span className="hero-date-hint">Scroll into the light…</span>
    </div>
  );
}
