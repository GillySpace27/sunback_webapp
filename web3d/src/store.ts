import { create } from "zustand";
import type { Texture } from "three";
import { DEFAULT_CHANNEL } from "./data/wavelengths";

export type Quality = "high" | "medium" | "low";
export type TexStatus = "idle" | "loading" | "ready" | "error";

// Stand-in ceiling until /api/data_frontier answers, matching the value the
// store falls back to. JSOC's ingest lag drifts, so this is deliberately
// pessimistic: better to offer one fewer day than to offer a day with no data.
//
// Computed from UTC midnight of "today", not from Date.now() sliced through
// toISOString(): Date.now() is a LOCAL instant, so in any UTC-negative
// timezone an evening rolls it into the next UTC calendar day before the -7d
// subtraction even runs, so "today-7" silently becomes "today-6": exactly
// the 2026-08-09-vs-2026-08-08 mismatch the audit caught. Building the UTC
// midnight explicitly first keeps the whole computation in one calendar.
function utcTodayMinusDays(days: number): string {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(utcMidnight - days * 864e5).toISOString().slice(0, 10);
}
const CONSERVATIVE_LATEST = utcTodayMinusDays(7);

// Last-known frontier, cached across visits so a fresh load doesn't have to
// sit on the static, deliberately-stale CONSERVATIVE_LATEST until
// /api/data_frontier answers again. lib/frontier.ts fetches on module import
// and writes this cache whenever that fetch succeeds; here we only read it,
// once, to seed the store's initial state. A TTL keeps a week-old cache from
// outliving its usefulness (the real frontier drifts day to day).
const FRONTIER_CACHE_KEY = "heliograph.frontier.v1";
const FRONTIER_TTL_SECONDS = 24 * 3600; // ~1 day: about how often the real frontier moves

type FrontierCache = { earliest: string; latest: string; fetchedAt: number; ttlSeconds: number };

function readFrontierCache(): FrontierCache | null {
  try {
    const raw = localStorage.getItem(FRONTIER_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<FrontierCache>;
    if (!c.earliest || !c.latest || !c.fetchedAt || !c.ttlSeconds) return null;
    if (Date.now() - c.fetchedAt > c.ttlSeconds * 1000) return null; // expired
    return c as FrontierCache;
  } catch {
    return null; // localStorage unavailable (private browsing) or corrupt JSON
  }
}

// Called by lib/frontier.ts wherever the live /api/data_frontier fetch
// actually succeeds, so the next visit can seed warm instead of conservative.
export function writeFrontierCache(earliest: string, latest: string) {
  try {
    const c: FrontierCache = { earliest, latest, fetchedAt: Date.now(), ttlSeconds: FRONTIER_TTL_SECONDS };
    localStorage.setItem(FRONTIER_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* private browsing / storage full; the live value still applies this session */
  }
}

const frontierCache = readFrontierCache();
const INITIAL_MIN_DATE = frontierCache?.earliest || "2010-05-15";
const INITIAL_MAX_DATE = frontierCache?.latest || CONSERVATIVE_LATEST;

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
  date: string; // YYYY-MM-DD, or "" when the visitor has cleared the field
  // The only committer: validates before touching state. Commits d when it's
  // non-empty and within [minDate, maxDate]; commits "" when the caller
  // clears the field (so the UI can gate on an explicit "nothing chosen").
  // An out-of-range non-empty d is silently ignored: DateField never sends
  // one, but this stays defensive since setDate is a public store action.
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
  // False until the archive's real bounds are known one way or the other:
  // either lib/frontier.ts's fetch resolved (setFrontier ran) or it failed/
  // timed out (frontierReady is set directly). Texture loaders gate on this
  // so nothing fires a request against the conservative guess and 404s.
  frontierReady: boolean;
  time: string; // HH:MM, currently always "12:00" (no per-day time picker yet)

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
export const useStore = create<State>((set, get) => ({
  progress: 0,
  setProgress: (p) => set({ progress: p }),

  channel: DEFAULT_CHANNEL,
  setChannel: (i) => set({ channel: i, channelChosen: true }),
  channelChosen: false,

  // Seeded from a warm frontier cache when one exists (see readFrontierCache
  // above); otherwise the conservative static fallback, same stand-in the
  // store uses until /api/data_frontier answers. now-3d was inside JSOC's
  // ingest lag, so the pre-filled date was itself unfulfillable.
  date: INITIAL_MAX_DATE,
  setDate: (d) => {
    if (d === "") {
      set({ date: "", dateChosen: true });
      return;
    }
    const { minDate, maxDate } = get();
    if (d < minDate || d > maxDate) return; // out of range: defensive no-op
    set({ date: d, dateChosen: true });
  },
  minDate: INITIAL_MIN_DATE,
  maxDate: INITIAL_MAX_DATE,
  setFrontier: (earliest, latest) =>
    set((s) => {
      const minDate = earliest || s.minDate;
      const maxDate = latest || s.maxDate;
      // Nobody's chosen a date yet, so keep the default TRACKING the frontier
      // exactly rather than merely clamping it from above: a later, laxer
      // answer should pull the default forward too, not leave it pinned to
      // the first (possibly stale) guess. Once chosen, clamp on both ends
      // (a narrower earliest can invalidate a pick just as a lower latest can).
      const date = !s.dateChosen && latest ? latest : clampToRange(s.date, minDate, maxDate);
      return { minDate, maxDate, date, frontierReady: true };
    }),
  dateChosen: false,
  frontierReady: false,
  time: "12:00",

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

// Clamp a date into [min, max] on both ends: setFrontier's own helper, kept
// standalone so the branch above stays readable.
function clampToRange(d: string, min: string, max: string): string {
  if (max && d > max) return max;
  if (min && d < min) return min;
  return d;
}

// Derived, not stored: true when the committed date is non-empty and falls
// within the current [minDate, maxDate] window. Read via `useStore(dateValid)`
// so every CTA gates on one definition instead of re-deriving the check.
export function dateValid(s: State): boolean {
  return s.date !== "" && s.date >= s.minDate && s.date <= s.maxDate;
}

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
