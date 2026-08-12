import { useStore, SPACES } from "../store";
import BuyLink from "./BuyLink";

// Per-space copy, cross-faded by scroll progress. Each line owns a slice of the
// scroll; opacity peaks mid-slice and falls at the edges. Text never animates
// over a moving camera — it lives in the still center of each space.
const COPY: Record<string, { eyebrow?: string; line: string }> = {
  threshold: { eyebrow: "My Heliograph", line: "The Sun, on the day that mattered to you." },
  surface: { line: "The light that lit your day." },
  aperture: { line: "Select a color." },
  crossing: { line: "Ninety-three million miles to earth, traversed in 8 minutes." },
  darkroom: { line: "Through your window, onto your wall." },
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
            className={
              "overlay-line" +
              (s.key === "threshold" ? " overlay-line--hero" : "") +
              (s.key === "room" ? " overlay-line--climax" : "")
            }
            style={{ opacity: o, transform: `translateY(${(1 - o) * 14}px)` }}
          >
            {c.eyebrow && <figcaption className="eyebrow">{c.eyebrow}</figcaption>}
            <p
              className={
                s.key === "room"
                  ? "line climax"
                  : s.key === "crossing"
                    ? "line line--caption"
                    : "line"
              }
            >
              {c.line}
            </p>
            {s.key === "gift" && (
              // decorative twin of the real CTA in <nav id="buy">; kept out of the
              // tab order since the whole overlay is aria-hidden
              <BuyLink className="cta" decorative style={{ pointerEvents: o > 0.15 ? "auto" : "none" }}>
                Make one
              </BuyLink>
            )}
          </figure>
        );
      })}
    </div>
  );
}
