import { Suspense, lazy, useEffect } from "react";
import { useScrollProgress } from "./hooks/useScrollProgress";
import { usePrefersReducedMotion } from "./hooks/usePrefersReducedMotion";
import { useSunTextureLoader } from "./hooks/useSunTextureLoader";
import { warmBackend, API_BASE } from "./lib/handoff";
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

// The heavy Three.js bundle is code-split and streamed behind the loader.
const Scene = lazy(() => import("./three/Scene"));

export default function App() {
  usePrefersReducedMotion();
  useScrollProgress();
  useSunTextureLoader(); // loads the real Sun for the current identity

  // The archive's real frontier. JSOC's ingest lag drifts (8 days on
  // 2026-08-15), so a hardcoded ceiling silently offers dates that cannot be
  // rendered or printed — the store learned this from a beta tester and added
  // /api/data_frontier; this is the experience reading the same source, so the
  // two halves agree on what is buyable. Failure is silent: the conservative
  // static bound already in the store stands.
  const setFrontier = useStore((s) => s.setFrontier);
  useEffect(() => {
    let live = true;
    fetch(`${API_BASE}/api/data_frontier`)
      .then((r) => (r.ok ? r.json() : null))
      .then((f) => {
        if (live && f) setFrontier(f.earliest || null, f.latest || null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [setFrontier]);

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

      {/* Scroll track: gives the film its length. The stage above is fixed. */}
      <div className="scroll-space" aria-hidden="true" />
    </>
  );
}
