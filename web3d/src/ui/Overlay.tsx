import { useStore, SPACES } from "../store";

// Per-space copy, cross-faded by scroll progress. Each line owns a slice of the
// scroll; opacity peaks mid-slice and falls at the edges. Text never animates
// over a moving camera — it lives in the still center of each space.
const COPY: Record<string, { eyebrow?: string; line: string }> = {
  threshold: { eyebrow: "My Heliograph", line: "The Sun, on the day that mattered." },
  surface: { line: "Ninety-three million miles. Eight minutes of light." },
  crossing: { line: "Then the long dark, crossed for one person." },
  aperture: { line: "Choose the light. Aim the instrument." },
  darkroom: { line: "Caught, and pressed into paper." },
  room: { line: "Your day, written in sunlight." },
  gift: { line: "A gift made of a star." },
};

function opacityFor(progress: number, i: number) {
  const start = SPACES[i].start;
  const end = i + 1 < SPACES.length ? SPACES[i + 1].start : 1.0001;
  // First line peaks at the very top (progress 0), last at the very bottom, so
  // both extremes are legible without scrolling; middle lines peak mid-slice.
  const peak = i === 0 ? start : i === SPACES.length - 1 ? end : (start + end) / 2;
  const half = Math.max(end - peak, peak - start, 1e-4);
  const d = Math.abs(progress - peak) / half; // 0 at peak, 1 at slice edge
  return Math.max(0, 1 - d * 1.15);
}

export default function Overlay() {
  const progress = useStore((s) => s.progress);
  return (
    <div className="overlay" aria-hidden="true">
      {SPACES.map((s, i) => {
        const c = COPY[s.key];
        const o = opacityFor(progress, i);
        return (
          <figure
            key={s.key}
            className="overlay-line"
            style={{ opacity: o, transform: `translateY(${(1 - o) * 14}px)` }}
          >
            {c.eyebrow && <figcaption className="eyebrow">{c.eyebrow}</figcaption>}
            <p className={s.key === "room" ? "line climax" : "line"}>{c.line}</p>
            {s.key === "gift" && (
              <a className="cta" href="https://myheliograph.com" style={{ pointerEvents: o > 0.5 ? "auto" : "none" }}>
                Make one
              </a>
            )}
          </figure>
        );
      })}
    </div>
  );
}
