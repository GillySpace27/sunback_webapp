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

// One line per space: peaks mid-slice, falls to 0 exactly at each boundary so
// the lines never overlap (they hand off cleanly) and there is no dead band.
// First line peaks at the very top (progress 0), last at the very bottom.
function opacityFor(progress: number, i: number) {
  const start = SPACES[i].start;
  const end = i + 1 < SPACES.length ? SPACES[i + 1].start : 1.0001;
  const peak = i === 0 ? start : i === SPACES.length - 1 ? end : (start + end) / 2;
  const half = Math.max(end - peak, peak - start, 1e-4);
  const d = Math.abs(progress - peak) / half; // 0 at peak, 1 at slice edge
  return Math.max(0, 1 - d);
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
              // decorative twin of the real CTA in <nav id="buy">; kept out of the
              // tab order since the whole overlay is aria-hidden
              <a
                className="cta"
                href="https://myheliograph.com"
                tabIndex={-1}
                style={{ pointerEvents: o > 0.5 ? "auto" : "none" }}
              >
                Make one
              </a>
            )}
          </figure>
        );
      })}
    </div>
  );
}
