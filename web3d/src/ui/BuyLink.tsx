import { CSSProperties, MouseEvent, ReactNode, useState } from "react";
import { useStore } from "../store";
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
  const [preparing, setPreparing] = useState(false);
  const href = buyUrl(date, time, CHANNELS[channel].angstrom, cat ? { cat } : undefined);

  const go = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let new-tab work
    e.preventDefault();
    if (preparing) return;
    setPreparing(true);
    warmBackend();
    // brief hold gives the warm ping a head start, then hand off
    window.setTimeout(() => {
      window.location.href = href;
    }, 700);
  };

  return (
    <a
      className={className}
      href={href}
      style={style}
      tabIndex={decorative ? -1 : undefined}
      aria-hidden={decorative || undefined}
      aria-busy={preparing || undefined}
      onPointerEnter={warmBackend}
      onClick={go}
    >
      {preparing ? "Preparing your Sun…" : children}
    </a>
  );
}
