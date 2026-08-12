import { useMemo, useRef } from "react";
import { useFrame, ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";

// The filter wheel: 10 glass wedges radiating around the Sun, one per SDO
// channel. Each wedge glows from its inner edge (nearest the light) and falls
// off outward via per-vertex color, so it reads as lit glass, not a flat pie.
// Clicking a wedge selects that wavelength and recolors the plasma.
const INNER = 1.9;
const OUTER = 3.0;

function wedgeGeometry(a0: number, a1: number, hot: THREE.Color, tint: THREE.Color) {
  const shape = new THREE.Shape();
  shape.moveTo(Math.cos(a0) * INNER, Math.sin(a0) * INNER);
  shape.lineTo(Math.cos(a0) * OUTER, Math.sin(a0) * OUTER);
  shape.absarc(0, 0, OUTER, a0, a1, false);
  shape.lineTo(Math.cos(a1) * INNER, Math.sin(a1) * INNER);
  shape.absarc(0, 0, INNER, a1, a0, true);
  const g = new THREE.ShapeGeometry(shape, 32);

  // per-vertex radial gradient: hot core near the Sun -> dim tint at the rim
  const p = g.getAttribute("position");
  const colors = new Float32Array(p.count * 3);
  const dim = tint.clone().multiplyScalar(0.35);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const r = Math.hypot(p.getX(i), p.getY(i));
    const t = THREE.MathUtils.clamp((r - INNER) / (OUTER - INNER), 0, 1);
    c.copy(hot).lerp(dim, t * t);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

export default function Heliograph() {
  const group = useRef<THREE.Group>(null!);
  const hovered = useRef(-1);
  const meshes = useRef<THREE.Mesh[]>([]);

  const wedges = useMemo(() => {
    const n = CHANNELS.length;
    const gap = 0.012; // thin, precise gaps
    return CHANNELS.map((ch, i) => {
      const a0 = (i / n) * Math.PI * 2 + gap;
      const a1 = ((i + 1) / n) * Math.PI * 2 - gap;
      return wedgeGeometry(a0, a1, new THREE.Color(ch.hot), new THREE.Color(ch.tint));
    });
  }, []);

  useFrame(() => {
    const { channel, progress } = useStore.getState();
    // present through the aperture; kept off the crossing void and the room
    const fade = THREE.MathUtils.clamp(
      Math.min((progress - 0.5) / 0.06, (0.76 - progress) / 0.06),
      0,
      1
    );
    for (let i = 0; i < meshes.current.length; i++) {
      const m = meshes.current[i];
      if (!m) continue;
      const mat = m.material as THREE.MeshBasicMaterial;
      const selected = i === channel;
      const hot = i === hovered.current;
      const target = fade * (selected ? 0.9 : hot ? 0.55 : 0.24);
      mat.opacity += (target - mat.opacity) * 0.15;
      const z = (selected ? 0.4 : hot ? 0.2 : 0) * fade;
      m.position.z += (z - m.position.z) * 0.2;
      const s = 1 + (selected ? 0.05 : 0) * fade;
      m.scale.x += (s - m.scale.x) * 0.2;
      m.scale.y = m.scale.x;
    }
    group.current.visible = fade > 0.01;
  });

  const pick = (i: number) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    useStore.getState().setChannel(i);
  };
  const enter = (i: number) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    hovered.current = i;
    document.body.style.cursor = "pointer";
  };
  const leave = () => {
    hovered.current = -1;
    document.body.style.cursor = "auto";
  };

  return (
    <group ref={group} rotation={[-0.12, 0, 0]}>
      {wedges.map((geometry, i) => (
        <mesh
          key={i}
          ref={(el) => (meshes.current[i] = el!)}
          geometry={geometry}
          onClick={pick(i)}
          onPointerOver={enter(i)}
          onPointerOut={leave}
        >
          <meshBasicMaterial
            vertexColors
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}
