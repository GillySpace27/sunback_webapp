import { useEffect } from "react";
import { useStore } from "../store";

// Reflect the OS "reduce motion" setting into the store, live.
export function usePrefersReducedMotion() {
  const setReducedMotion = useStore((s) => s.setReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [setReducedMotion]);
}
