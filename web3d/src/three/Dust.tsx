import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// Cheap ambient motes with soft cursor displacement. Near layer only reacts to
// the pointer; count stays small. Reads as depth without a particle engine.
export default function Dust({ count = 320 }: { count?: number }) {
  const points = useRef<THREE.Points>(null!);
  const home = useMemo(() => {
    const a = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      a[i * 3 + 0] = (Math.random() - 0.5) * 14;
      a[i * 3 + 1] = (Math.random() - 0.5) * 9;
      a[i * 3 + 2] = (Math.random() - 0.5) * 8 - 1;
    }
    return a;
  }, [count]);

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(home.slice(), 3));
    return g;
  }, [home]);

  useFrame((state, dt) => {
    const { reducedMotion } = useStore.getState();
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const px = state.pointer.x * 7;
    const py = state.pointer.y * 4.5;
    const drift = reducedMotion ? 0 : dt;
    for (let i = 0; i < count; i++) {
      const hx = home[i * 3],
        hy = home[i * 3 + 1];
      let x = pos.getX(i),
        y = pos.getY(i);
      // slow convection back toward home
      x += (hx - x) * 0.02 + Math.sin(state.clock.elapsedTime * 0.2 + i) * drift * 0.02;
      y += (hy - y) * 0.02 + Math.cos(state.clock.elapsedTime * 0.15 + i) * drift * 0.02;
      // soft radial push away from the cursor (near layer)
      const dx = x - px,
        dy = y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < 4 && !reducedMotion) {
        const f = (1 - d2 / 4) * 0.06;
        x += dx * f;
        y += dy * f;
      }
      pos.setX(i, x);
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    points.current.rotation.z += drift * 0.005;
  });

  return (
    <points ref={points} geometry={geo}>
      <pointsMaterial
        size={0.03}
        color="#ffd9a0"
        transparent
        opacity={0.5}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </points>
  );
}
