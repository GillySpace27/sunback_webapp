import { useEffect, useRef } from "react";
import { useStore } from "../store";

// Asked first, at the threshold: the day that mattered. Setting it here means
// the Sun in the 3D world is already THEIR Sun, not a placeholder. Non-blocking
// (pre-filled, scroll works either way); it fades out as the journey begins.
export default function HeroDate() {
  const date = useStore((s) => s.date);
  const setDate = useStore((s) => s.setDate);
  const dateChosen = useStore((s) => s.dateChosen);
  // the archive's real bounds, not "today" — see setFrontier in the store
  const minDate = useStore((s) => s.minDate);
  const maxDate = useStore((s) => s.maxDate);
  // progress ticks at 60Hz — write opacity/transform/pointerEvents straight to
  // the DOM from a store subscription instead of re-rendering through React.
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const write = (progress: number) => {
      const el = ref.current;
      if (!el) return;
      // present only on the opening beat; fade + lift away as the camera moves in
      const o = Math.max(0, 1 - progress / 0.1);
      el.style.opacity = String(o);
      el.style.transform = `translateX(-50%) translateY(${(1 - o) * 10}px)`;
      el.style.pointerEvents = o > 0.1 ? "auto" : "none";
    };
    write(useStore.getState().progress);
    return useStore.subscribe((s) => write(s.progress));
  }, []);

  return (
    <div ref={ref} className={"hero-date" + (!dateChosen ? " hero-date--nudge" : "")}>
      <label className="hero-date-field">
        <span className="hero-date-label">Pick your date</span>
        <input
          type="date"
          value={date}
          min={minDate}
          max={maxDate}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          aria-label="The date whose Sun you want to see"
        />
      </label>
      <span className="hero-date-hint">…then scroll into the light</span>
    </div>
  );
}
