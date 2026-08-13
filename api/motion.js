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
        { yPercent: 6, scale: 0.988 },
        { yPercent: 0, scale: 1, ease: "none" }
      )
      .to(inner, { yPercent: -6, scale: 0.988, ease: "none" });
  });
}

// Elements rise through a waterline. The desync IS the effect: clarity lands
// at ~0.55s while position keeps settling to 0.9s, so the thing is readable
// before it has finished arriving.
function buildSurface() {
  const targets = [];
  document.querySelectorAll(".flow-inner").forEach((fi) => {
    for (const child of fi.children) targets.push(child);
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

    const from = { opacity: 0, yPercent: 9, scale: 0.982 };
    const to = { opacity: 1, duration: instant ? 0.12 : 0.4, ease: "surface" };
    const tl = gsap.timeline({
      scrollTrigger: { trigger: el, start: "top 85%", once: true },
    });
    tl.fromTo(el, from, to, 0);
    if (mayBlur && !instant) {
      tl.fromTo(
        el,
        { filter: "blur(4px) saturate(0.75) brightness(0.75)" },
        { filter: "blur(0px) saturate(1) brightness(1)", duration: 0.55, ease: "surface" },
        0
      );
    }
    tl.fromTo(
      el,
      { yPercent: from.yPercent, scale: from.scale },
      { yPercent: 0, scale: 1, duration: instant ? 0.12 : 0.9, ease: "crest" },
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
function buildVelocity() {
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
  gsap.ticker.add(() => {
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

let choreographyBuilt = false;
export function initChoreography() {
  if (choreographyBuilt || !motionState.ready || !gsap || !ScrollTrigger) return;
  choreographyBuilt = true;
  try {
    buildFieldTemperature();
    buildPass();
    buildSurface();
    buildVelocity();
    ScrollTrigger.refresh();
  } catch (e) {
    /* choreography is enhancement: a failure here must not break the store */
  }
}

// Convenience for later phases: resolve a scrub value through the ladder.
// Returns false when scrubbing is disabled, which ScrollTrigger treats as
// "no scrub" — the animation then plays on entry instead of tracking scroll.
export function scrub(base) {
  const v = base * motionState.scrubMul;
  return v > 0 ? v : false;
}
