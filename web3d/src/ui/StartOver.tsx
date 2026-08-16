import { useEffect, useRef } from "react";
import { useStore } from "../store";

// Sits to the LEFT of "Skip to the store", sharing its bar. The film is a
// one-way scroll: once you are down at the gallery there is no obvious way back
// to the opening except dragging the scrollbar to the top, and the arrow keys
// only step one beat at a time. This returns the visitor to the threshold in
// one action.
//
// It resets the JOURNEY, not the choices — the date and wavelength they picked
// survive, because throwing those away would punish someone who just wanted to
// watch the opening again.
export default function StartOver() {
  const scrollToProgress = useStore((s) => s.scrollToProgress);
  // progress ticks at 60Hz — toggle visibility straight on the DOM from a
  // store subscription instead of re-rendering (or unmounting) through React.
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const write = (progress: number) => {
      const el = ref.current;
      if (!el) return;
      // Nothing to go back to at the very top; showing it there is just clutter.
      el.style.display = progress < 0.02 ? "none" : "";
    };
    write(useStore.getState().progress);
    return useStore.subscribe((s) => write(s.progress));
  }, []);

  return (
    <button
      ref={ref}
      type="button"
      className="start-over"
      onClick={() => scrollToProgress(0)}
      title="Back to the beginning of the journey"
    >
      ↺ Start over
    </button>
  );
}
