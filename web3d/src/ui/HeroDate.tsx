import { useEffect, useRef } from "react";
import { useStore } from "../store";
import DateField from "./DateField";

// Asked first, at the threshold: the day that mattered. Setting it here means
// the Sun in the 3D world is already THEIR Sun, not a placeholder. Non-blocking
// (pre-filled, scroll works either way); it fades out as the journey begins.
export default function HeroDate() {
  const dateChosen = useStore((s) => s.dateChosen);
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
      <DateField
        labelClassName="hero-date-field"
        labelSpanClassName="hero-date-label"
        labelText="Pick your date"
        ariaLabel="The date whose Sun you want to see"
      />
      <span className="hero-date-hint">…then scroll into the light</span>
    </div>
  );
}
