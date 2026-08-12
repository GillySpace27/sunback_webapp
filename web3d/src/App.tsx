import { Suspense, lazy, useEffect } from "react";
import { useScrollProgress } from "./hooks/useScrollProgress";
import { usePrefersReducedMotion } from "./hooks/usePrefersReducedMotion";
import { useSunTextureLoader } from "./hooks/useSunTextureLoader";
import { warmBackend } from "./lib/handoff";
import ErrorBoundary from "./ui/ErrorBoundary";
import Loader from "./ui/Loader";
import Overlay from "./ui/Overlay";
import Arrows from "./ui/Arrows";
import WavelengthPicker from "./ui/WavelengthPicker";

// The heavy Three.js bundle is code-split and streamed behind the loader.
const Scene = lazy(() => import("./three/Scene"));

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
      <header className="visually-hidden">
        <h1>My Heliograph — your day, written in sunlight</h1>
        <p>
          A gift made of light: the Sun exactly as it burned on the date that matters to you, in the
          wavelength you choose, printed on the object you love.
        </p>
      </header>

      <div className="stage" aria-hidden="true">
        <ErrorBoundary>
          <Suspense fallback={<Loader />}>
            <Scene />
          </Suspense>
        </ErrorBoundary>
      </div>

      <Overlay />
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
