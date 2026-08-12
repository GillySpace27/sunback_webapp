import { Suspense, lazy } from "react";
import { useScrollProgress } from "./hooks/useScrollProgress";
import { usePrefersReducedMotion } from "./hooks/usePrefersReducedMotion";
import ErrorBoundary from "./ui/ErrorBoundary";
import Loader from "./ui/Loader";
import Overlay from "./ui/Overlay";
import WavelengthPicker from "./ui/WavelengthPicker";
import BuyLink from "./ui/BuyLink";

// The heavy Three.js bundle is code-split and streamed behind the loader.
const Scene = lazy(() => import("./three/Scene"));

export default function App() {
  usePrefersReducedMotion();
  useScrollProgress();

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

      <nav id="buy" aria-label="Customize your Heliograph">
        <WavelengthPicker />
        {/* the real, screen-reader-announced purchase control (the overlay's
            "Make one" is decorative and aria-hidden); deep-links to the original
            front end with the chosen date + wavelength and warms the backend */}
        <BuyLink className="cta cta--buy">Make one</BuyLink>
      </nav>

      {/* Scroll track: gives the film its length. The stage above is fixed. */}
      <div className="scroll-space" aria-hidden="true" />
    </>
  );
}
