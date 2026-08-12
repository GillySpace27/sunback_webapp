import { EffectComposer, Bloom, DepthOfField, Vignette } from "@react-three/postprocessing";
import { useStore } from "../store";

// Bloom is always on (the Sun's glow). DoF gives a photographic shallow focus
// through the aperture and the room; it is the most expensive pass, so it is
// off in the wide/void spaces and disabled entirely on the low tier.
export default function Effects() {
  // shallow focus through the aperture/darkroom; OFF in the room so the framed
  // print stays crisp (it's a photo, not a light to blur)
  const dofOn = useStore((s) => s.progress > 0.46 && s.progress < 0.8);
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
      {dofOn ? (
        <DepthOfField focusDistance={0.012} focalLength={0.028} bokehScale={2.4} />
      ) : (
        <></>
      )}
      <Vignette eskil={false} offset={0.3} darkness={0.42} />
    </EffectComposer>
  );
}
