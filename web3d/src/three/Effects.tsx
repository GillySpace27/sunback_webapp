import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { EffectComposer, Bloom, DepthOfField, Vignette } from "@react-three/postprocessing";
import type { DepthOfFieldEffect } from "postprocessing";
import { useStore } from "../store";

// Bloom is always on (the Sun's glow). DoF stays MOUNTED for the whole film and
// is neutralized to a no-op (bokehScale 0) outside the aperture window, rather
// than being added/removed — unmounting a pass rebuilds the composer and drops a
// frame at the cinematic transitions jurors scrub over.
// smooth 0→1→0 window so bokeh eases in and out of the aperture beat instead of
// snapping on at the boundary (a visible pop the jurors scrub straight through).
//
// Window matches the aperture beat (space 0.22–0.37; the wheel itself lives
// 0.205–0.30). An earlier edit drifted it to 0.27–0.47, which put peak bokeh on
// the CROSSING zoom-out instead — the opposite of the comment's intent.
function dofRamp(p: number) {
  const lo = 0.22, inFull = 0.26, outFull = 0.32, hi = 0.37;
  if (p <= lo || p >= hi) return 0;
  if (p < inFull) return (p - lo) / (inFull - lo);
  if (p > outFull) return (hi - p) / (hi - outFull);
  return 1;
}

// Drives bokehScale IMPERATIVELY, outside React. This component must never
// subscribe to a continuously-varying store value: a float selector here
// re-renders <Effects> on every scroll tick, and EffectComposer keys its pass
// construction on children identity, so each render tore the composer down and
// recompiled its GL programs PER FRAME — the "bogged down since the first
// iteration" regression (the original build gated on booleans for this reason).
function DofDriver({ dof }: { dof: React.RefObject<DepthOfFieldEffect> }) {
  useFrame(() => {
    const eff = dof.current;
    if (!eff) return;
    const target = dofRamp(useStore.getState().progress) * 2.4;
    if (eff.bokehScale !== target) eff.bokehScale = target;
  });
  return null;
}

export default function Effects() {
  // quality is the ONLY subscription: a discrete tier that changes rarely.
  const quality = useStore((s) => s.quality);
  const dofRef = useRef<DepthOfFieldEffect>(null);
  if (quality === "low") {
    return (
      <EffectComposer multisampling={0}>
        <Bloom intensity={0.7} luminanceThreshold={0.25} mipmapBlur />
      </EffectComposer>
    );
  }
  return (
    <>
      <DofDriver dof={dofRef} />
      <EffectComposer multisampling={0}>
        <Bloom intensity={0.85} luminanceThreshold={0.2} luminanceSmoothing={0.9} mipmapBlur />
        <DepthOfField
          ref={dofRef}
          focusDistance={0.012}
          focalLength={0.028}
          bokehScale={0}
        />
        <Vignette eskil={false} offset={0.3} darkness={0.42} />
      </EffectComposer>
    </>
  );
}
