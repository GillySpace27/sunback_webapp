import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// Earth, out in the dark, lit by the Sun: after you choose the light at the Sun,
// the camera pulls back and the light crosses 93 million miles to a blue marble,
// then descends to a home. Only present for the crossing/descent, so it never
// intrudes on the Sun beats or the room.
const SUN = new THREE.Vector3(0, 0, 0);
const EARTH = new THREE.Vector3(5, -2, -8);

function roundSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,246,224,0.7)");
  grad.addColorStop(1, "rgba(255,240,200,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export default function Earth() {
  const show = useStore((s) => s.progress > 0.4 && s.progress < 0.9);
  const sprite = useMemo(roundSprite, []);

  // a soft trail of warm light from the Sun to Earth (round sprites always face
  // the camera, so it reads as a beam from every angle — no oriented geometry)
  const beam = useMemo(() => {
    const n = 14;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const p = SUN.clone().lerp(EARTH, t);
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);

  const beamMat = useRef<THREE.PointsMaterial>(null!);
  useFrame((s) => {
    if (beamMat.current)
      beamMat.current.opacity = 0.5 + 0.12 * Math.sin(s.clock.elapsedTime * 1.1);
  });

  return (
    <group visible={show}>
      {/* the Sun as a light source for Earth's day side (short range so it
          never reaches the room) */}
      <pointLight position={[0, 0, 0]} intensity={90} distance={22} decay={2} color="#fff2d6" />

      {/* Earth */}
      <mesh position={EARTH.toArray()}>
        <sphereGeometry args={[1.1, 48, 48]} />
        <meshStandardMaterial color="#274b74" roughness={0.85} metalness={0.05} emissive="#0a1a30" emissiveIntensity={0.4} />
      </mesh>
      {/* atmosphere rim */}
      <mesh position={EARTH.toArray()} scale={1.12}>
        <sphereGeometry args={[1.1, 32, 32]} />
        <meshBasicMaterial color="#6fb4ff" transparent opacity={0.12} side={THREE.BackSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>

      {/* the sunbeam: warm light spanning Sun -> Earth */}
      <points geometry={beam}>
        <pointsMaterial
          ref={beamMat}
          map={sprite}
          size={1.6}
          sizeAttenuation
          color="#ffe6b0"
          transparent
          opacity={0.55}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>
    </group>
  );
}
