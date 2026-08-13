// MOLTEN RECORD — the store's motion engine.
//
// Concept: "the light stays liquid until it's yours." The 2D store is meant to
// belong to the same universe as the 3D experience at /experience/, which is
// Lenis-smoothed and continuously in motion. This module owns the scroll
// engine, the device tiering, and the single control surface every effect
// reads from. The choreography itself lives in later phases.
//
// ── Two rules this whole file is built around ──────────────────────────
//
// 1. PROGRESSIVE ENHANCEMENT IS MANDATORY. The store is complete and correct
//    with none of this loaded — phase 1 is pure CSS and stands on its own. So
//    the libraries are pulled in with a DYNAMIC import inside a try/catch: if
//    /asset/vendor/ is missing, the network fails, or the browser chokes, the
//    page keeps working and simply never upgrades. A static import at the top
//    of solar-archive.js would take the entire store down with it, which is an
//    unacceptable trade for decoration.
//
// 2. SCRUB IS THE VISCOSITY PARAMETER. The cooling gradient from the design
//    work is not a metaphor in the code, it is `scrubMul` decreasing down the
//    funnel. Thick and laggy at the hero, thin and instant at checkout.
//
// Everything is namespaced through `motionState` so pools, tiering, and the
// reduced-motion kill switch all write to one object instead of reaching into
// each other's internals.

const VENDOR = "/asset/vendor/";

// Query state is snapshotted at MODULE EVALUATION, which happens before
// solar-archive.js's body runs and therefore before the app writes its own
// state back into the address bar. This matters: _syncUrlParams pushes
// `?p=…&d=…&wl=…` for essentially every visitor, so reading location.search
// later would classify everyone as a 3D handoff arrival and quietly drop the
// whole site to a reduced tier. Verified against a cold load, which rewrote to
// `?p=poster_matte&d=2014-10-24&wl=193` within a second.
const QUERY_AT_LOAD = (() => {
  try {
    return new URLSearchParams(location.search);
  } catch (e) {
    return new URLSearchParams("");
  }
})();

// ── The control surface ────────────────────────────────────────────────
// Read by every effect; written by tiering, stillness pools, and the kill
// switch. `amp` is mirrored onto the document as --motion-amp so the CSS-only
// phase-1 ambience (field convection) damps in step with the JS-driven layers
// without needing to know anything about them.
export const motionState = {
  amp: 1, // ambient amplitude: field convection, breathing
  velGain: 1, // scroll-velocity response gain
  scrubMul: 1, // multiplier applied to every ScrollTrigger scrub value
  tier: 0, // 0 full … 3 static
  ready: false, // libraries loaded and wired
};

// Library handles. Null until (and unless) init succeeds.
export let gsap = null;
export let ScrollTrigger = null;
let lenis = null;

// ── Kill switch ────────────────────────────────────────────────────────
// One auto-detected path to Tier 3. `?fast=1` alone is unreachable in
// practice: nobody types it and a bookmarked return visit never carries it, so
// the signals that actually occur in the wild have to be detected here.
//
// Deliberately NOT included: a "has visited before" flag. It was in the plan,
// but a return visit is a weak proxy for buy-intent, and keying off it would
// mean anyone who came back to browse a second time is permanently locked out
// of the design. Once-per-session entrance gating already covers the real
// complaint (do not replay the show), and it does so without lying about what
// the visitor wants.
export function staticModeRequested() {
  if (QUERY_AT_LOAD.get("fast") === "1") return true;
  try {
    // A published accessibility promise, not a courtesy: legal/accessibility.html
    // states that scroll animations short-circuit under the OS preference.
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
  } catch (e) {
    /* no matchMedia: fall through to the other signals */
  }
  try {
    const c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ""))) return true;
  } catch (e) {
    /* Network Information API is not universal */
  }
  return false;
}

// Arriving from the 3D experience with an identity already chosen. These
// visitors have just spent eight minutes being sold to and are here to buy, so
// they get a calmer, faster store — but NOT a dead one (Tier 1, not Tier 3).
// Killing the field outright would make the two halves feel like different
// sites again, which is the exact problem this project exists to fix.
export function isHandoffArrival() {
  // `t` (time) is the discriminator. The store writes back `d` and `wl` on its
  // own, but only buyUrl() in the 3D experience emits all three together, so
  // requiring `t` is what separates a real handoff from the app's own URL sync.
  return QUERY_AT_LOAD.has("d") && QUERY_AT_LOAD.has("wl") && QUERY_AT_LOAD.has("t");
}

// ── Tier definitions ───────────────────────────────────────────────────
const TIERS = [
  { amp: 1.0, velGain: 1.0, scrubMul: 1.0 }, // 0 full
  { amp: 0.6, velGain: 0.6, scrubMul: 1.0 }, // 1 reduced
  { amp: 0.0, velGain: 0.0, scrubMul: 0.0 }, // 2 minimal: entrances only
  { amp: 0.0, velGain: 0.0, scrubMul: 0.0 }, // 3 static: nothing runs at all
];

export function setTier(n) {
  const t = Math.max(0, Math.min(3, n | 0));
  motionState.tier = t;
  Object.assign(motionState, TIERS[t]);
  applyState();
  try {
    document.documentElement.setAttribute("data-motion-tier", String(t));
  } catch (e) {
    /* attribute is for CSS hooks + debugging only */
  }
}

// Mirror the ambient amplitude into CSS so phase-1's convection damps with
// everything else. One property write per change, not per frame.
export function applyState() {
  try {
    document.documentElement.style.setProperty("--motion-amp", String(motionState.amp));
  } catch (e) {
    /* non-fatal */
  }
}

// ── Frame-rate probe ───────────────────────────────────────────────────
// Measure, do not guess. hardwareConcurrency and deviceMemory are hints about
// the CPU and say nothing about the GPU or thermal state: a cheap phone can
// report eight cores and still composite badly. Watch real frames instead.
function probeFrameRate(ms, done) {
  let frames = 0;
  const t0 = performance.now();
  (function tick() {
    frames++;
    const dt = performance.now() - t0;
    if (dt < ms) requestAnimationFrame(tick);
    else done(frames / (dt / 1000));
  })();
}

// Adaptive degradation with hysteresis: drop on sustained poor frame rate and
// never climb back within the session. Bidirectional switching makes the page
// visibly oscillate between treatments, which reads as broken — worse than
// simply running one tier lower than ideal.
function watchFrameRate() {
  let frames = 0;
  let windowStart = performance.now();
  gsap.ticker.add(() => {
    frames++;
    const dt = performance.now() - windowStart;
    if (dt < 3000) return;
    const fps = frames / (dt / 1000);
    frames = 0;
    windowStart = performance.now();
    if (fps < 45 && motionState.tier < 2) setTier(motionState.tier + 1);
  });
}

// ── Scroll helpers ─────────────────────────────────────────────────────
// These are safe to call at ANY time, including before init() resolves or
// after it has failed. solar-archive.js routes its scrolling through here so
// there is exactly one place that knows whether Lenis owns the scroll.
//
// This matters more than it looks: once Lenis is driving, a native
// window.scrollTo or scrollIntoView({behavior:"smooth"}) is a second animator
// fighting the first for the same scrollTop, which produces stutter and
// overshoot rather than a clean jump.
export function scrollToTarget(target, opts) {
  const o = opts || {};
  const offset = o.offset || 0;
  const immediate = !!o.immediate;
  if (lenis) {
    // Resolve elements to an ABSOLUTE position from the DOM rather than
    // handing Lenis the node. Lenis computes an element target from its own
    // internal animatedScroll, which desyncs from the real scrollY whenever
    // the page reflows underneath it — and this app reflows hard on every step
    // change, because whole sections are display:none'd. Measured symptom:
    // returning from the editor to the product step landed 102px short, every
    // time. Measuring here removes Lenis's bookkeeping from the equation.
    let dest = target;
    if (typeof target !== "number") {
      try {
        const el = typeof target === "string" ? document.querySelector(target) : target;
        if (!el) return false;
        dest = (window.scrollY || 0) + el.getBoundingClientRect().top;
      } catch (e) {
        return false;
      }
    }
    // The document height changes on step transitions; without this Lenis can
    // clamp to a stale limit.
    try {
      lenis.resize();
    } catch (e) {
      /* older builds may not expose resize() */
    }
    lenis.scrollTo(Math.max(0, dest + offset), {
      immediate,
      // A programmatic jump must win even if a pool has locked user scrolling.
      force: true,
      onComplete: o.onComplete,
    });
    return true;
  }
  // Native fallback — identical destination, no smoothing.
  try {
    let top = 0;
    if (typeof target === "number") {
      top = target;
    } else {
      const el = typeof target === "string" ? document.querySelector(target) : target;
      if (!el) return false;
      top = (window.scrollY || 0) + el.getBoundingClientRect().top;
    }
    window.scrollTo({ top: Math.max(0, top + offset), behavior: immediate ? "auto" : "auto" });
    if (o.onComplete) o.onComplete();
    return true;
  } catch (e) {
    return false;
  }
}

export function stopScroll() {
  if (lenis) lenis.stop();
}
export function startScroll() {
  if (lenis) lenis.start();
}

// ── Trigger refresh ────────────────────────────────────────────────────
// The store is a stepped wizard: body.step-* classes show and hide whole
// sections, which invalidates every measured ScrollTrigger start/end on the
// page. Without this, trigger points silently go stale the first time someone
// advances a step and every subsequent animation fires at the wrong scroll
// position.
//
// Deferred to the next frame on purpose — calling refresh() synchronously with
// the class swap measures the layout that is on its way out.
let refreshQueued = false;
export function refreshTriggers() {
  if (!ScrollTrigger || refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      refreshQueued = false;
      try {
        ScrollTrigger.refresh();
      } catch (e) {
        /* a failed refresh must never break navigation */
      }
    });
  });
}

// ── Init ───────────────────────────────────────────────────────────────
let initPromise = null;

export function initMotion() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (staticModeRequested()) {
      setTier(3);
      return false; // nothing loads; phase-1 CSS is the whole experience
    }

    // Declared out here on purpose: the try block below is a separate scope,
    // and Lenis is constructed after it.
    let Lenis = null;
    try {
      // Dynamic + parallel. Import specifiers are root-absolute so they
      // resolve identically from the store root and from any nested path.
      const [gsapMod, stMod, easeMod, lenisMod] = await Promise.all([
        import(`${VENDOR}index.js`),
        import(`${VENDOR}ScrollTrigger.js`),
        import(`${VENDOR}CustomEase.js`),
        import(`${VENDOR}lenis.mjs`),
      ]);
      gsap = gsapMod.gsap || gsapMod.default;
      ScrollTrigger = stMod.ScrollTrigger || stMod.default;
      const CustomEase = easeMod.CustomEase || easeMod.default;
      Lenis = lenisMod.default;
      if (!gsap || !ScrollTrigger || !Lenis) throw new Error("vendor module shape unexpected");
      gsap.registerPlugin(ScrollTrigger, CustomEase);

      // ── The ease vocabulary ──
      // Only `crest` is allowed past 1.0, and only to 1.04. Nothing springier:
      // overshoot that oscillates reads as rubber, and rubber is not plasma.
      CustomEase.create("pour", "M0,0 C0.76,0 0.24,1 1,1");
      CustomEase.create("surface", "M0,0 C0.22,1 0.36,1 1,1");
      CustomEase.create("settle", "M0,0 C0.33,1 0.68,1 1,1");
      CustomEase.create("drain", "M0,0 C0.7,0 0.84,0 1,1");
      CustomEase.create("crest", "M0,0 C0.18,0.9 0.3,1.04 1,1");
    } catch (e) {
      // Vendor missing or broken: stay on the phase-1 experience forever.
      setTier(3);
      return false;
    }

    // ── Lenis ──
    // syncTouch stays OFF (its default). Native touch momentum is already
    // excellent and Lenis competing with it reads as input lag on exactly the
    // devices least able to afford it.
    lenis = new Lenis({
      duration: 1.05,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
    });
    lenis.on("scroll", ScrollTrigger.update);
    // Lenis is driven by GSAP's ticker rather than its own rAF so the two
    // never disagree about frame timing. GSAP's time is seconds, Lenis wants ms.
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    // lagSmoothing lets GSAP silently skip time after a long frame, which
    // desynchronises it from Lenis and shows up as a scroll jump.
    gsap.ticker.lagSmoothing(0);

    // NOTE: deliberately NOT calling ScrollTrigger.normalizeScroll(). It takes
    // over the scroll container, which is precisely what Lenis is already
    // doing; running both means two libraries fighting for one scrollTop.

    motionState.ready = true;

    // Establish the starting tier, then keep watching.
    if (isHandoffArrival()) setTier(1);
    else setTier(0);

    // Build immediately rather than waiting on the 1.8s probe. Waiting would
    // leave the first stretch of the page with no choreography at all, and any
    // section the visitor scrolled past in the meantime would then fire its
    // entrance late. The probe exists to catch sustained trouble and downgrade
    // afterwards; velocity and ambient read motionState live, so they correct
    // themselves the moment it does.
    initChoreography();

    probeFrameRate(1800, (fps) => {
      if (fps < 30) setTier(3);
      else if (fps < 45) setTier(2);
      else if (fps < 55) setTier(Math.max(motionState.tier, 1));
      watchFrameRate();
    });

    return true;
  })();
  return initPromise;
}

// ── Phase 3: scroll choreography ───────────────────────────────────────
//
// Layering rule that keeps these from fighting each other: PASS animates the
// `.flow-inner` WRAPPER, SURFACE animates its CHILDREN. Both want yPercent and
// scale, so putting them on the same element would mean two tweens tearing at
// the same matrix. Splitting by depth also reads better — the block drifts as
// one mass while its contents surface individually.

// Per-section drift as it traverses the viewport. Content flows past a fixed
// camera; depth comes from scale and brightness rather than from movement
// alone. Never applied to `.section` itself (containing-block trap, T1) and
// never to a section marked data-still.
function buildPass() {
  const s = scrub(0.6);
  if (!s) return; // tier 2+: no continuous scroll-linked motion at all
  document.querySelectorAll(".section:not([data-still]) > .flow-inner").forEach((inner) => {
    const section = inner.parentElement;
    gsap
      .timeline({
        scrollTrigger: { trigger: section, start: "top bottom", end: "bottom top", scrub: s },
      })
      // ease:"none" is mandatory on a scrubbed tween. Scroll IS the timeline,
      // so easing it warps the scroll-to-progress mapping and reads as input
      // lag; all the liquidity comes from the scrub seconds value instead.
      .fromTo(
        inner,
        { yPercent: 13, scale: 0.965 },
        { yPercent: 0, scale: 1, ease: "none" }
      )
      .to(inner, { yPercent: -13, scale: 0.965, ease: "none" });
  });
}

// Elements rise through a waterline. The desync IS the effect: clarity lands
// at ~0.55s while position keeps settling to 0.9s, so the thing is readable
// before it has finished arriving.
function buildSurface(skipSet) {
  const targets = [];
  document.querySelectorAll(".flow-inner").forEach((fi) => {
    for (const child of fi.children) {
      // Anything an inscription already owns is skipped: running both would
      // fade the block in while its own characters were separately igniting.
      if (skipSet && skipSet.has(child)) continue;
      targets.push(child);
    }
  });
  if (!targets.length) return;

  const instant = motionState.tier >= 3;
  const fold = window.innerHeight * 0.85;
  targets.forEach((el) => {
    // Skip anything already on screen. Choreography is built on an idle
    // callback, several hundred ms after paint, so attaching a fromTo to
    // visible content would snap it to opacity 0 and replay it — a flash of
    // the page undoing itself. Above-fold elements already arrived via the
    // phase-1 CSS pour and need no help.
    try {
      if (el.getBoundingClientRect().top < fold) return;
    } catch (e) {
      return;
    }
    // P6: blur is the one expensive property here, so it is spent only where
    // it is cheap and visible — small elements, top tier only. Blurring a
    // section-sized block forces a re-raster proportional to its area.
    let box = 0;
    try {
      box = el.getBoundingClientRect().height;
    } catch (e) {
      box = 0;
    }
    const mayBlur = motionState.tier === 0 && box > 0 && box < window.innerHeight * 0.4;

    // immediateRender:false on every fromTo here, for the same reason as the
    // inscriptions: otherwise the "from" state is stamped on at BUILD time, and
    // anything whose trigger never fires — a section hidden by a step change
    // before it scrolled into view — stays at opacity 0 permanently. An
    // animation must never be able to leave content invisible.
    const from = { opacity: 0, yPercent: 26, scale: 0.945 };
    const to = {
      opacity: 1,
      duration: instant ? 0.12 : 0.4,
      ease: "surface",
      immediateRender: false,
    };
    const tl = gsap.timeline({
      scrollTrigger: { trigger: el, start: "top 85%", once: true },
    });
    tl.fromTo(el, from, to, 0);
    if (mayBlur && !instant) {
      tl.fromTo(
        el,
        { filter: "blur(4px) saturate(0.75) brightness(0.75)" },
        { filter: "blur(0px) saturate(1) brightness(1)", duration: 0.55, ease: "surface",
          immediateRender: false },
        0
      );
    }
    tl.fromTo(
      el,
      { yPercent: from.yPercent, scale: from.scale },
      { yPercent: 0, scale: 1, duration: instant ? 0.12 : 0.9, ease: "crest",
        immediateRender: false },
      0
    );
  });
}

// The page cools as you descend: corona gold at the hero, cool blue by
// checkout. Implemented as ONE registered custom property driving a static
// layer's opacity — not a gradient interpolation, which would repaint the
// full viewport every scroll frame (P1).
function buildFieldTemperature() {
  if (!document.querySelector(".field-cool")) return;
  gsap.to(document.documentElement, {
    "--field-temp": 1,
    ease: "none",
    scrollTrigger: {
      trigger: document.documentElement,
      start: "top top",
      end: "max",
      scrub: scrub(1.2) || 0.3,
    },
  });
}

// Scroll velocity stretches the FIELD, never the content.
//
// Deviation from the plan, deliberately: the design called for velocity
// stretch on content wrappers, but those already carry PASS, and both want
// scale — two animators on one matrix. Moving the response to the field
// resolves that by construction AND is the better idea: plasma is what
// deforms in a current, not the page furniture. It also means a stretch can
// never touch a click target, which was the constraint the plan was trying to
// protect in the first place.
// One ticker for both the velocity stretch and the breathing, because two rAF
// loops writing to the same elements is pure overhead.
//
// Breathing is the Sun's real 5-minute p-mode (~3 mHz), compressed 60:1 to a
// 5-second period. The two cells breathe in ANTIPHASE, which is what gives it
// spatial structure: a standing wave with a node between them, rather than the
// whole page pulsing in unison. That is also closer to the physics than
// per-element phase offsets would have been, since a p-mode is a global
// resonance of the whole body.
//
// It rides opacity, never colour or text-shadow. Those are paint properties,
// and an ambient oscillation on them would repaint continuously for as long as
// the page stays open — a real battery cost for a decorative effect.
const BREATH_PERIOD = 5;
const BREATH_AMP = 0.30;

function buildFieldTicker() {
  // The CORE, not the cell: the cell's transform belongs to the CSS drift
  // animation, which outranks anything written inline.
  const cells = Array.from(document.querySelectorAll(".field-cell-core"));
  if (!cells.length) return;
  let smooth = 0;
  let raw = 0;
  ScrollTrigger.create({
    onUpdate: (self) => {
      raw = self.getVelocity();
    },
  });
  gsap.ticker.add((time) => {
    // Breathing rides ambient amplitude, so pools and the tier system damp it
    // to nothing without this loop knowing they exist.
    if (motionState.amp > 0) {
      const phase = (time / BREATH_PERIOD) * Math.PI * 2;
      cells.forEach((c, i) => {
        const swing = Math.sin(phase + (i ? Math.PI : 0)); // antiphase
        c.style.opacity = String(0.78 * motionState.amp * (1 + BREATH_AMP * swing));
      });
    }
    if (!motionState.velGain) {
      if (smooth !== 0) {
        smooth = 0;
        cells.forEach((c) => gsap.set(c, { scaleY: 1, scaleX: 1 }));
      }
      return;
    }
    // Asymmetric smoothing: reacts faster than it recovers is WRONG here —
    // we want the opposite, a quick return to rest the moment scrolling
    // stops, or the field looks permanently deformed.
    const k = Math.abs(raw) > Math.abs(smooth) ? 0.1 : 0.16;
    smooth += (raw - smooth) * k;
    const v = Math.max(-1, Math.min(1, smooth / 2600)) * motionState.velGain;
    const a = Math.abs(v);
    // Volume conservation: stretch along travel, narrow across it. A skew
    // would read as paper; this reads as a droplet in a stream. Hard caps
    // because past roughly 8% it stops looking physical and starts looking
    // like a rendering bug.
    cells.forEach((c) => gsap.set(c, { scaleY: 1 + a * 0.075, scaleX: 1 - a * 0.028 }));
  });
}

// ── Phase 4: signature moments ─────────────────────────────────────────

// Hand-rolled character splitter. GSAP's SplitText is a paid Club plugin and
// is not in the vendored set, so this is the minimum that does the job
// ACCESSIBLY:
//   - the container keeps the full string as aria-label, and every generated
//     span is aria-hidden, so assistive tech reads one sentence rather than
//     spelling it out letter by letter;
//   - words are wrapped and kept nowrap, so line breaking is unchanged and the
//     split cannot cause a layout shift;
//   - the split is REVERTED when the animation finishes, returning real text
//     that is selectable, searchable and translatable. Since every entrance
//     here runs once, reverting costs nothing.
function splitChars(el) {
  const text = el.textContent;
  const frag = document.createDocumentFragment();
  const chars = [];
  text.split(/(\s+)/).forEach((token) => {
    if (!token) return;
    if (!/\S/.test(token)) {
      frag.appendChild(document.createTextNode(token));
      return;
    }
    const word = document.createElement("span");
    word.className = "mr-word";
    for (const ch of token) {
      const c = document.createElement("span");
      c.className = "mr-char";
      c.textContent = ch;
      word.appendChild(c);
      chars.push(c);
    }
    frag.appendChild(word);
  });
  el.setAttribute("aria-label", text);
  el.setAttribute("data-mr-split", "1");
  el.textContent = "";
  el.appendChild(frag);
  return {
    chars,
    revert() {
      el.textContent = text;
      el.removeAttribute("aria-label");
      el.removeAttribute("data-mr-split");
    },
  };
}

// The heliograph writes with sunlight, so headlines are INSCRIBED rather than
// revealed: a write-head travels the reading direction and each glyph ignites
// white-hot then cools behind it.
function buildInscriptions(skipSet) {
  if (motionState.tier >= 2) return;
  const fold = window.innerHeight * 0.85;
  document.querySelectorAll(".section-title").forEach((el) => {
    // Same above-fold rule as SURFACE: never re-animate what the visitor can
    // already see, and never touch the checkout path.
    let top;
    try {
      top = el.getBoundingClientRect().top;
    } catch (e) {
      return;
    }
    if (top < fold) return;
    if (el.closest("#confirmSelectModal, #editSection")) return;
    // Never inscribe a heading that is not currently rendered. A title inside
    // a collapsed or hidden container has no reliable trigger point, so its
    // ScrollTrigger may never fire — and an inscription that never fires is a
    // heading that never appears. offsetParent is null for anything with a
    // display:none ancestor, which is exactly the case to skip.
    if (!el.offsetParent) return;
    if (el.closest(".section-collapsed, [hidden], .hidden")) return;

    const split = splitChars(el);
    if (!split.chars.length) return;
    skipSet.add(el.closest(".section-header") || el);

    gsap
      .timeline({
        scrollTrigger: { trigger: el, start: "top 85%", once: true },
        onComplete: () => split.revert(),
      })
      // `amount` caps the TOTAL stagger regardless of how many characters the
      // headline has. Using `each` would make a 52-character line take over a
      // second before it finished arriving, which is an unacceptable delay in
      // front of the value proposition.
      .fromTo(
        split.chars,
        { "--heat": 0, opacity: 0, yPercent: 8, scaleY: 1.12, scaleX: 0.94 },
        {
          "--heat": 1,
          opacity: 1,
          yPercent: 0,
          scaleY: 1,
          scaleX: 1,
          duration: 0.34,
          ease: "surface",
          stagger: { amount: 0.55, from: "start" },
          // Without this, fromTo stamps opacity:0 onto every character the
          // instant the timeline is BUILT, not when it plays. Any heading
          // whose trigger had not fired yet was therefore invisible — which is
          // exactly how the wavelength heading disappeared. Text must never be
          // hidden by an animation that has not started.
          immediateRender: false,
        }
      )
      // Cooling starts BEFORE the ignition finishes so it chases the
      // write-head down the line instead of waiting for it.
      .to(
        split.chars,
        { "--heat": 0, duration: 0.62, ease: "settle",
          stagger: { amount: 0.55, from: "start" }, immediateRender: false },
        0.16
      );
  });
}

// The RHEF reveal: the filtered panel resolves from a dark, high-contrast
// state (what the raw telescope frame looks like) up to the equalized version
// where the faint outer atmosphere is visible. The animation performs the
// product claim instead of describing it.
function buildRhefReveal() {
  const strip = document.getElementById("qualityStrip");
  if (!strip || motionState.tier >= 2) return;
  // Once per session: a demonstration that replays every time you scroll past
  // stops reading as a demonstration and starts reading as decoration.
  try {
    if (sessionStorage.getItem("mr_rhef_seen") === "1") return;
  } catch (e) {
    /* private mode: just play it */
  }

  const tween = gsap.fromTo(
    strip,
    { "--rhef": 0 },
    {
      "--rhef": 1,
      duration: 2.2,
      ease: "settle",
      paused: true,
      // Without this, fromTo applies its "from" state the moment it is
      // created, so a visitor who never scrolls to the strip would be left
      // staring at the unequalized panel forever. Only dim it once the reveal
      // is actually about to run.
      immediateRender: false,
    }
  );

  ScrollTrigger.create({
    trigger: strip,
    start: "top 60%",
    once: true,
    onEnter: () => {
      tween.play();
      try {
        sessionStorage.setItem("mr_rhef_seen", "1");
      } catch (e) {
        /* non-fatal */
      }
    },
  });

  // If the visitor scrolls away mid-reveal, SNAP to the finished state. A
  // half-played reveal leaves the UNEQUALIZED image on screen, which means the
  // failure mode of this animation would be advertising the inferior version
  // of the product. The end state is the only acceptable resting state.
  ScrollTrigger.create({
    trigger: strip,
    start: "top bottom",
    end: "bottom top",
    onLeave: () => tween.progress(1),
    onLeaveBack: () => tween.progress(1),
  });
}

// The Sun surge: still, surge, still. Fired when the visitor's chosen Sun
// finishes loading — the emotional peak of the funnel, and the one moment the
// page is allowed to shout. One crest, never a second bob.
export function sunSurge(el) {
  if (!motionState.ready || !gsap || motionState.tier >= 3 || !el) return;
  try {
    gsap
      .timeline()
      .set(el, { scale: 0.94, opacity: 0, filter: "brightness(1.6)" })
      .to({}, { duration: 0.15 }) // the breath before
      .to(el, {
        opacity: 1,
        scale: 1.02,
        filter: "brightness(1.12)",
        duration: 0.7,
        ease: "surface",
      })
      .to(el, { scale: 1, filter: "brightness(1)", duration: 1.1, ease: "settle" })
      // The field warms and cools with it, so their Sun visibly lights the room.
      .to(".field-warm", { opacity: 1.35, duration: 0.5, ease: "surface" }, "-=1.5")
      .to(".field-warm", { opacity: 1, duration: 1.4, ease: "settle" });
  } catch (e) {
    /* a decorative surge must never break the image pipeline */
  }
}

let choreographyBuilt = false;
export function initChoreography() {
  if (choreographyBuilt || !motionState.ready || !gsap || !ScrollTrigger) return;
  choreographyBuilt = true;
  try {
    buildFieldTemperature();
    buildPass();
    // Inscriptions first: they claim their section headers so SURFACE does not
    // also animate the same block.
    const claimed = new Set();
    buildInscriptions(claimed);
    buildSurface(claimed);
    buildRhefReveal();
    buildFieldTicker();
    ScrollTrigger.refresh();
  } catch (e) {
    /* choreography is enhancement: a failure here must not break the store */
  }
}

// ── Diagnostics ────────────────────────────────────────────────────────
// Exposed unconditionally and deliberately. When motion "isn't working" the
// cause is almost never visible from the page: it is an OS reduce-motion
// setting, a frame-rate downgrade, a once-per-session flag that already fired,
// or the vendor bundle failing to load. Guessing between those from a
// screenshot is hopeless; `__motion.why()` answers it in one line.
export function why() {
  const reasons = [];
  let rm = false;
  try {
    rm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    /* ignore */
  }
  if (rm) reasons.push("OS 'reduce motion' is ON — this alone disables everything");
  if (QUERY_AT_LOAD.get("fast") === "1") reasons.push("?fast=1 in the URL");
  try {
    const c = navigator.connection;
    if (c && c.saveData) reasons.push("browser data-saver is ON");
  } catch (e) {
    /* ignore */
  }
  if (!motionState.ready) reasons.push("engine never initialised (vendor bundle failed to load?)");
  if (motionState.tier >= 2) reasons.push(`tier ${motionState.tier} (frame rate probe downgraded it)`);
  let seen = null;
  try {
    seen = sessionStorage.getItem("mr_rhef_seen");
  } catch (e) {
    /* ignore */
  }
  if (seen === "1") reasons.push("RHEF reveal already played this session (reload clears nothing — use __motion.replay())");
  return {
    running: motionState.ready && motionState.tier < 2 && !rm,
    tier: motionState.tier,
    ready: motionState.ready,
    reducedMotion: rm,
    triggers: ScrollTrigger ? ScrollTrigger.getAll().length : 0,
    reasons: reasons.length ? reasons : ["nothing is suppressing motion"],
  };
}

// Clear the once-per-session gates so the signature moments can be watched
// again without opening a new private window.
export function replay() {
  try {
    sessionStorage.removeItem("mr_rhef_seen");
  } catch (e) {
    /* ignore */
  }
  location.reload();
}

try {
  window.__motion = { state: motionState, why, replay, setTier };
} catch (e) {
  /* debug handle only */
}

// Convenience for later phases: resolve a scrub value through the ladder.
// Returns false when scrubbing is disabled, which ScrollTrigger treats as
// "no scrub" — the animation then plays on entry instead of tracking scroll.
export function scrub(base) {
  const v = base * motionState.scrubMul;
  return v > 0 ? v : false;
}
