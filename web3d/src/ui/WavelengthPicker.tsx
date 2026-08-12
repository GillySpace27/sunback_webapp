import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import BuyLink from "./BuyLink";

// The pinned "configure + commit" bar: date, wavelength (accessible counterpart
// to the 3D filter wheel), a live readout, and a real visible "Make one" so a
// buyer can commit the moment they're ready — not only at the very end of the
// scroll. State is shared with the wheel through the store.
export default function WavelengthPicker() {
  const channel = useStore((s) => s.channel);
  const setChannel = useStore((s) => s.setChannel);
  const date = useStore((s) => s.date);
  const setDate = useStore((s) => s.setDate);
  const status = useStore((s) => s.texStatus);
  const revealed = useStore((s) => s.progress > 0.4);
  const active = CHANNELS[channel];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <fieldset
      className={"picker" + (revealed ? " picker--in" : "")}
      aria-label="Choose your date and wavelength, then make your print"
    >
      <legend className="visually-hidden">Date, solar wavelength, and purchase</legend>

      {/* the day that mattered — feeds the real Sun image and the deep link */}
      <label className="date-field">
        <span className="date-label">Your date</span>
        <input
          type="date"
          value={date}
          min="2010-05-15"
          max={today}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
      </label>

      {/* live label + load state — the only wavelength cue on touch */}
      <output className="picker-readout" aria-live="polite">
        {active.instrument} · {active.label}
        {status === "loading" && <span className="picker-status"> · developing your Sun…</span>}
        {status === "error" && <span className="picker-status err"> · no image for this date</span>}
      </output>

      <div className="swatches">
        {CHANNELS.map((ch, i) => (
          <label
            key={ch.angstrom}
            className="swatch"
            style={{ ["--tint" as string]: ch.tint }}
            title={`${ch.instrument} ${ch.label}`}
          >
            <input
              type="radio"
              name="wavelength"
              aria-label={`${ch.instrument} ${ch.label}`}
              checked={i === channel}
              onChange={() => setChannel(i)}
              // roving tabindex: one tab stop for the group, arrows move within
              tabIndex={i === channel ? 0 : -1}
            />
            <span className="swatch-dot" aria-hidden="true" />
            <span className="swatch-label">{ch.label}</span>
          </label>
        ))}
      </div>

      {/* commit — visible for mouse from the moment the bar is revealed */}
      <div className="picker-buy">
        <BuyLink className="cta cta--bar">Make one</BuyLink>
        <span className="price-anchor">Prints from $9.99</span>
      </div>
    </fieldset>
  );
}
