import { EffectComposer, Bloom, DepthOfField, Vignette } from "@react-three/postprocessing";
import { useStore } from "../store";

// Bloom is always on (the Sun's glow). DoF mounts only in the aperture/darkroom
// window and only above the "low" tier — it is the most expensive pass.
export default function Effects() {
  // re-renders only when these booleans flip, not per frame
  const dofOn = useStore((s) => s.progress > 0.44 && s.progress < 0.72);
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
      <Bloom intensity={0.9} luminanceThreshold={0.2} luminanceSmoothing={0.9} mipmapBlur />
      {dofOn ? (
        <DepthOfField focusDistance={0.015} focalLength={0.03} bokehScale={3} />
      ) : (
        <></>
      )}
      <Vignette eskil={false} offset={0.25} darkness={0.75} />
    </EffectComposer>
  );
}
