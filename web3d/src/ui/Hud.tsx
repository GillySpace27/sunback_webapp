import { useStore, dateValid } from "../store";
import BuyLink from "./BuyLink";
import { CHANNELS } from "../data/wavelengths";
import DateField from "./DateField";

// The HUD: every setting that describes the visitor's Sun, laid out and always
// reachable (Gilly, 2026-08-24 — "spilled out into the HUD ... let those be set
// naturally").
//
// It replaces a collapsed "Make yours" panel that hid the same controls behind
// a disclosure. Hiding them made the film's settings feel like a form you had
// to go find, when they are the thing the film is about; and the one control
// that was NOT hidden — a duplicate wavelength swatch row — competed with the
// 3D filter wheel that does the same job better.
//
// NOT HERE, deliberately:
//   FORM (flat vs dimensional) — it changed nothing in the film. It was a
//     purchase setting wearing the costume of a render setting, and a control
//     that does nothing where it is shown teaches people the others are
//     decorative too. The store's handoff quad asks it, where it is real.
//   "MAKE ONE" — the whole film is the call to action; a button competing with
//     it inside the frame is a smaller, worse version of the same ask. The
//     gallery beat's clickable products and Skip-to-store carry the funnel.
//
// WAVELENGTH IS NOT HERE, visually. The "sun pizza" (three/Heliograph.tsx) is
// the wavelength selector now. The radio group below is kept but visually
// hidden, because the wheel is a canvas click: without a real focusable
// control, wavelength becomes unreachable by keyboard or screen reader
// entirely. That group is the accessible counterpart it was always described
// as — it just no longer draws a second, competing UI.
export default function Hud() {
  const channel = useStore((s) => s.channel);
  const setChannel = useStore((s) => s.setChannel);
  const look = useStore((s) => s.look);
  const setLook = useStore((s) => s.setLook);
  const rhefStatus = useStore((s) => s.rhefStatus);
  const status = useStore((s) => s.texStatus);

  const showStars = useStore((s) => s.showStars);
  const showConstellations = useStore((s) => s.showConstellations);
  const showPlanets = useStore((s) => s.showPlanets);
  const showArt = useStore((s) => s.showArt);
  const showLabels = useStore((s) => s.showLabels);
  const showGrid = useStore((s) => s.showGrid);
  const setShowStars = useStore((s) => s.setShowStars);
  const setShowConstellations = useStore((s) => s.setShowConstellations);
  const setShowPlanets = useStore((s) => s.setShowPlanets);
  const setShowArt = useStore((s) => s.setShowArt);
  const setShowLabels = useStore((s) => s.setShowLabels);
  const setShowGrid = useStore((s) => s.setShowGrid);

  const scrollToProgress = useStore((s) => s.scrollToProgress);

  const active = CHANNELS[channel];
  // Revealed from the SURFACE beat (0.10), the beat whose copy reads "The
  // light that lit your day" — so the film's one ask and the control that
  // answers it arrive together, and that same control stays put for the rest
  // of the film. There is no second date field anywhere now. A derived
  // boolean, not raw progress, so this re-renders on the threshold crossing
  // rather than at 60Hz.
  // Visible from the FIRST frame, not from 0.10. The sky-drag is armed at the
  // landing beat, so the date was already moving there with nothing on screen
  // showing it — the gesture looked like it did nothing (Gilly, 2026-08-25).
  // The other rows stay beat-gated below, so the opening frame still carries
  // only the date rather than the whole settings stack.
  const revealed = true;
  // The wheel only exists across the aperture dwell (see Heliograph.tsx). Off
  // that beat there is nothing to click, so the HUD offers to take you there
  // rather than pretending the wavelength is settable from here.
  const wheelOnScreen = useStore((s) => s.progress > 0.205 && s.progress < 0.3);

  // ── Beat-aware ────────────────────────────────────────────────────────
  // Each group is shown only while the beat on screen can actually change
  // what it controls. A HUD that always shows everything is a settings panel
  // that happens to sit over a film; showing only what applies makes it part
  // of the film's rhythm (Gilly, 2026-08-24).
  //
  // The boundaries are the scene's, not invented: the starfield itself stops
  // rendering at progress 0.51 (see Starfield's `el.visible`), so the sky
  // layers genuinely have nothing to act on past there — offering them would
  // be four switches that do nothing visible. The wavelength readout waits
  // for the aperture beat, where the wheel that sets it appears.
  const showSkyRow = useStore((s) => s.progress >= 0.1 && s.progress < 0.51);
  const showLookRow = useStore((s) => s.progress >= 0.19);
  const showReadout = useStore((s) => s.progress >= 0.19);
  // The date stays for the whole film: it is the identity, not a setting, and
  // it is what every later beat is a picture OF.
  // The film's ONE call to action, at the beat where the print is on the wall
  // and the argument has been made — not a button competing with the film for
  // the whole runtime (that one is gone, see the header).
  //
  // It has to exist SOMEWHERE real: the twin at the gift beat lives inside
  // <div className="overlay" aria-hidden="true">, so it is invisible to screen
  // readers and out of the tab order by construction. With the persistent
  // button removed, that left "Skip to the store" as the only keyboard- or
  // AT-reachable way to buy — an escape hatch doing a CTA's job. This is in
  // the real <nav id="buy">, so it is announced and focusable.
  const atClimax = useStore((s) => s.progress >= 0.84);
  // Only while the date is genuinely unanswered, and only on the beats where
  // choosing it is the job. Once a date is committed the prompts have done
  // their work and would just be clutter over the film.
  const dateChosen = useStore((s) => s.dateChosen);
  const askMeaning = useStore((s) => s.progress < 0.22) && !dateChosen;
  const valid = useStore(dateValid);

  const layer = (
    on: boolean,
    set: (v: boolean) => void,
    label: string,
    title?: string
  ) => (
    <label className={"hud-chip" + (on ? " hud-chip--on" : "")} title={title}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{label}</span>
    </label>
  );

  return (
    <fieldset
      className={"hud" + (revealed ? " hud--in" : "")}
      aria-label="Your Sun: date, treatment, sky and format"
    >
      <legend className="visually-hidden">Settings for your Sun</legend>

      {/* WHOSE day is this?
          The film sold the Sun and never once asked the question that
          actually converts. A date field asks for a VALUE; these ask for a
          MEANING, and the difference is the whole product: the moment someone
          types the day they got married, this stops being a poster of a star
          and becomes a record of their own life (audit, 2026-08-26).
          They are real controls, not decoration — each opens the date picker,
          which is the next thing you need after deciding which day it is.
          Shown only while the date is still an open question. */}
      {askMeaning && (
        <div className="hud-row hud-prompts">
          <span className="hud-prompts-lead">Whose day is this?</span>
          {["A birthday", "An anniversary", "The day everything changed"].map((label) => (
            <button
              key={label}
              type="button"
              className="hud-prompt"
              onClick={() => {
                const el = document.querySelector<HTMLInputElement>(".date-input-wrap input");
                if (!el) return;
                el.focus();
                // showPicker throws if the call is not user-activated, and is
                // absent on older Safari — the focus above is the fallback.
                try { el.showPicker?.(); } catch { /* focus is enough */ }
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="hud-row hud-row--identity">
        <DateField labelClassName="date-field" labelSpanClassName="date-label" labelText="Your date" />
        {/* How to work it. The field is a normal date input, but the sky-drag
            is invisible unless someone happens to try it — and it is the more
            expressive of the two. Naming both, next to the control, is the
            whole instruction. */}
        <span className="hud-hint">type it, or drag the sky</span>
        {/* The landing frame has no wavelength readout yet (that waits for
            0.19), so while the opening stand-in is up there was nothing at
            all saying the picture was still arriving — and a soft, not-yet-
            sharp disk with no explanation reads as a cheap render rather
            than as one that is developing (audit in Chrome, 2026-08-26). */}
        {!showReadout && status === "loading" && (
          <span className="hud-hint hud-hint--developing">developing your Sun…</span>
        )}
        <output className="hud-readout" aria-live="polite" data-off={showReadout ? undefined : "1"}>
          {active.instrument} · {active.label} · <span className="picker-sees">{active.sees}</span>
          {status === "loading" && <span className="picker-status"> · developing your Sun…</span>}
          {status === "error" && <span className="picker-status err"> · no image for this date</span>}
        </output>
      </div>

      {/* Wavelength: screen-reader/keyboard only. See the header comment — the
          3D wheel is the visual selector, this is what makes it operable
          without a pointer. */}
      <div className="visually-hidden" role="radiogroup" aria-label="Wavelength">
        {CHANNELS.map((ch, i) => (
          <label key={ch.angstrom}>
            <input
              type="radio"
              name="wavelength"
              aria-label={`${ch.instrument} ${ch.label}: ${ch.sees}`}
              checked={i === channel}
              onChange={() => setChannel(i)}
              tabIndex={i === channel ? 0 : -1}
            />
            {ch.label}
          </label>
        ))}
      </div>

      <div className="hud-row" data-off={showLookRow ? undefined : "1"} aria-hidden={showLookRow ? undefined : true}>
        <span className="hud-legend">Look</span>
        <div className="look-toggle" role="radiogroup" aria-label="Image treatment">
          {(["raw", "rhef"] as const).map((k) => (
            <label key={k} className={"look-option" + (look === k ? " look-option--on" : "")}>
              <input
                type="radio"
                name="look"
                checked={look === k}
                onChange={() => setLook(k)}
                tabIndex={look === k ? 0 : -1}
              />
              <span>{k === "raw" ? "Original" : "Enhanced"}</span>
            </label>
          ))}
        </div>
        {look === "rhef" && rhefStatus === "loading" && (
          <span className="picker-status"> · revealing the corona…</span>
        )}
        {look === "rhef" && rhefStatus === "error" && (
          <span className="picker-status err"> · enhanced view unavailable</span>
        )}
      </div>

      {/* The sky, as separate layers. They were one "Constellations & planets"
          checkbox; wanting the stars without the figures, or the figures
          without the 1824 artwork, was not expressible. */}
      <div className="hud-row hud-row--sky" data-off={showSkyRow ? undefined : "1"} aria-hidden={showSkyRow ? undefined : true}>
        <span className="hud-legend">Sky</span>
        {layer(showStars, setShowStars, "Stars", "The real naked-eye sky for this date")}
        {layer(showConstellations, setShowConstellations, "Lines", "Constellation stick figures")}
        {layer(showArt, setShowArt, "Art", "Urania's Mirror, 1824 — the constellations as drawn figures")}
        {layer(showLabels, setShowLabels, "Names", "Constellation names; the twelve zodiac signs in gold")}
        {layer(showPlanets, setShowPlanets, "Planets", "The naked-eye planets where they actually were")}
        {layer(showGrid, setShowGrid, "Grid", "RA/Dec graticule, plus the ecliptic the Sun travels and the marker riding it")}
      </div>

      {atClimax && (
        <div className="hud-row hud-row--buy">
          <BuyLink className="cta cta--bar">Make one</BuyLink>
          {!valid && <span className="picker-hint">Pick a date to continue</span>}
          <span className="price-anchor">Prints from $9.99</span>
        </div>
      )}

      {!wheelOnScreen && (
        <button
          type="button"
          className="hud-jump"
          onClick={() => scrollToProgress(0.235)}
        >
          Change wavelength →
        </button>
      )}

    </fieldset>
  );
}
