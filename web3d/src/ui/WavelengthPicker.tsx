import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";

// Accessible counterpart to the 3D filter wheel. Native radios give free
// arrow-key navigation and screen-reader semantics; state is shared with the
// wheel through the store, so clicking a 3D wedge updates this and vice versa.
export default function WavelengthPicker() {
  const channel = useStore((s) => s.channel);
  const setChannel = useStore((s) => s.setChannel);
  const progress = useStore((s) => s.progress);
  const revealed = progress > 0.4;

  return (
    <fieldset
      className={"picker" + (revealed ? " picker--in" : "")}
      aria-label="Choose a solar wavelength"
    >
      <legend className="visually-hidden">Solar wavelength</legend>
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
            checked={i === channel}
            onChange={() => setChannel(i)}
            tabIndex={revealed ? 0 : -1}
          />
          <span className="swatch-dot" aria-hidden="true" />
          <span className="swatch-label">{ch.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
