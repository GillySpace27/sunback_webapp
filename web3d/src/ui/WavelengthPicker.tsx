import { useState } from "react";
import { useStore, dateValid } from "../store";
import { CHANNELS } from "../data/wavelengths";
import BuyLink from "./BuyLink";
import DateField from "./DateField";

// The pinned "configure + commit" bar: date, wavelength (accessible counterpart
// to the 3D filter wheel), a live readout, and a real visible "Make one". It is
// always present but COLLAPSIBLE — a slim handle the visitor can open at any
// time. Stays collapsed by default (incl. the gallery, where the clickable 3D
// products are the buy affordance and an expanded bar would hide them).
export default function WavelengthPicker() {
  const channel = useStore((s) => s.channel);
  const setChannel = useStore((s) => s.setChannel);
  const status = useStore((s) => s.texStatus);
  const valid = useStore(dateValid);
  const active = CHANNELS[channel];
  // Reveal the plate once the opening beat's own controls have cleared —
  // HeroDate fades to opacity 0 at progress 0.1 (see HeroDate.tsx) — so the
  // two date fields are never both on screen. A derived boolean selector, not
  // the raw progress value, so this only re-renders on the rare threshold
  // crossing rather than every 60Hz scroll tick (keyboard users can still
  // reveal it early via #buy:focus-within — see styles.css).
  const revealed = useStore((s) => s.progress >= 0.1);

  // collapsed by default; opens on click or keyboard focus into the bar.
  const [open, setOpen] = useState(false);

  return (
    <fieldset
      className={"picker" + (revealed ? " picker--in" : "") + (open ? "" : " picker--collapsed")}
      aria-label="Choose your date and wavelength, then make your print"
      onFocusCapture={() => setOpen(true)}
    >
      <legend className="visually-hidden">Date, solar wavelength, and purchase</legend>

      <button
        type="button"
        className="picker-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        // the bar itself is opacity:0 + pointer-events:none until `revealed`
        // (see .picker in styles.css) — without this, the button stayed in
        // the tab order the whole time, so Enter could open the full panel
        // mid-hero and collide with the hero date field/CTA. Pull it out of
        // the a11y tree on the same condition that drives the CSS gating.
        tabIndex={revealed ? 0 : -1}
      >
        <span className="picker-toggle-label">{open ? "Hide options" : "Make yours"}</span>
        <svg className="picker-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d={open ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="picker-body">
      {/* the day that mattered — feeds the real Sun image and the deep link */}
      <DateField labelClassName="date-field" labelSpanClassName="date-label" labelText="Your date" />

      {/* live label + load state — the only wavelength cue on touch */}
      <output className="picker-readout" aria-live="polite">
        {active.instrument} · {active.label} · <span className="picker-sees">{active.sees}</span>
        {status === "loading" && <span className="picker-status"> · developing your Sun…</span>}
        {status === "error" && <span className="picker-status err"> · no image for this date</span>}
      </output>

      <div className="swatches">
        {CHANNELS.map((ch, i) => (
          <label
            key={ch.angstrom}
            className="swatch"
            style={{ ["--tint" as string]: ch.tint }}
          >
            <input
              type="radio"
              name="wavelength"
              aria-label={`${ch.instrument} ${ch.label}: ${ch.sees}`}
              checked={i === channel}
              onChange={() => setChannel(i)}
              // roving tabindex: one tab stop for the group, arrows move within
              tabIndex={i === channel ? 0 : -1}
            />
            <span className="swatch-dot" aria-hidden="true" />
            <span className="swatch-label">{ch.label}</span>
            {/* styled tooltip: what this wavelength reveals (hover + focus) */}
            <span className="swatch-tip" role="tooltip">{ch.sees}</span>
          </label>
        ))}
      </div>

      {/* commit — visible for mouse from the moment the bar is revealed */}
      <div className="picker-buy">
        <BuyLink className="cta cta--bar">Make one</BuyLink>
        {/* the CTA above goes inert without a committed date: tell the
            visitor why instead of leaving a dead-looking button */}
        {!valid && <span className="picker-hint">Pick a date to continue</span>}
        <span className="price-anchor">Prints from $9.99</span>
      </div>
      </div>
    </fieldset>
  );
}
