import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";

// The single thread of light in the crossing void. One thin emissive cylinder
// from the Sun toward the viewer, visible only during the crossing space.
export default function Beam() {
  const ref = useRef<THREE.Mesh>(null!);
  const mat = useRef<THREE.MeshBasicMaterial>(null!);

  useFrame(() => {
    const { progress, channel } = useStore.getState();
    // fade in/out across the crossing window (~0.28..0.50)
    const v = THREE.MathUtils.clamp(
      Math.min((progress - 0.26) / 0.08, (0.5 - progress) / 0.08),
      0,
      1
    );
    ref.current.visible = v > 0.01;
    mat.current.opacity = v * 0.7;
    mat.current.color.set(CHANNELS[channel].hot);
  });

  return (
    // cylinder default runs along Y; rotate to Z so it points at the camera
    <mesh ref={ref} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 4.5]}>
      <cylinderGeometry args={[0.015, 0.06, 9, 12, 1, true]} />
      <meshBasicMaterial
        ref={mat}
        transparent
        opacity={0}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        side={THREE.DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}
