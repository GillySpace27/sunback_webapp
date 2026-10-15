import { useStore, dateValid } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { buyUrl, warmBackend } from "../lib/handoff";

// MH-18: shown only when the visitor arrived from the store's "See it on your
// wall" (?p=<product id>). Returns to the store with the same Sun and the same
// product selected. The store ignores a p it does not know, so a stale id
// falls back to the plain store.
export default function BackToOrder() {
  const productId = useStore((s) => s.productId);
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const channel = useStore((s) => s.channel);
  const look = useStore((s) => s.look);
  const form = useStore((s) => s.form);
  const valid = useStore(dateValid);
  if (!productId) return null;
  const href = buyUrl(valid ? date : "", time, CHANNELS[channel].angstrom, { look, form, p: productId });
  return (
    <a className="back-to-order" href={href} onPointerEnter={warmBackend}>
      &larr; Back to my order
    </a>
  );
}
