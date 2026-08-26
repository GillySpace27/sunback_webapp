import { useEffect } from "react";
import { useStore } from "../store";

// Drag the sky, change the day.
//
// The date already drives the background: pick a date and the starfield rotates
// to the sky that was actually behind the Sun that night. This is that mapping
// run BACKWARDS — grab the sky, pull it sideways, and the date follows your
// hand. It is the same relationship, offered from the other end (Gilly,
// 2026-08-24).
//
// The rate is not arbitrary. The Sun drifts eastward against the stars at very
// nearly 360°/365.25 days ≈ 0.9856°/day, which is exactly why the night sky
// looks different in March than in September. So a drag that moves the sky by
// one degree should move the date by one day, and DAYS_PER_PX below is that
// figure expressed in screen terms for the film's horizontal field of view: a
// ~540px pull works out to roughly two months, which is the granularity the
// gesture is actually for ("changing the month moves the background").
//
// Three guards, because this shares a surface with three other gestures —
// scrolling the film, tapping the Sun for raw/enhanced, tapping the sky for
// constellations:
//
//   ARM     only on the beats where the sky is the backdrop AND the date is
//           still the open question (threshold + surface). Dragging inside the
//           cabin or the gallery would be meaningless.
//   DEADZONE 44px of travel before anything moves, and the gesture must be
//           more horizontal than vertical, so a vertical flick still scrolls.
//   CLAIM   once armed it sets `dateDragging`, which the Sun and sky click
//           handlers check — otherwise every drag would end in an accidental
//           look-toggle or constellation-toggle.
const DEADZONE_PX = 44;
// Trackpads report a two-finger horizontal swipe as wheel deltaX. Same gesture,
// same job, so it winds the date at the same rate as a drag — a desktop
// visitor should not have to discover that this film wants click-and-drag when
// their hardware already has a sideways gesture (Gilly, 2026-08-25).
//
// A wheel notch carries far more delta per unit of intent than a pixel of
// pointer travel, so it gets its own divisor rather than reusing DAYS_PER_PX.
const DAYS_PER_WHEEL_PX = 1 / 22;
// How much sideways delta must accumulate before the first day moves. Lower
// than the pointer deadzone because the gesture is already deliberate — but
// non-zero, or the horizontal jitter in an ordinary vertical scroll would
// nudge the date.
const WHEEL_DEADZONE = 26;
// Idle gap that ends a wheel gesture (there is no "wheel up" event).
//
// 450, was 180. A trackpad does not deliver a steady stream: a two-finger
// swipe arrives in bursts with real gaps between them, and at 180ms a single
// ordinary pause ENDED the gesture and started a new one. Nothing about the
// date scrubbing looked wrong, but every one of those false endings told the
// texture loaders the hand was off, so each burst boundary fired a full round
// of image fetches for whatever intermediate day happened to be showing.
// Measured: a single continuous 45-step scrub produced 16 of them. That is
// the "every third update is an image and it isn't consistent" (Gilly,
// 2026-08-25) — not a debounce that was too short, a gesture that kept
// claiming to be over.
//
// 450ms is longer than the gaps inside a swipe and still well under the pause
// that means someone has actually stopped.
const WHEEL_IDLE_MS = 450;
const DAYS_PER_PX = 1 / 9;
// Drag RIGHT = date forward. Measured, not guessed: rendering the same sky on
// 2017-09-06 and 2017-10-06 puts Jupiter — which drifts only ~2.5°/month
// against the stars, so it stands in for them — at x≈20 and then x≈290 in a
// 900px frame. Advancing the date therefore carries the sky RIGHTWARD, so
// dragging right has to advance the date for the stars to travel WITH the
// hand. The opposite sign renders as an inverted control: you pull one way and
// the sky slides the other.
const SIGN = 1;
const ARM_BELOW_PROGRESS = 0.22;

const DAY_MS = 86400000;
const toISO = (t: number) => new Date(t).toISOString().slice(0, 10);

export function useDateDrag() {
  useEffect(() => {
    let originX = 0;
    let originY = 0;
    let startDate = 0;
    let armed = false;     // pointer is down somewhere draggable
    let engaged = false;   // deadzone cleared; we own this gesture
    let pointerId = -1;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const st = useStore.getState();
      if (st.progress >= ARM_BELOW_PROGRESS) return;
      // Never steal a press that began on a control. The date field, the beat
      // rail, the arrows and the picker all live over the canvas.
      const el = e.target as HTMLElement | null;
      if (el && el.closest("button, a, input, select, textarea, label, [role='group'], .beatrail, .picker-panel"))
        return;
      armed = true;
      engaged = false;
      pointerId = e.pointerId;
      originX = e.clientX;
      originY = e.clientY;
      const d = new Date(st.date + "T00:00:00Z").getTime();
      startDate = Number.isNaN(d) ? Date.now() : d;
    };

    const onMove = (e: PointerEvent) => {
      if (!armed || e.pointerId !== pointerId) return;
      const dx = e.clientX - originX;
      const dy = e.clientY - originY;
      if (!engaged) {
        // Horizontal dominance as well as distance: a diagonal flick that is
        // mostly vertical belongs to the scroller, not to us.
        if (Math.abs(dx) < DEADZONE_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        engaged = true;
        useStore.setState({ dateDragging: true });
      }
      const st = useStore.getState();
      const days = Math.round(dx * DAYS_PER_PX) * SIGN;
      // Clamp OURSELVES rather than letting setDate reject: setDate answers an
      // out-of-range date with an error message, which is right for a typed
      // field and wrong for a drag — pulling past the frontier should simply
      // stop at the edge, the way a physical dial does.
      const wanted = toISO(startDate + days * DAY_MS);
      const clamped = wanted < st.minDate ? st.minDate : wanted > st.maxDate ? st.maxDate : wanted;
      if (clamped !== st.date) st.setDate(clamped);
    };

    const end = () => {
      if (!armed) return;
      armed = false;
      pointerId = -1;
      if (!engaged) return;
      engaged = false;
      // Held one frame past the pointer release. The Sun and sky click
      // handlers fire AFTER pointerup, so clearing this synchronously would
      // let the end of a drag register as a tap on whatever is under the
      // finger — which is exactly the accidental look-toggle this prevents.
      requestAnimationFrame(() => useStore.setState({ dateDragging: false }));
    };

    // ── Horizontal wheel / two-finger swipe ────────────────────────────
    let wheelAccum = 0;
    let wheelBase = 0;
    let wheelActive = false;
    let wheelTimer = 0;

    const endWheel = () => {
      wheelActive = false;
      wheelAccum = 0;
      requestAnimationFrame(() => useStore.setState({ dateDragging: false }));
    };

    const onWheel = (e: WheelEvent) => {
      const st = useStore.getState();
      if (st.progress >= ARM_BELOW_PROGRESS) return;
      // Vertical-dominant events belong to the scroller. The 1.4 factor keeps
      // a slightly-off vertical flick scrolling rather than scrubbing the date.
      if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.4) return;
      if (e.deltaX === 0) return;
      // Ours now: stop the browser using it for horizontal page scroll or a
      // back-navigation swipe. Requires a non-passive listener.
      e.preventDefault();

      if (!wheelActive) {
        wheelActive = true;
        wheelAccum = 0;
        const d = new Date(st.date + "T00:00:00Z").getTime();
        wheelBase = Number.isNaN(d) ? Date.now() : d;
      }
      wheelAccum += e.deltaX;
      clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(endWheel, WHEEL_IDLE_MS);
      if (Math.abs(wheelAccum) < WHEEL_DEADZONE) return;
      if (!st.dateDragging) useStore.setState({ dateDragging: true });

      const days = Math.round(wheelAccum * DAYS_PER_WHEEL_PX) * SIGN;
      const wanted = toISO(wheelBase + days * DAY_MS);
      const clamped = wanted < st.minDate ? st.minDate : wanted > st.maxDate ? st.maxDate : wanted;
      if (clamped !== st.date) st.setDate(clamped);
    };

    window.addEventListener("pointerdown", onDown, { passive: true });
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", end, { passive: true });
    window.addEventListener("pointercancel", end, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("wheel", onWheel);
      clearTimeout(wheelTimer);
    };
  }, []);
}
