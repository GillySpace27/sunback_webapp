import { useMemo, useRef } from "react";
import { useFrame, ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";

// The "sun-pizza" filter wheel: 10 glass wedges radiating around the Sun,
// one per SDO channel. Clicking a wedge selects that wavelength and recolors
// the plasma. This is the site's signature object and its wavelength picker.
function sectorGeometry(inner: number, outer: number, a0: number, a1: number) {
  const shape = new THREE.Shape();
  shape.moveTo(Math.cos(a0) * inner, Math.sin(a0) * inner);
  shape.lineTo(Math.cos(a0) * outer, Math.sin(a0) * outer);
  shape.absarc(0, 0, outer, a0, a1, false);
  shape.lineTo(Math.cos(a1) * inner, Math.sin(a1) * inner);
  shape.absarc(0, 0, inner, a1, a0, true);
  return new THREE.ShapeGeometry(shape, 24);
}

export default function Heliograph() {
  const group = useRef<THREE.Group>(null!);
  const hovered = useRef(-1);
  const meshes = useRef<THREE.Mesh[]>([]);

  const wedges = useMemo(() => {
    const n = CHANNELS.length;
    const gap = 0.03; // radians between wedges
    const inner = 1.85;
    const outer = 2.95;
    return CHANNELS.map((ch, i) => {
      const a0 = (i / n) * Math.PI * 2 + gap;
      const a1 = ((i + 1) / n) * Math.PI * 2 - gap;
      return {
        geometry: sectorGeometry(inner, outer, a0, a1),
        color: new THREE.Color(ch.tint),
      };
    });
  }, []);

  useFrame(() => {
    const { channel, progress } = useStore.getState();
    // fade the wheel in around the "aperture" space (progress ~0.40..0.72)
    const fade = THREE.MathUtils.clamp(
      Math.min((progress - 0.36) / 0.12, (0.78 - progress) / 0.12),
      0,
      1
    );
    for (let i = 0; i < meshes.current.length; i++) {
      const m = meshes.current[i];
      if (!m) continue;
      const mat = m.material as THREE.MeshBasicMaterial;
      const selected = i === channel;
      const hot = i === hovered.current;
      const targetOpacity = fade * (selected ? 0.95 : hot ? 0.7 : 0.32);
      mat.opacity += (targetOpacity - mat.opacity) * 0.15;
      // selected/hovered wedges lift toward the viewer + scale slightly
      const z = (selected ? 0.35 : hot ? 0.18 : 0) * fade;
      m.position.z += (z - m.position.z) * 0.2;
      const s = 1 + (selected ? 0.06 : 0) * fade;
      m.scale.x += (s - m.scale.x) * 0.2;
      m.scale.y = m.scale.x;
    }
    group.current.visible = fade > 0.01;
  });

  const pick =
    (i: number) =>
    (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      useStore.getState().setChannel(i);
    };
  const enter =
    (i: number) =>
    (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      hovered.current = i;
      document.body.style.cursor = "pointer";
    };
  const leave = () => {
    hovered.current = -1;
    document.body.style.cursor = "auto";
  };

  return (
    <group ref={group}>
      {wedges.map((w, i) => (
        <mesh
          key={i}
          ref={(el) => (meshes.current[i] = el!)}
          geometry={w.geometry}
          onClick={pick(i)}
          onPointerOver={enter(i)}
          onPointerOut={leave}
        >
          <meshBasicMaterial
            color={w.color}
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
