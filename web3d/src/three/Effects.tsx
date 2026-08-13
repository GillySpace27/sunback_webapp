import { EffectComposer, Bloom, DepthOfField, Vignette } from "@react-three/postprocessing";
import { useStore } from "../store";

// Bloom is always on (the Sun's glow). DoF stays MOUNTED for the whole film and
// is neutralized to a no-op (bokehScale 0) outside the aperture window, rather
// than being added/removed — unmounting a pass rebuilds the composer and drops a
// frame at the cinematic transitions jurors scrub over.
// smooth 0→1→0 window so bokeh eases in and out of the aperture beat instead of
// snapping on at the boundary (a visible pop the jurors scrub straight through).
function dofRamp(p: number) {
  const lo = 0.27, inFull = 0.31, outFull = 0.43, hi = 0.47;
  if (p <= lo || p >= hi) return 0;
  if (p < inFull) return (p - lo) / (inFull - lo);
  if (p > outFull) return (hi - p) / (hi - outFull);
  return 1;
}

export default function Effects() {
  // shallow focus on the aperture (wheel + Sun); vista, descent, and print crisp
  const bokeh = useStore((s) => dofRamp(s.progress) * 2.4);
  const quality = useStore((s) => s.quality);
  if (quality === "low") {
    return (
      <EffectComposer>
        <Bloom intensity={0.7} luminanceThreshold={0.25} mipmapBlur />
      </EffectComposer>
    );
  }
  return (
    <EffectComposer>
      <Bloom intensity={0.85} luminanceThreshold={0.2} luminanceSmoothing={0.9} mipmapBlur />
      <DepthOfField
        focusDistance={0.012}
        focalLength={0.028}
        bokehScale={bokeh}
      />
      <Vignette eskil={false} offset={0.3} darkness={0.42} />
    </EffectComposer>
  );
}
