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
  setDate: (d) => set({ date: d }),
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
}));

// dev-only handle for driving progress in tests (stripped from prod builds)
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __store?: unknown }).__store = useStore;
}

// The seven spaces, as progress thresholds. Ordered as one outward journey:
// the Sun (hero -> awe -> choose the light), then out across the dark to Earth
// lit by a sunbeam, then down to the surface and into a home where the print
// materializes on the wall. Aperture sits BEFORE the crossing so you aim the
// instrument at the Sun before leaving it.
export const SPACES = [
  { key: "threshold", start: 0.0 },
  { key: "surface", start: 0.13 },
  { key: "aperture", start: 0.28 },
  { key: "crossing", start: 0.45 },
  { key: "darkroom", start: 0.63 },
  { key: "room", start: 0.82 },
  { key: "gift", start: 0.94 },
] as const;

export type SpaceKey = (typeof SPACES)[number]["key"];

export function spaceAt(progress: number): SpaceKey {
  let key: SpaceKey = SPACES[0].key;
  for (const s of SPACES) if (progress >= s.start) key = s.key;
  return key;
}
