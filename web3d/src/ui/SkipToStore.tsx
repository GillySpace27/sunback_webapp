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
  const valid = useStore(dateValid);
  // Unlike BuyLink, this control never disables: it's the deliberate escape
  // hatch. Without a valid committed date, hand off a BARE store link (no
  // d=/t=, see buyUrl) instead of a disabled control, so it can never carry a
  // wrong date.
  const href = buyUrl(valid ? date : "", time, CHANNELS[channel].angstrom);
  return (
    <a className="skip-store" href={href} onPointerEnter={warmBackend}>
      Skip to the store →
    </a>
  );
}
