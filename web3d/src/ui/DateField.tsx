import { ChangeEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useStore } from "../store";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// The one date-input implementation, extracted once WavelengthPicker's bar and
// HeroDate's opening prompt needed the byte-identical field. Local DRAFT state
// so every keystroke doesn't round-trip through the store, re-synced from the
// COMMITTED date whenever it moves out from under the visitor, most notably a
// frontier clamp landing mid-edit. The store's setDate is the only place that
// actually validates and commits (see store.ts); this component only decides
// WHEN to call it.
export default function DateField({
  labelClassName,
  labelSpanClassName,
  labelText,
  ariaLabel,
}: {
  labelClassName: string;
  labelSpanClassName: string;
  labelText: string;
  ariaLabel?: string;
}) {
  const date = useStore((s) => s.date);
  const setDate = useStore((s) => s.setDate);
  const minDate = useStore((s) => s.minDate);
  const maxDate = useStore((s) => s.maxDate);
  const dateRejectReason = useStore((s) => s.dateRejectReason);
  const clearDateRejectReason = useStore((s) => s.clearDateRejectReason);
  const [draft, setDraft] = useState(date);

  useEffect(() => {
    setDraft(date);
  }, [date]);

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setDraft(v);
    // the visitor is actively correcting the field; whatever explanation was
    // showing (a rejection or a frontier-clamp notice) no longer applies
    clearDateRejectReason();
    // A calendar-picker pick is one gesture with no separate blur: commit as
    // soon as the browser hands back a complete value. setDate validates and
    // sets dateRejectReason (rendered below) for anything outside
    // [minDate, maxDate], leaving it uncommitted in the draft until corrected.
    if (v.length === 10) setDate(v);
  };
  const onBlur = () => setDate(draft); // empty draft commits "" (see setDate)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") setDate(draft);
  };

  return (
    <>
      <label className={labelClassName}>
        <span className={labelSpanClassName}>{labelText}</span>
        <span className="date-input-wrap">
          <input
            type="date"
            value={draft}
            min={minDate}
            max={maxDate}
            onChange={onChange}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            aria-label={ariaLabel}
          />
          {/* The sky-drag's readout, IN the field rather than beside it.
              It was a separate full-screen display, which meant dragging the
              sky spoke through a different control than the one that owns the
              date — two date UIs, one of which you could not type into. This
              covers the native input exactly while a drag is live, so the
              value appears to roll inside the field the visitor already knows,
              and hands straight back to it on release. <input type="date">
              renders its own text natively and cannot be animated, which is
              why this is an overlay and not a restyle. */}
          <DateRollOverlay />
        </span>
      </label>
      {/* why the field didn't take/kept the value it has: reuses the picker's
          existing status-line styling (see WavelengthPicker's "no image for
          this date" line) rather than inventing new markup */}
      {dateRejectReason && (
        <span className="picker-status err" role="status" aria-live="polite">
          {dateRejectReason}
        </span>
      )}
    </>
  );
}

// Rolls the date in place over the native input while a sky-drag is running.
// Imperative: the value changes on pointermove, so a React render per change
// would be a render per frame of the gesture.
function DateRollOverlay() {
  const rootRef = useRef<HTMLSpanElement>(null);
  const dayRef = useRef<HTMLSpanElement>(null);
  const monRef = useRef<HTMLSpanElement>(null);
  const yrRef = useRef<HTMLSpanElement>(null);
  const prev = useRef("");

  useEffect(() => {
    const write = (date: string, dragging: boolean) => {
      const root = rootRef.current;
      if (!root) return;
      root.classList.toggle("is-live", dragging);
      if (!date || date === prev.current) return;
      const up = prev.current !== "" && date > prev.current;
      prev.current = date;
      const [y, m, d] = date.split("-");
      const set = (el: HTMLSpanElement | null, v: string) => {
        if (!el || el.textContent === v) return;
        el.textContent = v;
        el.classList.remove("roll-up", "roll-down");
        void el.offsetWidth; // restart the animation
        el.classList.add(up ? "roll-up" : "roll-down");
      };
      set(dayRef.current, String(Number(d)));
      set(monRef.current, MONTHS[Number(m) - 1] ?? m);
      set(yrRef.current, y);
    };
    const s0 = useStore.getState();
    write(s0.date, s0.dateDragging);
    return useStore.subscribe((s) => write(s.date, s.dateDragging));
  }, []);

  return (
    <span ref={rootRef} className="dateroll" aria-hidden="true">
      <span className="dateroll__win"><span ref={dayRef} className="dateroll__cell" /></span>
      <span className="dateroll__win"><span ref={monRef} className="dateroll__cell" /></span>
      <span className="dateroll__win dateroll__win--yr"><span ref={yrRef} className="dateroll__cell" /></span>
    </span>
  );
}
