import { useStore, dateValid } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { buyUrl, warmBackend } from "../lib/handoff";

// Persistent escape hatch: the 3D experience is the site root, so anyone who
// wants the plain store can jump straight there at any time — identity (the Sun
// they've chosen so far) preserved. Fixed top-right, always visible.
export default function SkipToStore() {
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const channel = useStore((s) => s.channel);
  const look = useStore((s) => s.look);
  const form = useStore((s) => s.form);
  const stars = useStore((s) => s.showStars);
  const con = useStore((s) => s.showConstellations);
  const planets = useStore((s) => s.showPlanets);
  const art = useStore((s) => s.showArt);
  const labels = useStore((s) => s.showLabels);
  const grid = useStore((s) => s.showGrid);
  const valid = useStore(dateValid);
  // Unlike BuyLink, this control never disables: it's the deliberate escape
  // hatch. Without a valid committed date, hand off a BARE store link (no
  // d=/t=, see buyUrl) instead of a disabled control, so it can never carry a
  // wrong date.
  // look/form/sky ride along even when the date is withheld: they are not
  // date-dependent, and without them this exit landed on the store's OWN
  // defaults (stars+constellations+planets on) instead of the film's, so the
  // two ways out of the same untouched film showed two different pictures.
  const href = buyUrl(valid ? date : "", time, CHANNELS[channel].angstrom, {
    look,
    form,
    sky: { stars, con, planets, art, labels, grid },
  });
  return (
    <a className="skip-store" href={href} onPointerEnter={warmBackend}>
      Skip to the store →
    </a>
  );
}
