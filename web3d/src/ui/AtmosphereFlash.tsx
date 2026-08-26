import { useEffect, useRef } from "react";
import { useStore } from "../store";

// Two bloom masks, each hiding a hard scene transition behind light:
//   1) Descending THROUGH the atmosphere (~0.51): a warm-white bloom peaks as the
//      grown Earth fills the frame, masking the planet->ground swap.
//   2) Crossing INTO the cabin (~0.70): a warm gold bloom (sunlight flooding the
//      window) masks the moment the camera passes through the log wall, so it
//      reads as light pouring in, not the camera clipping through geometry.
export default function AtmosphereFlash() {
  // progress ticks at 60Hz — write the mask's style straight to the DOM from a
  // store subscription instead of routing it through React on every tick.
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const write = (p: number) => {
      const el = ref.current;
      if (!el) return;
      // space -> earth: warm-white, fully opaque plateau so the seam is invisible
      const o1 = Math.max(0, Math.min((p - 0.47) / 0.03, (0.56 - p) / 0.04, 1));
      // outside -> inside the cabin: warm gold sunlight flooding the window.
      //
      // 0.715-0.80, was 0.665-0.75. A transition flash has to live in the GAP
      // between two rest points, and this one sat on top of one: the darkroom
      // beat's stop is 0.69, where the old window was already 89% opaque, so
      // coming to rest on that beat left the frame washed out to near-white
      // cream with the copy floating in a haze (audit in Chrome, 2026-08-26 —
      // I first mis-scoped this as only affecting the space-to-ground flash).
      // The stops on either side are 0.69 (darkroom, at the lit window from
      // outside) and 0.82 (room, just inside it), so the crossing belongs
      // between them and now reads as zero at both.
      const o2 = Math.max(0, Math.min((p - 0.715) / 0.03, (0.80 - p) / 0.035, 0.94));
      if (o1 <= 0.001 && o2 <= 0.001) {
        el.style.visibility = "hidden";
        return;
      }
      el.style.visibility = "visible";
      const cabin = o2 > o1;
      el.style.opacity = String(cabin ? o2 : o1);
      el.style.background = cabin
        ? "radial-gradient(circle at 40% 52%, #fff6de 0%, #ffe3ac 42%, #d79f4a 100%)"
        : "radial-gradient(circle at 50% 42%, #fffaf0 0%, #ffedd2 45%, #cfe0f5 100%)";
    };
    write(useStore.getState().progress);
    return useStore.subscribe((s) => write(s.progress));
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 3,
        pointerEvents: "none",
      }}
    />
  );
}
