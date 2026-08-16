import { Suspense, lazy, useEffect } from "react";
import { useScrollProgress } from "./hooks/useScrollProgress";
import { usePrefersReducedMotion } from "./hooks/usePrefersReducedMotion";
import { useSunTextureLoader } from "./hooks/useSunTextureLoader";
import { warmBackend } from "./lib/handoff";
// The archive's real frontier. JSOC's ingest lag drifts (8 days on
// 2026-08-15), so a hardcoded ceiling silently offers dates that cannot be
// rendered or printed — the store learned this from a beta tester and added
// /api/data_frontier. The fetch itself now lives in lib/frontier.ts, started
// at MODULE IMPORT (right here) instead of a post-mount effect, so it races
// the lazy Scene chunk below instead of waiting on React's first render to
// even ask for it. Failure is silent: the conservative static bound already
// in the store stands, and frontierReady still flips so gated readers unblock.
import "./lib/frontier";
import { useStore } from "./store";
import ErrorBoundary from "./ui/ErrorBoundary";
import Loader from "./ui/Loader";
import Overlay from "./ui/Overlay";
import AtmosphereFlash from "./ui/AtmosphereFlash";
import HeroDate from "./ui/HeroDate";
import Masthead from "./ui/Masthead";
import DataCredit from "./ui/DataCredit";
import SkipToStore from "./ui/SkipToStore";
import StartOver from "./ui/StartOver";
import Arrows from "./ui/Arrows";
import WavelengthPicker from "./ui/WavelengthPicker";
import { CHANNELS } from "./data/wavelengths";

// The heavy Three.js bundle is code-split and streamed behind the loader.
const Scene = lazy(() => import("./three/Scene"));

// Screen-reader text alternative for the (aria-hidden) WebGL stage that tracks
// the CURRENT selection, not a static description. Subscribes only to date +
// channel, which change on explicit user action, so this re-renders rarely.
function SunAltText() {
  const date = useStore((s) => s.date);
  const channel = useStore((s) => s.channel);
  const ch = CHANNELS[channel];
  const kind = ch.angstrom >= 1600 ? "ultraviolet" : "extreme-ultraviolet";
  return (
    <p>
      Currently showing: the Sun on {date}, observed by NASA’s Solar Dynamics
      Observatory in AIA {ch.label} ({ch.sees.toLowerCase()}), {kind} light
      shown in false colour.
    </p>
  );
}

export default function App() {
  usePrefersReducedMotion();
  useScrollProgress();
  useSunTextureLoader(); // loads the real Sun for the current identity

  // Warm the scale-to-zero backend at idle so its ~20s wake overlaps the heavy
  // chunk download instead of running after it (cuts time-to-real-Sun).
  useEffect(() => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback;
    if (ric) ric(() => warmBackend(), { timeout: 2500 });
    else setTimeout(warmBackend, 800);
  }, []);

  return (
    <>
      <a className="skip" href="#buy">
        Skip to buying options
      </a>

      {/* Crawlable, screen-reader-first content. The 3D is the experience; this
          is the meaning, and it survives with the WebGL removed. */}
      {/* The masthead below is the visible h1 now, so this crawlable block
          drops its duplicate heading and keeps only the prose. */}
      <header className="visually-hidden">
        <p>
          A gift made of light: real NASA/SDO telescope imagery of the Sun on the date that matters
          to you, in the wavelength you choose, printed on the object you love.
        </p>
        <SunAltText />
        <p className="credit">
          Spacecraft model: “Solar Dynamics Observatory” by uperesito, licensed under CC BY.
        </p>
      </header>

      <div className="stage" aria-hidden="true">
        <ErrorBoundary>
          <Suspense fallback={<Loader />}>
            <Scene />
          </Suspense>
        </ErrorBoundary>
      </div>

      {/* display:contents keeps the fixed-position children laid out exactly
          as before; the element exists purely to give the page its main
          landmark (audit finding: no main region was exposed). */}
      <main style={{ display: "contents" }}>
        <Masthead />
        <DataCredit />
        <Overlay />
        <AtmosphereFlash />
        <StartOver />
        <SkipToStore />
        <HeroDate />
        <Arrows />

        <nav id="buy" aria-label="Customize your Heliograph">
          {/* the picker carries the real, visible, screen-reader-announced
              "Make one" CTA (the overlay's is a decorative, aria-hidden twin) */}
          <WavelengthPicker />
        </nav>
      </main>

      {/* Scroll track: gives the film its length. The stage above is fixed. */}
      <div className="scroll-space" aria-hidden="true" />
    </>
  );
}
