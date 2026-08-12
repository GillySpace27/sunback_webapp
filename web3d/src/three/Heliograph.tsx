import { useMemo, useRef } from "react";
import { useFrame, ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { useWheelTextures } from "../hooks/useWheelTextures";

// The filter wheel, as the classic SDO multi-wavelength fan: the SAME Sun for
// the chosen date, cut into pie slices — each slice the real disk in one
// wavelength — with the nm value on each. Sits in front of the Sun during the
// aperture; click a slice to select that wavelength. Fades off before/after.
const INNER = 0.06;
const OUTER = 2.5;
const DISC_UV = 0.31; // solar disk radius in the thumb's UV space (FOV ~3072")
const WHEEL_Z = 2.0; // in front of the Sun so slices, not the sphere, are seen

// annular sector whose UVs map to the matching disk region of the wavelength
// image, so all nine slices line up into one coherent Sun
function wedgeGeometry(a0: number, a1: number) {
  const shape = new THREE.Shape();
  shape.moveTo(Math.cos(a0) * INNER, Math.sin(a0) * INNER);
  shape.lineTo(Math.cos(a0) * OUTER, Math.sin(a0) * OUTER);
  shape.absarc(0, 0, OUTER, a0, a1, false);
  shape.lineTo(Math.cos(a1) * INNER, Math.sin(a1) * INNER);
  shape.absarc(0, 0, INNER, a1, a0, true);
  const g = new THREE.ShapeGeometry(shape, 40);
  const p = g.getAttribute("position");
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) / OUTER) * DISC_UV + 0.5;
    uv[i * 2 + 1] = (p.getY(i) / OUTER) * DISC_UV + 0.5;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}

function makeLabel(text: string) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 72;
  const g = c.getContext("2d")!;
  g.font = "600 34px Inter, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillText(text, 129, 38);
  g.fillStyle = "#fff";
  g.fillText(text, 128, 36);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export default function Heliograph() {
  const group = useRef<THREE.Group>(null!);
  const hovered = useRef(-1);
  const meshes = useRef<THREE.Mesh[]>([]);
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const texes = useWheelTextures(date, time);

  const wedges = useMemo(() => {
    const n = CHANNELS.length;
    const gap = 0.02;
    return CHANNELS.map((ch, i) => {
      const a0 = (i / n) * Math.PI * 2 + gap;
      const a1 = ((i + 1) / n) * Math.PI * 2 - gap;
      const mid = (a0 + a1) / 2;
      return {
        geometry: wedgeGeometry(a0, a1),
        label: makeLabel(ch.label),
        labelPos: [Math.cos(mid) * 1.75, Math.sin(mid) * 1.75, 0.02] as [number, number, number],
        tint: new THREE.Color(ch.tint),
      };
    });
  }, []);

  useFrame(() => {
    const { channel, progress } = useStore.getState();
    // present through the aperture space (~0.29-0.45)
    const fade = THREE.MathUtils.clamp(
      Math.min((progress - 0.29) / 0.05, (0.45 - progress) / 0.05),
      0,
      1
    );
    for (let i = 0; i < meshes.current.length; i++) {
      const m = meshes.current[i];
      if (!m) continue;
      const mat = m.material as THREE.MeshBasicMaterial;
      const selected = i === channel;
      const hot = i === hovered.current;
      const target = fade * (selected ? 1 : hot ? 0.92 : 0.62);
      mat.opacity += (target - mat.opacity) * 0.15;
      const z = (selected ? 0.18 : hot ? 0.1 : 0) * fade;
      m.position.z += (z - m.position.z) * 0.2;
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
    <group ref={group} position={[0, 0, WHEEL_Z]}>
      {wedges.map((w, i) => (
        <group key={i}>
          <mesh
            ref={(el) => (meshes.current[i] = el!)}
            geometry={w.geometry}
            onClick={pick(i)}
            onPointerOver={enter(i)}
            onPointerOut={leave}
          >
            <meshBasicMaterial
              key={texes[i] ? "tex" : "notex"}
              map={texes[i] || undefined}
              color={texes[i] ? "#ffffff" : w.tint}
              transparent
              opacity={0}
              side={THREE.DoubleSide}
              toneMapped={false}
            />
          </mesh>
          <mesh position={w.labelPos} raycast={() => null}>
            <planeGeometry args={[0.86, 0.24]} />
            <meshBasicMaterial map={w.label} transparent depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
