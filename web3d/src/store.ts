import { create } from "zustand";
import type { Texture } from "three";
import { DEFAULT_CHANNEL } from "./data/wavelengths";

export type Quality = "high" | "medium" | "low";
export type TexStatus = "idle" | "loading" | "ready" | "error";

// Stand-in ceiling until /api/data_frontier answers, matching the value the
// store falls back to. JSOC's ingest lag drifts, so this is deliberately
// pessimistic: better to offer one fewer day than to offer a day with no data.
const CONSERVATIVE_LATEST = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

type State = {
  // 0..1 scroll progress across the whole film. Single source of truth.
  progress: number;
  setProgress: (p: number) => void;

  // selected wavelength (index into CHANNELS)
  channel: number;
  setChannel: (i: number) => void;
  // has the visitor explicitly picked a wavelength yet? drives the "keep
  // scrolling to continue" nudge once they've made a first choice
  channelChosen: boolean;

  // the image identity date/time (fed to the Helioviewer texture + deep link)
  date: string; // YYYY-MM-DD
  setDate: (d: string) => void;
  // Selectable range. The store already tracks the archive's real frontier via
  // /api/data_frontier because JSOC's ingest lag drifts (7 days measured
  // 2026-08-09, 8 days on 2026-08-15) and a hardcoded guess once let a beta
  // tester pick a date with no data. The experience used `today` as its
  // ceiling and now-3d as its default, so it was handing the store dates the
  // store cannot fulfil — including, by default, on every fresh visit.
  minDate: string;
  maxDate: string;
  // Applies the real frontier and pulls the selection back inside it.
  setFrontier: (earliest: string | null, latest: string | null) => void;
  // has the visitor explicitly picked a date yet? drives the soft "nudge"
  // (pulsing prompt/arrow) on the opening beat until they do
  dateChosen: boolean;
  time: string; // HH:MM
  setTime: (t: string) => void;

  // the real SDO/AIA texture for the CURRENT identity (null => procedural
  // fallback); status drives loading/error affordances. Never show a stale
  // texture for a different date — the loader nulls it on identity change.
  currentTexture: Texture | null;
  setTexture: (t: Texture | null) => void;
  texStatus: TexStatus;
  setTexStatus: (s: TexStatus) => void;

  // adaptive quality tier, driven by PerformanceMonitor
  quality: Quality;
  setQuality: (q: Quality) => void;

  reducedMotion: boolean;
  setReducedMotion: (v: boolean) => void;

  // programmatic scroll (wired to Lenis) so the timeline arrows can jump beats
  scrollToProgress: (p: number) => void;
  setScrollToProgress: (fn: (p: number) => void) => void;
};

// ponytail: refs/useFrame read these; components subscribe only where a
// re-render is actually wanted (UI overlays), not in the render loop.
export const useStore = create<State>((set) => ({
  progress: 0,
  setProgress: (p) => set({ progress: p }),

  channel: DEFAULT_CHANNEL,
  setChannel: (i) => set({ channel: i, channelChosen: true }),
  channelChosen: false,

  // Default to the conservative static frontier (today-7), the same stand-in
  // the store uses until /api/data_frontier answers. now-3d was inside JSOC's
  // ingest lag, so the pre-filled date was itself unfulfillable.
  date: CONSERVATIVE_LATEST,
  setDate: (d) => set({ date: d, dateChosen: true }),
  minDate: "2010-05-15",
  maxDate: CONSERVATIVE_LATEST,
  setFrontier: (earliest, latest) =>
    set((s) => ({
      minDate: earliest || s.minDate,
      maxDate: latest || s.maxDate,
      // A date past the frontier cannot be rendered or printed, so clamp it
      // rather than letting the handoff carry it. dateChosen is left alone:
      // the visitor still chose, we just could not honour that exact day.
      date: latest && s.date > latest ? latest : s.date,
    })),
  dateChosen: false,
  time: "12:00",
  setTime: (t) => set({ time: t }),

  currentTexture: null,
  setTexture: (t) => set({ currentTexture: t }),
  texStatus: "idle",
  setTexStatus: (s) => set({ texStatus: s }),

  quality: "high",
  setQuality: (q) => set({ quality: q }),

  reducedMotion: false,
  setReducedMotion: (v) => set({ reducedMotion: v }),

  scrollToProgress: () => {},
  setScrollToProgress: (fn) => set({ scrollToProgress: fn }),
}));

// Center progress of each space — where its copy peaks; the arrows jump here.
export function spaceCenters(): number[] {
  return SPACES.map((s, i) => {
    const end = i + 1 < SPACES.length ? SPACES[i + 1].start : 1;
    return (s.start + end) / 2;
  });
}

// The best-framed moment of each of the nine beats, in order. The timeline arrows
// step through THESE (not the geometric slice centers) so the whole film — every
// beat at its intended composition — is reachable scroll-free. Keep in sync with
// the camera dwell + copy peaks (aperture peaks at its start, Earth after it slides
// in, the print once materialized, etc.).
export const BEAT_STOPS = [0.02, 0.16, 0.235, 0.45, 0.585, 0.69, 0.82, 0.885, 0.965];

// dev-only handle for driving progress in tests (stripped from prod builds)
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __store?: unknown }).__store = useStore;
}

// The eight spaces, as progress thresholds. Ordered as one journey home: the
// Sun (hero -> awe -> choose the light), then out across the dark to Earth lit
// by a sunbeam, then DOWN to the surface (the same star, from your own backyard
// sky), then in backwards through a window to the home where the print
// materializes on the wall. Aperture sits BEFORE the crossing so you aim the
// instrument at the Sun before leaving it. The crossing dwells long so the
// god-ray reaching Earth gets a beat to breathe before you land.
export const SPACES = [
  { key: "threshold", start: 0.0 },
  { key: "surface", start: 0.1 },
  { key: "aperture", start: 0.22 },
  { key: "crossing", start: 0.37 },
  { key: "sky", start: 0.53 },
  { key: "darkroom", start: 0.64 },
  { key: "room", start: 0.74 },
  { key: "gift", start: 0.84 },
  // pan right from the wall print to a small gallery of products, all bearing
  // the same Sun — the "make one on anything" beat
  { key: "gallery", start: 0.93 },
] as const;

export type SpaceKey = (typeof SPACES)[number]["key"];

export function spaceAt(progress: number): SpaceKey {
  let key: SpaceKey = SPACES[0].key;
  for (const s of SPACES) if (progress >= s.start) key = s.key;
  return key;
}
