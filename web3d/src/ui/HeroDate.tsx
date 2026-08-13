import { useStore } from "../store";

// Asked first, at the threshold: the day that mattered. Setting it here means
// the Sun in the 3D world is already THEIR Sun, not a placeholder. Non-blocking
// (pre-filled, scroll works either way); it fades out as the journey begins.
export default function HeroDate() {
  const date = useStore((s) => s.date);
  const setDate = useStore((s) => s.setDate);
  const dateChosen = useStore((s) => s.dateChosen);
  const progress = useStore((s) => s.progress);
  const today = new Date().toISOString().slice(0, 10);
  // present only on the opening beat; fade + lift away as the camera moves in
  const o = Math.max(0, 1 - progress / 0.1);

  return (
    <div
      className={"hero-date" + (!dateChosen ? " hero-date--nudge" : "")}
      style={{
        opacity: o,
        transform: `translateX(-50%) translateY(${(1 - o) * 10}px)`,
        pointerEvents: o > 0.1 ? "auto" : "none",
      }}
    >
      <label className="hero-date-field">
        <span className="hero-date-label">Pick your date</span>
        <input
          type="date"
          value={date}
          min="2010-05-15"
          max={today}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          aria-label="The date whose Sun you want to see"
        />
      </label>
      <span className="hero-date-hint">…then scroll into the light</span>
    </div>
  );
}
