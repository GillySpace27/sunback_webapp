import { Suspense, lazy, useEffect } from "react";
import { useScrollProgress } from "./hooks/useScrollProgress";
import { useDateDrag } from "./hooks/useDateDrag";
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
import BeatRail from "./ui/BeatRail";
import Hud from "./ui/Hud";
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
  // `ch` (channel INDEX) and `look`/`sky` used to be read only by PlateScene,
  // so any link that carried them but not `plate=1` silently opened the film
  // on the default wavelength in the raw look with no sky — which is exactly
  // what the store's "see it dimensional" link did. The store speaks
  // angstroms via `wl`; the plate pipeline speaks indices via `ch`. Both are
  // honoured here, `wl` winning when somehow both are present.
  const ch = q.get("ch");
  if (!wl && ch !== null) {
    const i = Number(ch);
    if (Number.isInteger(i) && i >= 0 && i < CHANNELS.length) useStore.getState().setChannel(i);
  }
  if (q.get("look") === "rhef") useStore.getState().setLook("rhef");
  if (q.get("sky") === "1")
    useStore.setState({ showConstellations: true, showPlanets: true, skyGuideTouched: true });
  // Per-layer overrides, so a caller can specify the sky EXACTLY rather than
  // only through the `sky=1` shorthand above.
  //
  // Added for the store's handoff bridge (Gilly, 2026-08-25: "the handoff page
  // should have the full set of tool toggles to support the dimensional sun
  // offerings"). The Dimensional cells there render this experience in an
  // iframe, so whatever the buyer switches on has to be expressible in the
  // URL — otherwise the bridge can only ever preview one fixed sky, and what
  // they are being asked to buy is not what they configured.
  //
  // Absent means "leave the default alone", NOT "off": `sky=1` and these can
  // be combined, and a link that names only `art=1` should not silently
  // extinguish the stars. Any explicit value also counts as touched, so the
  // film's opening auto-demo does not overwrite it three seconds in.
  {
    const flag = (name: string) => {
      const v = q.get(name);
      return v === null ? null : v === "1" || v === "true";
    };
    const layers: Record<string, boolean> = {};
    const map: [string, string][] = [
      ["stars", "showStars"],
      ["con", "showConstellations"],
      ["planets", "showPlanets"],
      ["art", "showArt"],
      ["labels", "showLabels"],
      ["grid", "showGrid"],
    ];
    for (const [param, key] of map) {
      const v = flag(param);
      if (v !== null) layers[key] = v;
    }
    if (Object.keys(layers).length) useStore.setState({ ...layers, skyGuideTouched: true });
  }
}

// The print-master renderer passes bare=1: a master must be the Sun and nothing
// else, so no chrome may appear in the frame it captures.
const PLATE_BARE =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("bare") === "1";

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
  useDateDrag();    // drag the sky sideways to wind the date
  useSunTextureLoader(); // loads the real Sun for the current identity
  useRhefTextureLoader(); // and the FITS-derived enhanced frame, when asked for
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
        <BeatRail />

        {/* tabIndex -1 so "Skip to buying options" lands focus HERE and the
            next Tab continues inside the HUD. It already did in Chrome, but
            nothing in the markup made a <nav> focusable, so that was the
            browser's fragment-target handling rather than anything this page
            promised. The store's <main> in the same role did NOT take focus
            (measured 2026-09-09), which is what a skip link failing looks
            like. -1 keeps it out of the tab order. */}
        <nav id="buy" tabIndex={-1} aria-label="Customize your Heliograph">
          {/* The HUD carries the film's settings, and — from the climax beat
              onward only — the one real, announced, focusable "Make one". The
              overlay's copy of it is a decorative aria-hidden twin. */}
          <Hud />
        </nav>
      </main>

      {/* Scroll track: gives the film its length. The stage above is fixed. */}
      <div className="scroll-space" aria-hidden="true" />
    </>
  );
}
