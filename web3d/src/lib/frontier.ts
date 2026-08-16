import { useStore, writeFrontierCache } from "../store";
import { API_BASE } from "./handoff";

// Kicks off the archive-frontier fetch the moment this module is IMPORTED:
// App.tsx imports it at the top of its own module, so the request starts
// alongside the lazy Scene chunk instead of a render pass later, in a
// post-mount effect. JSOC's ingest lag drifts (8 days on 2026-08-15), so a
// hardcoded ceiling silently offers dates that cannot be rendered or printed;
// this is the one place that learns the real bounds and applies them via
// setFrontier. On success it also writes the localStorage cache the store
// reads at next load (see store.ts). Failure is silent: the conservative
// static bound already seeded in the store stands; frontierReady still
// flips either way, so texture loaders gated on it (see useSunTextureLoader,
// useWheelTextures) are never left waiting forever on a dead network.
fetch(`${API_BASE}/api/data_frontier`, { signal: AbortSignal.timeout(8000) })
  .then((r) => (r.ok ? r.json() : null))
  .then((f) => {
    if (!f) {
      useStore.setState({ frontierReady: true });
      return;
    }
    const earliest: string | null = f.earliest || null;
    const latest: string | null = f.latest || null;
    useStore.getState().setFrontier(earliest, latest);
    if (earliest && latest) writeFrontierCache(earliest, latest);
  })
  .catch(() => {
    useStore.setState({ frontierReady: true });
  });
