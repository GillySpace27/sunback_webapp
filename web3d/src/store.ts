import { create } from "zustand";
import type { Texture } from "three";
import { DEFAULT_CHANNEL } from "./data/wavelengths";

export type Quality = "high" | "medium" | "low";
export type TexStatus = "idle" | "loading" | "ready" | "error";

type State = {
  // 0..1 scroll progress across the whole film. Single source of truth.
  progress: number;
  setProgress: (p: number) => void;

  // selected wavelength (index into CHANNELS)
  channel: number;
  setChannel: (i: number) => void;

  // the image identity date/time (fed to the Helioviewer texture + deep link)
  date: string; // YYYY-MM-DD
  setDate: (d: string) => void;
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
  setChannel: (i) => set({ channel: i }),

  // default a few days back so a real AIA frame exists (data has some latency)
  date: new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10),
  setDate: (d) => set({ date: d, dateChosen: true }),
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
