import { CSSProperties, ReactNode } from "react";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { buyUrl, warmBackend } from "../lib/handoff";

// The purchase CTA: builds the deep link to the original front end with the
// chosen date + wavelength, and warms the backend on buy-intent so the handoff
// lands on a hot origin (product/editor/checkout continue there).
export default function BuyLink({
  className,
  children,
  decorative,
  style,
}: {
  className?: string;
  children: ReactNode;
  decorative?: boolean;
  style?: CSSProperties;
}) {
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const channel = useStore((s) => s.channel);
  const href = buyUrl(date, time, CHANNELS[channel].angstrom);

  return (
    <a
      className={className}
      href={href}
      style={style}
      tabIndex={decorative ? -1 : undefined}
      aria-hidden={decorative || undefined}
      onPointerEnter={warmBackend}
      onPointerDown={warmBackend}
    >
      {children}
    </a>
  );
}
