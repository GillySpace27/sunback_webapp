import { useMemo, useRef } from "react";
import { useFrame, ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { useWheelTextures } from "../hooks/useWheelTextures";

// The filter wheel: the day's Sun in every wavelength, as a clean palette. A
// ring of real pie slices (one per wavelength, nm-labelled) fans around a
// TRANSPARENT center — the actual 3D Sun sphere (the current selection) shines
// through the hole; click a slice to change it. The heading lives outside it.
const INNER = 1.15; // ring hole ~= the 3D Sun's silhouette at the aperture camera
const OUTER = 3.0;
const DISC_UV = 0.31; // solar-disk radius in the thumb's UV space (FOV ~3072")
const WHEEL_Z = 2.0; // in front of the 3D sphere, which shows through the hole

function ringWedge(a0: number, a1: number) {
  const shape = new THREE.Shape();
  shape.moveTo(Math.cos(a0) * INNER, Math.sin(a0) * INNER);
  shape.lineTo(Math.cos(a0) * OUTER, Math.sin(a0) * OUTER);
  shape.absarc(0, 0, OUTER, a0, a1, false);
  shape.lineTo(Math.cos(a1) * INNER, Math.sin(a1) * INNER);
  shape.absarc(0, 0, INNER, a1, a0, true);
  const g = new THREE.ShapeGeometry(shape, 40);
  // UV maps each slice to the matching disk region, so the ring reads as one Sun
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
  g.font = "600 32px Inter, system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "rgba(0,0,0,0.6)";
  g.fillText(text, 129, 38);
  g.fillStyle = "#fff";
  g.fillText(text, 128, 36);
  return new THREE.CanvasTexture(c);
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
    const gap = 0.018;
    return CHANNELS.map((ch, i) => {
      const a0 = (i / n) * Math.PI * 2 + gap;
      const a1 = ((i + 1) / n) * Math.PI * 2 - gap;
      const mid = (a0 + a1) / 2;
      const r = (INNER + OUTER) / 2;
      return {
        geometry: ringWedge(a0, a1),
        label: makeLabel(ch.label),
        labelPos: [Math.cos(mid) * r, Math.sin(mid) * r, 0.02] as [number, number, number],
        tint: new THREE.Color(ch.tint),
      };
    });
  }, []);

  useFrame(() => {
    const { channel: ch, progress } = useStore.getState();
    const fade = THREE.MathUtils.clamp(
      Math.min((progress - 0.29) / 0.05, (0.45 - progress) / 0.05),
      0,
      1
    );
    for (let i = 0; i < meshes.current.length; i++) {
      const m = meshes.current[i];
      if (!m) continue;
      const mat = m.material as THREE.MeshBasicMaterial;
      const selected = i === ch;
      const hot = i === hovered.current;
      const target = fade * (selected ? 1 : hot ? 0.98 : 0.9);
      mat.opacity += (target - mat.opacity) * 0.15;
      const z = (selected ? 0.14 : hot ? 0.08 : 0) * fade;
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
            <planeGeometry args={[0.82, 0.23]} />
            <meshBasicMaterial map={w.label} transparent depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
      {/* center is left open — the 3D Sun sphere shows through the hole */}
    </group>
  );
}
