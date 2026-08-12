import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// Soft round motes (a radial sprite, not hard squares) with gentle cursor
// displacement. They fade out as the camera leaves the void for the room.
function roundSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

export default function Dust({ count = 260 }: { count?: number }) {
  const points = useRef<THREE.Points>(null!);
  const mat = useRef<THREE.PointsMaterial>(null!);
  const sprite = useMemo(roundSprite, []);
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
    const { reducedMotion, progress } = useStore.getState();
    // fade the starfield out as we approach the room (~0.7 -> 0.86)
    const fade = THREE.MathUtils.clamp((0.86 - progress) / 0.16, 0, 1);
    mat.current.opacity = 0.5 * fade;
    points.current.visible = fade > 0.01;
    if (fade <= 0.01) return; // no CPU loop / buffer upload while invisible

    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const px = state.pointer.x * 7;
    const py = state.pointer.y * 4.5;
    const drift = reducedMotion ? 0 : dt;
    for (let i = 0; i < count; i++) {
      const hx = home[i * 3],
        hy = home[i * 3 + 1];
      let x = pos.getX(i),
        y = pos.getY(i);
      x += (hx - x) * 0.02 + Math.sin(state.clock.elapsedTime * 0.2 + i) * drift * 0.02;
      y += (hy - y) * 0.02 + Math.cos(state.clock.elapsedTime * 0.15 + i) * drift * 0.02;
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
        ref={mat}
        map={sprite}
        alphaMap={sprite}
        size={0.05}
        sizeAttenuation
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
