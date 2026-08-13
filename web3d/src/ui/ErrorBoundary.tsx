import { Component, ReactNode } from "react";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { buyUrl } from "../lib/handoff";

// Graceful fallback if WebGL is unavailable or a scene error escapes. Never
// leaves the visitor on a black void — routes them to the live store WITH the
// chosen Sun preserved (the 3D page is now the root, so a bare link would loop).
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    // eslint-disable-next-line no-console
    console.error("[web3d] scene error:", err);
  }
  render() {
    if (this.state.failed) {
      const s = useStore.getState();
      const href = buyUrl(s.date, s.time, CHANNELS[s.channel].angstrom);
      return (
        <div className="fallback" role="alert">
          <h1>My Heliograph</h1>
          <p>Your day, written in sunlight.</p>
          <p className="muted">This device could not start the 3D experience.</p>
          <a className="cta" href={href}>
            Visit the shop
          </a>
        </div>
      );
    }
    return this.props.children;
  }
}
