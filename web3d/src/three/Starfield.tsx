import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Stars } from "@react-three/drei";
import * as THREE from "three";
import { useStore } from "../store";

// A real celestial-sphere starfield (drei), replacing the cursor-chased motes:
// thousands of fixed stars of varied size on a large distant sphere, drifting
// almost imperceptibly. It belongs to the space beats, so it hides once we drop
// into the atmosphere (progress > ~0.6) rather than bleeding through the blue.
export default function Starfield() {
  const g = useRef<THREE.Group>(null!);
  useFrame(() => {
    // hide UNDER the atmosphere flash (~0.51), before the ground fades in, so the
    // stars are never visible through the still-translucent ground/cabin
    if (g.current) g.current.visible = useStore.getState().progress < 0.51;
  });
  return (
    <group ref={g}>
      {/* deep field: many faint, distant stars */}
      <Stars radius={80} depth={55} count={5200} factor={5} saturation={0} fade speed={0.2} />
      {/* nearer field: fewer, larger, faintly warm stars → parallax + depth so
          the sky reads as volume, not a flat sheet of identical dots */}
      <Stars radius={45} depth={25} count={700} factor={11} saturation={0.35} fade speed={0.35} />
    </group>
  );
}
