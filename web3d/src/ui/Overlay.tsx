import { useEffect, useRef } from "react";
import { useStore, SPACES, dateValid } from "../store";
import BuyLink from "./BuyLink";

// "24 October 2014". The visitor typed 2014-10-24; nobody's memory is stored
// in ISO. Parsed as UTC noon so the label can never slip a day for a visitor
// west of Greenwich.
function longDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

// The curtain call.
//
// The film used to simply stop: after "printed on just about anything" the
// page ran out, with no frame that put the visitor's own date, the argument,
// and the one action together (audit in Chrome, 2026-08-26). Everything
// before this beat sells the Sun; nobody buys the Sun, they buy a DAY — so
// the last thing on screen is their day, named, with the one fact that makes
// it worth keeping and the one button that gets it.
//
// Subscribes to date/progress as derived values, so it re-renders on the
// threshold crossing and on a date change, not at 60Hz.
function ClosingCard() {
  const date = useStore((s) => s.date);
  const shown = useStore((s) => s.progress >= 0.972);
  const valid = useStore(dateValid);
  if (!valid) return null;
  return (
    <div className={"closing" + (shown ? " closing--in" : "")} aria-hidden={!shown}>
      <p className="closing-date">{longDate(date)}</p>
      <p className="closing-line">A day worth keeping.</p>
      <BuyLink className="cta closing-cta">Make this one</BuyLink>
    </div>
  );
}

// Per-space copy, cross-faded by scroll progress. Each line owns a slice of the
// scroll; opacity peaks mid-slice and falls at the edges. Text never animates
// over a moving camera — it lives in the still center of each space.
const COPY: Record<string, { line: string }> = {
  // threshold has NO copy on purpose. The masthead carries the name, tagline
  // and pitch at the top of the page now, so a second headline over the same
  // frame was two competing hero statements at once. The first line that
  // animates is "The light that lit your day", once the camera is already in.
  surface: { line: "The light that lit your day." },
  // Not "Choose your wavelength": the wheel this beat frames is an
  // illustration, and a command implied the wedges were tappable (they are
  // not; the real controls live in the customizer drawer). Descriptive line
  // instead; the drawer is where choosing happens.
  // EIGHT, not nine. 1700 A was dropped from both wheels on 2026-08-18
  // (JSOC has no synoptic bypass for it, so it queued for minutes), and
  // this line kept counting it — a page that states a number the picture
  // beside it contradicts, on the beat whose entire job is to show them.
  aperture: { line: "One Sun, in eight kinds of light." },
  // Distance, not elapsed time. "Eight minutes ago" is only true for an image
  // taken right now, and almost every visitor is buying a historical date — for
  // a 2017 frame the light left the Sun nine years ago, not eight minutes. The
  // crossing is the same ~93 million miles (1 AU, within about 2% over the
  // year) whatever date they picked, so the spatial framing is both the honest
  // claim and the one this beat actually shows: the beam reaching Earth.
  crossing: { line: "Ninety-three million miles, crossed to reach you." },
  // "The same Sun", not "the same sunlight": the imagery for sale is EUV/UV,
  // which never reaches a backyard through the atmosphere. The star overhead
  // is the honest (and stronger) claim; the false-colour caveat lives with
  // the wavelength controls.
  sky: { line: "The same Sun, over your own backyard." },
  // Was "Through your window, onto your wall", which read as the pictured
  // light physically streaming through household glass (EUV does not). The
  // beat is the image arriving in the visitor's home; say that.
  darkroom: { line: "Into your home, onto your wall." },
  room: { line: "Your day, written in sunlight." },
  gift: { line: "Held still. Made to keep." },
  gallery: { line: "Choose something to keep it on." },
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
// aperture peaks a beat AFTER its slice start (not at it) so its fade-in only
// begins once "surface" has fully cleared — otherwise the two lines overlap
// (surface was still fading out while "select a color" was already rising).
// gallery peaks MID-slice, not at the bottom of the page. The film now has a
// closing card at the very end (see ClosingCard below) and the shelf line has
// to have finished speaking before it arrives, or the last frame carries two
// competing statements.
const PEAK_OVERRIDE: Record<string, number> = { aperture: 0.25, gallery: 0.947 };
// HALF_AT tightened from 0.035 to 0.028 so aperture's window is [0.222, 0.278]:
// "surface" hits exactly 0 at 0.22 (its slice boundary), and 0.035 started
// aperture's fade-in at 0.215 — a genuine 0.215–0.22 double-exposure.
const HALF_AT: Record<string, number> = { aperture: 0.028, gallery: 0.022 };
function opacityFor(progress: number, i: number) {
  const key = SPACES[i].key;
  const start = SPACES[i].start;
  const end = i + 1 < SPACES.length ? SPACES[i + 1].start : 1.0001;
  const peak =
    PEAK_OVERRIDE[key] ??
    (i === 0 || PEAK_AT_START.has(key)
      ? start
      : i === SPACES.length - 1
        ? end
        : (start + end) / 2);
  const half = HALF_AT[key] ?? Math.max(end - peak, peak - start, 1e-4);
  const d = Math.abs(progress - peak) / half; // 0 at peak, 1 at slice edge
  // full until d passes HOLD, then a quick linear fade to 0 at the edge
  return Math.max(0, Math.min(1, (1 - d) / (1 - HOLD)));
}

// Split out so only THIS subtree re-renders when the date changes, rather
// than the whole overlay and its eight refs.
function ClimaxDate() {
  const date = useStore((s) => s.date);
  const valid = useStore(dateValid);
  if (!valid) return null;
  return <p className="line-date">{longDate(date)}</p>;
}

// The fixed, static list of spaces that actually carry copy (threshold is
// intentionally silent) — computed once so the mount-time ref array and the
// per-frame subscription below always walk the same order.
const ITEMS = SPACES.map((s, i) => ({ space: s, index: i, copy: COPY[s.key] })).filter(
  (it): it is typeof it & { copy: NonNullable<typeof it.copy> } => Boolean(it.copy)
);

export default function Overlay() {
  const channelChosen = useStore((s) => s.channelChosen);
  // One ref per rendered figure. Progress ticks at 60Hz (Lenis), so the
  // opacity/transform it drives is written directly to these refs from a
  // single store subscription below rather than through React re-renders,
  // which would otherwise fire all eight lines through reconciliation on
  // every scroll tick, competing with the 3D render loop.
  const refs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const write = (progress: number) => {
      for (let n = 0; n < ITEMS.length; n++) {
        const { space: s, index } = ITEMS[n];
        const el = refs.current[n];
        if (!el) continue;
        const o = opacityFor(progress, index);
        el.style.opacity = String(o);
        el.style.transform = `translateY(${(1 - o) * 14}px)`;
        // Fully-faded lines paint nothing — also kills the "dark smudge" of a
        // faded line's blurred ::before scrim (see styles.css).
        el.style.visibility = o <= 0.001 ? "hidden" : "visible";
        if (s.key === "gift") {
          // decorative CTA: only clickable once its figure has actually
          // faded in (was an inline pointerEvents style on the render path;
          // see the .overlay-cta-off rule in styles.css)
          el.classList.toggle("overlay-cta-off", o <= 0.15);
        }
      }
    };
    write(useStore.getState().progress); // paint the initial frame before the first tick
    return useStore.subscribe((s) => write(s.progress));
  }, []);

  return (
    <>
    <ClosingCard />
    <div className="overlay" aria-hidden="true">
      {ITEMS.map(({ space: s, copy: c }, n) => (
        <figure
          key={s.key}
          ref={(el) => {
            refs.current[n] = el;
          }}
          className={
            "overlay-line" +
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
        >
          <p
            className={
              s.key === "room"
                ? "line climax"
                : s.key === "crossing" || s.key === "aperture"
                  ? // aperture "Select a color." is a wheel instruction, not a
                    // story headline: the tracked-sans caption register gives it
                    // clear hierarchy so it stops competing with the serif lines.
                    "line line--caption"
                  : "line"
            }
          >
            {c.line}
          </p>
          {/* The ask. "One Sun, in eight kinds of light" DESCRIBES the wheel;
              it never asks for anything, so the beat presented eight dim
              wedges and no reason to touch them — a room of unlabelled
              buttons (audit in Chrome, 2026-08-26). The line swaps to the
              nudge once a choice is made, so the beat always says either
              "do this" or "done, carry on", never nothing. */}
          {/* The climax names the day. "Your day, written in sunlight" is a
              promise about a date the film already knows — printing it here
              is the moment the product stops being a poster of a star and
              becomes a record of the visitor's own life. */}
          {s.key === "room" && <ClimaxDate />}
          {s.key === "aperture" && (
            <p className="scroll-hint">
              {channelChosen ? "Keep scrolling to continue" : "Pick a light to keep"}
            </p>
          )}
          {s.key === "gift" && (
            // decorative twin of the real CTA in <nav id="buy">; kept out of the
            // tab order since the whole overlay is aria-hidden
            <BuyLink className="cta" decorative>
              Make one
            </BuyLink>
          )}
        </figure>
      ))}
    </div>
    </>
  );
}
