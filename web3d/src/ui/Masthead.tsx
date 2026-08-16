import { useEffect, useRef } from "react";
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
//
// The NASA attribution deliberately does NOT live here. It is required (SDO
// rules of the road) but it is not a headline, and stacking four blocks of text
// over the opening frame made the landing busy. It moved to a persistent
// footer credit — see <DataCredit /> — where it is always present without
// competing with the pitch.
export default function Masthead() {
  // progress ticks at 60Hz — write opacity/transform straight to the DOM from
  // a store subscription instead of re-rendering this through React.
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const write = (progress: number) => {
      const el = ref.current;
      if (!el) return;
      // Present on the opening beat only; gone well before the aperture.
      const o = Math.max(0, 1 - progress / 0.075);
      if (o <= 0.001) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      el.style.opacity = String(o);
      el.style.transform = `translateX(-50%) translateY(${(1 - o) * -12}px)`;
    };
    write(useStore.getState().progress);
    return useStore.subscribe((s) => write(s.progress));
  }, []);

  return (
    <header className="masthead" ref={ref} style={{ pointerEvents: "none" }}>
      <h1 className="masthead-title">My Heliograph</h1>
      <p className="masthead-tagline">Your day, written in sunlight</p>
      {/* The RHEF explanation ("enhanced with a published algorithm to reveal
          coronal structure the raw data hides") lives on the store page only.
          Here it is a fourth clause competing with the opening frame, and the
          3D journey demonstrates the enhancement rather than asserting it. */}
      <p className="masthead-intro">
        Pick any date since 2010: real NASA/SDO observations of the Sun from that day. Yours as a
        print, poster, or canvas.
      </p>
    </header>
  );
}
