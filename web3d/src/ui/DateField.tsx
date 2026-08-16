import { ChangeEvent, KeyboardEvent, useEffect, useState } from "react";
import { useStore } from "../store";

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
