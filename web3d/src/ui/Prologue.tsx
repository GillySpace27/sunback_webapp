import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { sunOnScreen } from "../lib/sunOnScreen";

// The cinematic starter (Gilly, 2026-09-29): start on Earth at the occasion,
// name the day, tilt up to the Sun, fly to it, and land on the film's own
// opening frame, where the date is confirmed and can be tuned by dragging.
//
// A DOM overlay on purpose, not part of the 3D scene: it plays while the heavy
// Scene chunk downloads behind it, and it cannot disturb the film's camera,
// scroll or loaders. It ends by fading out over the film's opening Sun, drawn
// here at the same place and size, so the handoff reads as one shot.

type Occasion = { id: string; label: string; line: string; sky: [string, string] };

const OCCASIONS: Occasion[] = [
  { id: "birthday", label: "Birthday", line: "Your birthday.", sky: ["#2a4c8e", "#f4b47c"] },
  { id: "anniversary", label: "Anniversary", line: "Your anniversary.", sky: ["#1f2554", "#ef7d55"] },
  { id: "wedding", label: "Wedding", line: "Your wedding day.", sky: ["#34508c", "#ffd08c"] },
  { id: "graduation", label: "Graduation", line: "Your graduation.", sky: ["#1d5eab", "#a6d4f2"] },
  { id: "arrival", label: "New arrival", line: "The day they arrived.", sky: ["#2b3162", "#f5b9a8"] },
  { id: "memory", label: "In memory", line: "A day to remember them by.", sky: ["#161c3c", "#c98c6c"] },
  { id: "other", label: "Just because", line: "Your special day.", sky: ["#253a78", "#f2c58a"] },
];

// The narration after "Begin". [start ms, phase, caption]. Phases drive CSS.
type Phase = "choose" | "name" | "pan" | "fly" | "arrive";
const SCRIPT: [number, Phase, string][] = [
  [0, "name", "@line"],
  [3200, "pan", "Every photo from that day was lit by one star."],
  [5600, "pan", "And a NASA spacecraft was taking its picture."],
  [8200, "pan", "Let’s go there."],
  [9600, "fly", "Light makes this trip in eight minutes."],
  [12600, "arrive", ""],
];
const END_MS = 13500;

// Skipped when the visitor arrived with a picture already chosen (a shared
// link, the store's handoff, the print renderer) or asked not to see it.
export const PROLOGUE_ENABLED = (() => {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search);
  if (q.get("intro") === "1") return true;
  return !["d", "wl", "ch", "plate", "at"].some((k) => q.has(k)) && q.get("intro") !== "0";
})();

const longDate = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });

const shortDate = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

// A figure in silhouette, feet at (x, y), `h` tall. `raised` lifts one arm.
// `dress` sets the default expression; the visitor can change it per figure
// (Gilly, 2026-11-26): masculine, nonbinary or feminine.
type Expr = "m" | "nb" | "f";
const EXPRS: [Expr, string, string][] = [["m", "M", "masculine"], ["nb", "nB", "nonbinary"], ["f", "F", "feminine"]];
const BODY: Record<Expr, string> = {
  m: "M-13 22Q-14 19-10 19L10 19Q14 19 13 22L16 52Q16 55 13 55L11 55L9 100L2 100L0 62L-2 100L-9 100L-11 55L-13 55Q-16 55-16 52Z",
  nb: "M-12 22Q-13 19-9 19L9 19Q13 19 12 22L18 72L9 72L8 100L2 100L0 76L-2 100L-8 100L-9 72L-18 72Z",
  f: "M-12 22Q-13 19-9 19L9 19Q13 19 12 22L14 50L27 100L-27 100L-14 50Z",
};
const nextExpr = (e: Expr): Expr => (e === "m" ? "nb" : e === "nb" ? "f" : "m");
const exprName = (e: Expr) => EXPRS.find(([v]) => v === e)![2];

type FigureCtx = {
  live: boolean;
  expr: (k: string, d: Expr) => Expr;
  set: (k: string, e: Expr) => void;
  open: (k: string, d: Expr, el: Element) => void;
  close: () => void;
};
const Figures = createContext<FigureCtx | null>(null);

function Person({ k, x, y, h, raised = false, dress = false }: { k: string; x: number; y: number; h: number; raised?: boolean; dress?: boolean }) {
  const ctx = useContext(Figures);
  const d: Expr = dress ? "f" : "m";
  const e = ctx ? ctx.expr(k, d) : d;
  const s = h / 100;
  const live = !!ctx && ctx.live;
  const open = (ev: { currentTarget: Element }) => ctx?.open(k, d, ev.currentTarget);
  return (
    <g
      transform={`translate(${x} ${y - h}) scale(${s})`}
      {...(live && ctx
        ? {
            className: "pro-fig",
            tabIndex: 0,
            role: "button",
            "aria-label": `Figure, ${exprName(e)}. Press Enter to change.`,
            onPointerEnter: open,
            onClick: open,
            onFocus: open,
            onPointerLeave: ctx.close,
            onBlur: ctx.close,
            onKeyDown: (ev: React.KeyboardEvent) => {
              if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ctx.set(k, nextExpr(e)); }
            },
          }
        : {})}
    >
      {live && <rect x="-30" y="-4" width="60" height="106" fill="transparent" pointerEvents="all" />}
      <circle cx="0" cy="9" r="8.5" />
      <path d={BODY[e]} />
      {raised && <path d="M9 21L21-6L26-4L15 27Z" />}
    </g>
  );
}

function Scene({ id }: { id: string }) {
  // Ground line at y=420 of a 1600x500 box; everything important sits in the
  // middle third so a phone's crop (xMidYMax slice) still shows it.
  const ground = <path d="M0 430Q400 395 800 408T1600 420V500H0Z" />;
  switch (id) {
    case "birthday":
      return (
        <g>
          {ground}
          <rect x="690" y="352" width="220" height="10" rx="3" />
          <rect x="705" y="360" width="8" height="52" /><rect x="887" y="360" width="8" height="52" />
          <rect x="755" y="322" width="90" height="30" rx="4" />
          <rect x="770" y="300" width="60" height="24" rx="4" />
          {[782, 800, 818].map((cx) => <rect key={cx} x={cx - 2} y="284" width="4" height="16" />)}
          {[782, 800, 818].map((cx, i) => (
            <ellipse key={cx} className="pro-flame" style={{ animationDelay: `${i * 0.23}s` }} cx={cx} cy="278" rx="4" ry="7" />
          ))}
          {[[640, 190, 36], [610, 240, 30], [960, 210, 34]].map(([cx, cy, r], i) => (
            <g key={i} className="pro-balloon" style={{ animationDelay: `${i * 0.7}s` }}>
              <ellipse cx={cx} cy={cy} rx={r * 0.82} ry={r} />
              <path d={`M${cx} ${cy + r}Q${cx + 12} ${cy + r + 60} ${cx < 800 ? 700 : 900} 352`} fill="none" stroke="currentColor" strokeWidth="2" />
            </g>
          ))}
          <Person k="birthday0" x={640} y={416} h={120} /><Person k="birthday1" x={968} y={414} h={78} raised />
        </g>
      );
    case "anniversary":
      return (
        <g>
          <path d="M0 440Q520 330 800 330T1600 440V500H0Z" />
          <Person k="anniversary0" x={778} y={334} h={118} /><Person k="anniversary1" x={818} y={334} h={108} dress />
          <rect x="784" y="282" width="30" height="6" rx="3" />
        </g>
      );
    case "wedding":
      return (
        <g>
          {ground}
          <path d="M690 412V250A110 110 0 0 1 910 250V412H896V252A96 96 0 0 0 704 252V412Z" />
          {[[700, 260], [735, 175], [800, 146], [865, 175], [900, 260]].map(([cx, cy], i) => (
            <circle key={i} cx={cx} cy={cy} r="15" />
          ))}
          <Person k="wedding0" x={775} y={412} h={124} /><Person k="wedding1" x={825} y={412} h={114} dress />
        </g>
      );
    case "graduation":
      return (
        <g>
          {ground}
          <Person k="graduation0" x={720} y={412} h={116} /><Person k="graduation1" x={800} y={410} h={124} raised /><Person k="graduation2" x={880} y={412} h={112} />
          {[[700, 150, -20], [790, 110, 15], [900, 170, 35], [640, 210, 5]].map(([cx, cy, a], i) => (
            <g key={i} className="pro-cap" style={{ animationDelay: `${i * 0.4}s` }}>
              <g transform={`translate(${cx} ${cy}) rotate(${a})`}>
                <path d="M-26 0L0-11L26 0L0 11Z" /><rect x="-10" y="4" width="20" height="10" rx="2" />
              </g>
            </g>
          ))}
        </g>
      );
    case "arrival":
      return (
        <g>
          {ground}
          <Person k="arrival0" x={720} y={412} h={122} /><Person k="arrival1" x={880} y={412} h={114} dress />
          <path d="M760 360H842Q846 392 818 396H784Q758 392 760 360Z" />
          <path d="M760 360A42 42 0 0 1 804 318V360Z" />
          <path d="M842 360L862 336" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
          <circle cx="780" cy="404" r="9" /><circle cx="824" cy="404" r="9" />
        </g>
      );
    case "memory":
      return (
        <g>
          <path d="M0 438Q600 350 820 360T1600 432V500H0Z" />
          <path d="M852 362L848 250Q846 236 834 222L842 218Q852 232 858 244L870 214L878 218L864 258L866 362Z" />
          {[[850, 190, 58], [800, 210, 44], [900, 214, 46], [826, 160, 40], [880, 162, 38]].map(([cx, cy, r], i) => (
            <circle key={i} cx={cx} cy={cy} r={r} />
          ))}
          <rect x="718" y="350" width="80" height="7" rx="2" /><rect x="718" y="332" width="80" height="6" rx="2" />
          <rect x="724" y="356" width="6" height="16" /><rect x="786" y="356" width="6" height="16" />
        </g>
      );
    default:
      return (
        <g>
          <path d="M0 440Q560 340 800 344T1600 440V500H0Z" />
          <Person k="default0" x={800} y={348} h={118} raised />
        </g>
      );
  }
}

// A fixed field of stars as box-shadows on one element: one node, no canvas.
function useStars(n: number) {
  return useMemo(() => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: n }, () => {
      const a = 0.35 + rnd() * 0.65;
      return `${(rnd() * 200 - 100).toFixed(1)}vmax ${(rnd() * 200 - 100).toFixed(1)}vmax 0 ${rnd() < 0.1 ? 1 : 0}px rgba(255,248,235,${a.toFixed(2)})`;
    }).join(",");
  }, [n]);
}

export default function Prologue({ onDone }: { onDone: () => void }) {
  const minDate = useStore((s) => s.minDate);
  const maxDate = useStore((s) => s.maxDate);
  const [occasion, setOccasion] = useState(OCCASIONS[0]);
  const [date, setDate] = useState(() => useStore.getState().date || maxDate);
  // The archive's real frontier can land after first paint and pull maxDate
  // in under a default the picker already holds; follow it, as the store does.
  // When the typed day is moved, say so (title card and the later date control).
  // The note shows only when the visitor's own typed date was moved, not when
  // the default date follows the frontier before they have touched it.
  const [note, setNote] = useState("");
  const typed = useRef(false);
  useEffect(() => {
    if (date && date > maxDate) {
      setDate(maxDate);
      if (typed.current) setNote(`The observatory’s archive runs about a week behind; the newest Sun we can print is ${shortDate(maxDate)}.`);
    } else if (date && date < minDate) {
      setDate(minDate);
      if (typed.current) setNote(`Our Sun images begin ${shortDate(minDate)}, so we started there.`);
    }
  }, [date, minDate, maxDate]);
  const [phase, setPhase] = useState<Phase>("choose");
  const [caption, setCaption] = useState("");
  const [leaving, setLeaving] = useState(false);
  const timers = useRef<number[]>([]);
  const stars = useStars(260);
  const sunRef = useRef<HTMLDivElement>(null);
  // Per-figure gender expression, chosen from a small menu over each figure
  // while the occasion is being picked.
  const [exprs, setExprs] = useState<Record<string, Expr>>({});
  const [menu, setMenu] = useState<{ k: string; d: Expr; x: number; y: number } | null>(null);
  const closeT = useRef(0);
  const figures = useMemo<FigureCtx>(() => ({
    live: phase === "choose",
    expr: (k, d) => exprs[k] ?? d,
    set: (k, e) => setExprs((p) => ({ ...p, [k]: e })),
    open: (k, d, el) => {
      clearTimeout(closeT.current);
      const r = el.getBoundingClientRect();
      setMenu({ k, d, x: r.left + r.width / 2, y: r.top });
    },
    close: () => { closeT.current = window.setTimeout(() => setMenu(null), 300); },
  }), [phase, exprs]);

  // In flight, steer for wherever the film's Sun actually is, so the fade at
  // the end lands one disc on the other. Set once per phase, not per frame: a
  // retargeted CSS transition restarts, and restarting an ease-in every frame
  // barely moves. Until the 3D has drawn, the CSS falls back to centre.
  useEffect(() => {
    const el = sunRef.current;
    if (!el || (phase !== "fly" && phase !== "arrive") || sunOnScreen.r <= 0) return;
    el.style.setProperty("--sun-x", `${sunOnScreen.x}px`);
    el.style.setProperty("--sun-y", `${sunOnScreen.y}px`);
    el.style.setProperty("--sun-arrive", String((2 * sunOnScreen.r) / el.offsetWidth));
  }, [phase]);

  // Hold the page still while this plays: the film scrolls on the window.
  useEffect(() => {
    const html = document.documentElement;
    const was = html.style.overflow;
    html.style.overflow = "hidden";
    window.scrollTo(0, 0);
    return () => {
      html.style.overflow = was;
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const finish = () => {
    timers.current.forEach(clearTimeout);
    setLeaving(true);
    window.setTimeout(onDone, 900);
  };

  const begin = () => {
    const st = useStore.getState();
    if (date) st.setDate(date);
    if (note) useStore.setState({ dateRejectReason: note });
    SCRIPT.forEach(([at, p, text]) => {
      timers.current.push(window.setTimeout(() => {
        setPhase(p);
        setCaption(text === "@line" ? occasion.line : text);
      }, at));
    });
    timers.current.push(window.setTimeout(finish, END_MS));
  };

  const valid = !!date && date >= minDate && date <= maxDate;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <div
      className="prologue"
      data-phase={phase}
      data-leaving={leaving || undefined}
      style={{ ["--sky-top" as string]: occasion.sky[0], ["--sky-low" as string]: occasion.sky[1] }}
      onPointerDown={stop}
      onWheel={stop}
      onTouchMove={stop}
      role="region"
      aria-label="Introduction"
    >
      <div className="pro-world">
        <svg className="pro-scene" viewBox="0 0 1600 500" preserveAspectRatio="xMidYMax slice" aria-hidden={phase !== "choose" || undefined}>
          <Figures.Provider value={figures}>
            <g key={occasion.id} className="pro-scene-g"><Scene id={occasion.id} /></g>
          </Figures.Provider>
        </svg>
      </div>
      {phase === "choose" && menu && (
        <div
          className="pro-fig-menu"
          role="radiogroup"
          aria-label="Gender expression of this figure"
          style={{ left: menu.x, top: menu.y }}
          onPointerEnter={() => clearTimeout(closeT.current)}
          onPointerLeave={figures.close}
        >
          {EXPRS.map(([v, short, long]) => (
            <button
              key={v}
              type="button"
              role="radio"
              tabIndex={-1}
              aria-checked={(exprs[menu.k] ?? menu.d) === v}
              aria-label={long}
              title={long}
              onClick={() => figures.set(menu.k, v)}
            >
              {short}
            </button>
          ))}
        </div>
      )}
      <div className="pro-space" aria-hidden="true"><div className="pro-stars" style={{ boxShadow: stars }} /></div>
      <div className="pro-sun" ref={sunRef} aria-hidden="true">
        <img src={`${import.meta.env.BASE_URL}sun_171.webp`} alt="" />
      </div>

      <p className="pro-caption" aria-live="polite">
        {caption && <span key={caption}>{caption}</span>}
        {phase === "name" && valid && <span className="pro-date" key={"d" + date}>{longDate(date)}</span>}
        {phase === "name" && valid && note && <span className="pro-note" key="n">{note}</span>}
      </p>

      {phase === "choose" && (
        <div className="pro-picker">
          <p className="pro-q">What are we celebrating?</p>
          <div className="pro-chips" role="radiogroup" aria-label="Occasion">
            {OCCASIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={o.id === occasion.id}
                className="pro-chip"
                onClick={() => setOccasion(o)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="pro-row">
            <label className="pro-when">
              <span>When?</span>
              <input type="date" value={date} min={minDate} max={maxDate} onChange={(e) => { typed.current = true; setNote(""); setDate(e.target.value); }} onKeyDown={stop} />
            </label>
            <button type="button" className="pro-begin" disabled={!valid} onClick={begin}>
              Begin
            </button>
          </div>
          {note && <p className="pro-range pro-note-live" role="status">{note}</p>}
          <p className="pro-range">Any day from {shortDate(minDate)} to {shortDate(maxDate)}. The observatory’s archive runs about a week behind.</p>
        </div>
      )}

      <button type="button" className="pro-skip" onClick={finish}>Skip intro</button>
    </div>
  );
}
