import { create } from "zustand";
import { DEFAULT_CHANNEL } from "./data/wavelengths";

export type Quality = "high" | "medium" | "low";

type State = {
  // 0..1 scroll progress across the whole film. Single source of truth.
  progress: number;
  setProgress: (p: number) => void;

  // selected wavelength (index into CHANNELS)
  channel: number;
  setChannel: (i: number) => void;

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

  quality: "high",
  setQuality: (q) => set({ quality: q }),

  reducedMotion: false,
  setReducedMotion: (v) => set({ reducedMotion: v }),
}));

// dev-only handle for driving progress in tests (harmless in prod)
if (typeof window !== "undefined") {
  (window as unknown as { __store?: unknown }).__store = useStore;
}

// The seven spaces, as progress thresholds. Used by overlay + camera + effects.
export const SPACES = [
  { key: "threshold", start: 0.0 },
  { key: "surface", start: 0.16 },
  { key: "crossing", start: 0.32 },
  { key: "aperture", start: 0.48 },
  { key: "darkroom", start: 0.66 },
  { key: "room", start: 0.82 },
  { key: "gift", start: 0.94 },
] as const;

export type SpaceKey = (typeof SPACES)[number]["key"];

export function spaceAt(progress: number): SpaceKey {
  let key: SpaceKey = SPACES[0].key;
  for (const s of SPACES) if (progress >= s.start) key = s.key;
  return key;
}
