import { CSSProperties, MouseEvent, ReactNode, useState } from "react";
import { useStore, dateValid } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { buyUrl, warmBackend } from "../lib/handoff";

// The purchase CTA: builds the deep link to the original front end with the
// chosen date + wavelength, warms the backend on intent, and shows a short
// "Preparing your Sun…" handoff state before navigating so the buyer isn't
// dropped onto a cold (scale-to-zero) destination with no feedback — critical
// on touch, where there's no hover to warm ahead of the click.
export default function BuyLink({
  className,
  children,
  decorative,
  style,
  cat,
}: {
  className?: string;
  children: ReactNode;
  decorative?: boolean;
  style?: CSSProperties;
  cat?: string; // optional product-category anchor (from a gallery piece)
}) {
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const channel = useStore((s) => s.channel);
  const valid = useStore(dateValid);
  const [preparing, setPreparing] = useState(false);
  // No committed date to sell (cleared field, or the frontier clamp just
  // invalidated the last pick): this CTA has no honest destination, so it
  // renders inert rather than promising a Sun it can't deliver. SkipToStore
  // stays live either way; it's the deliberate escape hatch (see its comment).
  const href = valid ? buyUrl(date, time, CHANNELS[channel].angstrom, cat ? { cat } : undefined) : undefined;

  const go = (e: MouseEvent) => {
    if (!valid) return; // no href, nothing for this click to do
    if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let new-tab work
    e.preventDefault();
    if (preparing) return;
    setPreparing(true);
    warmBackend();
    // brief hold gives the warm ping a head start, then hand off. Read FRESH
    // state at fire time rather than this render's closed-over date/time/
    // channel, so a frontier clamp landing during the 700ms hold can't send a
    // now-superseded date.
    window.setTimeout(() => {
      const s = useStore.getState();
      if (!dateValid(s)) return; // went invalid mid-hold, nothing honest to send
      window.location.href = buyUrl(s.date, s.time, CHANNELS[s.channel].angstrom, cat ? { cat } : undefined);
    }, 700);
  };

  return (
    <a
      className={[className, valid ? null : "cta--disabled"].filter(Boolean).join(" ")}
      href={href}
      style={style}
      tabIndex={decorative ? -1 : valid ? undefined : -1}
      aria-hidden={decorative || undefined}
      aria-disabled={valid ? undefined : "true"}
      aria-busy={preparing || undefined}
      onPointerEnter={valid ? warmBackend : undefined}
      onClick={go}
    >
      {preparing ? "Preparing your Sun…" : children}
    </a>
  );
}
