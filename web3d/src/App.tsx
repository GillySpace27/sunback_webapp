import { Suspense, lazy, useEffect, useRef } from "react";
import { useScrollProgress } from "./hooks/useScrollProgress";
import { usePrefersReducedMotion } from "./hooks/usePrefersReducedMotion";
import { useSunTextureLoader } from "./hooks/useSunTextureLoader";
import { useRhefTextureLoader } from "./hooks/useRhefTextureLoader";
import { useTimelapseLoader } from "./hooks/useTimelapseLoader";
import { useRainbowLoader } from "./hooks/useRainbowLoader";
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
// Print-master renderer for the Dimensional SKU. Lazy like Scene so the film
// never pays for it.
const PlateScene = lazy(() => import("./three/PlateScene"));

// ?plate=1 renders the print master alone — no film, no chrome, no UI. Read
// once at module scope: this is a rendering mode, not a runtime toggle.
// Time-lapse is OFF unless asked for (?timelapse=1). It is six extra fetches
// per identity and the film has to stay fast for someone who just wants a
// print, so it stays an experiment behind a flag rather than a default.
if (typeof window !== "undefined") {
  const q = new URLSearchParams(window.location.search);
  if (q.get("timelapse") === "1") useStore.getState().setTimelapse(true);
  // Rainbow is three RHEF generations on a cold date, so it is opt-in too.
  if (q.get("rainbow") === "1") useStore.getState().setRainbow(true);
}

const PLATE_MODE =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("plate") === "1";
// Identity from the URL, for the FILM as well as the plate.
//
// The experience generates handoff links carrying d/t/wl but never read them
// back, so a shared link to a specific Sun opened on the default date instead —
// including every link the film itself produces. Applied at module scope, before
// the store's texture loaders run, so nothing fetches the wrong identity first.
if (typeof window !== "undefined") {
  const q = new URLSearchParams(window.location.search);
  const d = q.get("d");
  if (d) useStore.getState().setDate(d);
  const t = q.get("t");
  if (t) useStore.setState({ time: t });
  const wl = q.get("wl");
  if (wl) {
    const i = CHANNELS.findIndex((c) => String(c.angstrom) === wl);
    if (i >= 0) useStore.getState().setChannel(i);
  }
}

// The print-master renderer passes bare=1: a master must be the Sun and nothing
// else, so no chrome may appear in the frame it captures.
const PLATE_BARE =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("bare") === "1";

// The film opens on 171 now (see DEFAULT_CHANNEL), so there is no channel to
// stage. What still has to happen at the aperture beat is asking for the RHEF
// frame: it is a real FITS fetch and filter pass, so it is requested when the
// beat that shows it off comes into view rather than on page load.
const RHEF_REQUEST_AT = 0.2;

function useRhefRequest() {
  const asked = useRef(false);
  useEffect(() => {
    return useStore.subscribe((s) => {
      if (asked.current || s.progress < RHEF_REQUEST_AT) return;
      asked.current = true;
      if (useStore.getState().look === "raw") useStore.getState().setLook("rhef");
    });
  }, []);
}

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
  useRhefTextureLoader(); // and the FITS-derived enhanced frame, when asked for
  useRhefRequest(); // asks for the RHEF frame as its beat comes into view
  useTimelapseLoader(); // opt-in: the day as a sequence of real frames
  useRainbowLoader(); // opt-in: 171/193/211 RHEF composited to RGB

  // Warm the scale-to-zero backend at idle so its ~20s wake overlaps the heavy
  // chunk download instead of running after it (cuts time-to-real-Sun).
  useEffect(() => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback;
    if (ric) ric(() => warmBackend(), { timeout: 2500 });
    else setTimeout(warmBackend, 800);
  }, []);

  // Plate mode returns before any of the film's chrome. The hooks above still
  // run, so the texture loads through the same path the film uses and the
  // plate is rendered from the same frame the visitor was shown.
  if (PLATE_MODE) {
    return (
      <>
        <div className="stage" aria-hidden="true">
          <ErrorBoundary>
            <Suspense fallback={<Loader />}>
              <PlateScene />
            </Suspense>
          </ErrorBoundary>
        </div>
        {/* A way back, or this view is a dead end for anyone who follows the
            link. Suppressed by bare=1, which the print-master renderer passes:
            the master must contain the Sun and nothing else. */}
        {!PLATE_BARE && (
          <a className="plate-back" href={window.location.pathname}>
            ← Back to the film
          </a>
        )}
      </>
    );
  }

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
