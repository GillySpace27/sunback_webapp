import { EffectComposer, Bloom, DepthOfField, Vignette } from "@react-three/postprocessing";
import { useStore } from "../store";

// Bloom is always on (the Sun's glow). DoF stays MOUNTED for the whole film and
// is neutralized to a no-op (bokehScale 0) outside the aperture window, rather
// than being added/removed — unmounting a pass rebuilds the composer and drops a
// frame at the cinematic transitions jurors scrub over.
export default function Effects() {
  // shallow focus on the aperture (wheel + Sun); vista, descent, and print crisp
  const dofActive = useStore((s) => s.progress > 0.29 && s.progress < 0.45);
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
        bokehScale={dofActive ? 2.4 : 0}
      />
      <Vignette eskil={false} offset={0.3} darkness={0.42} />
    </EffectComposer>
  );
}
