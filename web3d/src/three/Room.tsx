import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// The landing. A warm interior with the finished piece on the wall: a framed
// print of the real SDO/AIA disk for the chosen identity (the shared texture,
// shown flat as a photo). While that photo is still loading the frame shows a
// subtle "developing" shimmer, never a blank hole. Sits far down -Z; the camera
// flies here after the aperture. Hidden until approached so the frame never
// floats into the hero sightline.
const Z = -40;

// pulsing placeholder inside the frame while the print's photo loads
function Shimmer() {
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame((s) => {
    if (mat.current) mat.current.opacity = 0.12 + 0.08 * Math.sin(s.clock.elapsedTime * 2.2);
  });
  return (
    <mesh position={[0, 0, 0.02]}>
      <planeGeometry args={[2.4, 2.4]} />
      <meshBasicMaterial ref={mat} color="#c25a2a" transparent opacity={0.15} toneMapped={false} />
    </mesh>
  );
}

export default function Room() {
  const tex = useStore((s) => s.currentTexture);
  const near = useStore((s) => s.progress > 0.5);
  const showPrint = near && !!tex;

  return (
    <group position={[0, 0, Z]} visible={near}>
      {/* warm tungsten room light */}
      <ambientLight intensity={0.5} color="#ffe0bf" />
      <directionalLight position={[6, 7, 8]} intensity={1.9} color="#ffd2a0" />
      <pointLight position={[-4, 2, 6]} intensity={22} distance={34} color="#ffb877" />

      {/* back wall, warm */}
      <mesh position={[0, 0, -0.4]}>
        <planeGeometry args={[60, 36]} />
        <meshStandardMaterial color="#3c2a1c" roughness={1} />
      </mesh>

      {/* frame + mat + the printed photo (square, disk centered) */}
      <group>
        <mesh position={[0, 0, -0.02]}>
          <planeGeometry args={[2.98, 2.98]} />
          <meshStandardMaterial color="#0f0b08" roughness={0.6} metalness={0.1} />
        </mesh>
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[2.72, 2.72]} />
          <meshStandardMaterial color="#efe9dc" roughness={0.9} />
        </mesh>
        {/* dark base under the print */}
        <mesh position={[0, 0, 0.01]}>
          <planeGeometry args={[2.4, 2.4]} />
          <meshBasicMaterial color="#0b0705" toneMapped={false} />
        </mesh>
        {/* developing shimmer until the real photo is ready */}
        {near && !showPrint && <Shimmer />}
        {/* the printed photo — mounted fresh once the JPG is ready so the
            material compiles WITH the map. Dimmed a touch so the bright disk
            reads as a print, not a lamp that blooms out. */}
        {showPrint && (
          <mesh position={[0, 0, 0.02]}>
            <planeGeometry args={[2.4, 2.4]} />
            <meshBasicMaterial map={tex} color="#c2c2c2" toneMapped={false} />
          </mesh>
        )}
      </group>
    </group>
  );
}
