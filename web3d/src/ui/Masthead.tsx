import { useStore } from "../store";

// The canonical masthead, matching the store's hero so the two halves open the
// same way. Until now the 3D page announced itself only through scroll-driven
// overlay copy, which meant a visitor's first frame carried no name, no
// tagline and no explanation of what the site sells — the film started before
// the title card.
//
// It fades out as the journey begins (same treatment as HeroDate) so it never
// competes with the crossing, and it is real text rather than an image, so it
// is selectable, translatable and readable by a screen reader.
export default function Masthead() {
  const progress = useStore((s) => s.progress);
  // Present on the opening beat only; gone well before the aperture.
  const o = Math.max(0, 1 - progress / 0.075);
  if (o <= 0.001) return null;

  return (
    <header
      className="masthead"
      style={{
        opacity: o,
        transform: `translateX(-50%) translateY(${(1 - o) * -12}px)`,
        pointerEvents: "none",
      }}
    >
      <h1 className="masthead-title">My Heliograph</h1>
      <p className="masthead-tagline">Your day, written in sunlight</p>
      <p className="masthead-intro">
        Pick any date since 2010: real NASA/SDO observations of the Sun from that day, enhanced
        with a published algorithm to reveal coronal structure the raw data hides. Yours as a
        print, poster, or canvas.
      </p>
      <p className="masthead-credit">
        Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams. Not affiliated; no
        endorsement implied.
      </p>
    </header>
  );
}
