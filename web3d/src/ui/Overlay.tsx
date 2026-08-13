import { useStore, SPACES } from "../store";
import BuyLink from "./BuyLink";

// Per-space copy, cross-faded by scroll progress. Each line owns a slice of the
// scroll; opacity peaks mid-slice and falls at the edges. Text never animates
// over a moving camera — it lives in the still center of each space.
const COPY: Record<string, { eyebrow?: string; line: string }> = {
  threshold: { eyebrow: "My Heliograph", line: "The Sun, on the day that mattered to you." },
  surface: { line: "The light that lit your day." },
  aperture: { line: "Select a color." },
  crossing: { line: "Light that left the Sun eight minutes ago." },
  sky: { line: "The same star, over your own backyard." },
  darkroom: { line: "Through your window, onto your wall." },
  room: { line: "Your day, written in sunlight." },
  gift: { line: "Held still. Made to keep." },
  gallery: { line: "On anything you'll keep." },
};

// One line per space. Each line HOLDS at full opacity across the middle of its
// slice (a trapezoid, not a triangle) and only fades in the outer edges, so the
// copy actually rests and reads instead of being legible for a single instant.
// Lines still reach 0 exactly at each boundary, so they hand off with no overlap
// and no dead band. First line peaks at the top (progress 0), last at the bottom.
const HOLD = 0.5; // fraction of each half-slice held at full opacity before it fades
// Beats whose camera frames the subject at the slice START (its dwell), not the
// center — their copy must peak there too or it lands while the camera has
// already moved on. aperture: the wheel is only centered ~0.22–0.25, so it also
// gets a narrow window (HALF_AT) so the copy is gone before the camera flies off.
const PEAK_AT_START = new Set(["aperture"]);
const HALF_AT: Record<string, number> = { aperture: 0.06 };
function opacityFor(progress: number, i: number) {
  const key = SPACES[i].key;
  const start = SPACES[i].start;
  const end = i + 1 < SPACES.length ? SPACES[i + 1].start : 1.0001;
  const peak =
    i === 0 || PEAK_AT_START.has(key)
      ? start
      : i === SPACES.length - 1
        ? end
        : (start + end) / 2;
  const half = HALF_AT[key] ?? Math.max(end - peak, peak - start, 1e-4);
  const d = Math.abs(progress - peak) / half; // 0 at peak, 1 at slice edge
  // full until d passes HOLD, then a quick linear fade to 0 at the edge
  return Math.max(0, Math.min(1, (1 - d) / (1 - HOLD)));
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
              (s.key === "aperture" ? " overlay-line--top" : "") +
              (s.key === "room" ? " overlay-line--climax" : "") +
              (s.key === "crossing" ? " overlay-line--crossing" : "") +
              (s.key === "gallery" ? " overlay-line--gallery" : "") +
              // light-background beats: the dark plasma scrim would be a stain,
              // so they use a soft, wide halo instead (see styles.css)
              (s.key === "sky" || s.key === "darkroom" || s.key === "room"
                ? " overlay-line--light"
                : "")
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
