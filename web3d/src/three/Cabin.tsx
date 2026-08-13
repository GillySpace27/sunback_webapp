import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// A little log cabin sitting in the field. During the sky beat you see it from a
// distance; the camera then dollies toward its warm, lit window and DISSOLVES
// through to the interior (Room) — "zoom into the cabin, the sunlight is inside".
// It shares the field's ground level and center so it sits in the same world.
const GROUND_Y = -8.7;
const CX = 5.5;
const CZ = 22;
const HALF_W = 3.6; // half width (x)
const HALF_D = 2.6; // half depth (z)
const WALL_H = 3.4;
const BASE_Y = GROUND_Y + WALL_H / 2; // wall box center
const FRONT_Z = CZ + HALF_D; // the face the camera approaches (+Z, viewer side)

// stacked-log texture. Each course is shaded like a ROUND log (dark top edge →
// bright upper third → midtone → dark bottom) with wood grain, occasional knots,
// and darker chinking between courses. The old version was a flat 128px band
// gradient that read as cardboard in the wide field shot (award-review finding);
// this bakes the cylindrical light + grain into a 512px map so the logs have
// form and detail even before the (flat) lighting touches them.
function logTexture() {
  const W = 512,
    H = 512;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#5a3d26";
  g.fillRect(0, 0, W, H);
  const courses = 8;
  const ch = H / courses;
  for (let i = 0; i < courses; i++) {
    const y = i * ch;
    const warm = 150 + Math.floor(Math.random() * 28); // per-log timber variation
    const rgb = (l: number) => `rgb(${Math.max(0, warm + l)},${Math.max(0, warm + l - 26)},${Math.max(0, warm + l - 54)})`;
    // cylindrical shading across the log's height
    const grad = g.createLinearGradient(0, y, 0, y + ch);
    grad.addColorStop(0.0, rgb(-64)); // shadowed top edge
    grad.addColorStop(0.3, rgb(22)); // highlight (log crown)
    grad.addColorStop(0.58, rgb(-6)); // midtone
    grad.addColorStop(1.0, rgb(-70)); // shadowed bottom edge
    g.fillStyle = grad;
    g.fillRect(0, y + 2, W, ch - 4);
    // wood grain: faint wavy streaks running along the log
    for (let s = 0; s < 16; s++) {
      const gy = y + 4 + Math.random() * (ch - 8);
      g.globalAlpha = 0.06 + Math.random() * 0.08;
      g.strokeStyle = Math.random() < 0.5 ? "#2e1c10" : "#946a3e";
      g.lineWidth = 0.6 + Math.random() * 0.9;
      g.beginPath();
      g.moveTo(0, gy);
      for (let x = 0; x <= W; x += 28) g.lineTo(x, gy + Math.sin((x / W) * Math.PI * 2 + i) * 1.3);
      g.stroke();
    }
    g.globalAlpha = 1;
    // an occasional knot
    if (Math.random() < 0.55) {
      const kx = Math.random() * W,
        ky = y + ch * (0.4 + Math.random() * 0.25),
        kr = 3 + Math.random() * 4;
      const kg = g.createRadialGradient(kx, ky, 0, kx, ky, kr);
      kg.addColorStop(0, "#281608");
      kg.addColorStop(0.7, "rgba(40,22,8,0.5)");
      kg.addColorStop(1, "rgba(40,22,8,0)");
      g.fillStyle = kg;
      g.beginPath();
      g.arc(kx, ky, kr, 0, Math.PI * 2);
      g.fill();
    }
    // chinking (mortar) between courses
    g.fillStyle = "rgba(26,17,11,0.92)";
    g.fillRect(0, y, W, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8; // hold detail at the grazing angle of the wide field shot
  t.repeat.set(3, 1);
  return t;
}

// soft contact shadow so the cabin sits IN the grass, not on top of it
function cabinShadow() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(16,26,10,0.55)");
  r.addColorStop(0.6, "rgba(16,26,10,0.26)");
  r.addColorStop(1, "rgba(16,26,10,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// warm window glow (sun inside), brightest at center
function windowGlow() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 30, 2, 32, 32, 34);
  grad.addColorStop(0, "#fff7e0");
  grad.addColorStop(0.5, "#ffdf9c");
  grad.addColorStop(1, "#f0b86a");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// filled gable triangle for the front/back roof ends
function gableGeo() {
  const s = new THREE.Shape();
  s.moveTo(-HALF_W, 0);
  s.lineTo(HALF_W, 0);
  s.lineTo(0, WALL_H * 0.7);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

export default function Cabin() {
  const logs = useMemo(logTexture, []);
  const glow = useMemo(windowGlow, []);
  const shadow = useMemo(cabinShadow, []);
  const gable = useMemo(gableGeo, []);
  const group = useRef<THREE.Group>(null!);
  const mats = useRef<THREE.Material[]>([]);
  const winMat = useRef<THREE.MeshBasicMaterial>(null!);
  const spillMat = useRef<THREE.MeshBasicMaterial>(null!);
  const collect = (m: THREE.Material | null) => {
    if (m && !mats.current.includes(m)) mats.current.push(m);
  };
  // front-face materials fade by CAMERA PROXIMITY so we fly THROUGH the window
  // pane into the interior, rather than the whole cabin cross-dissolving
  const frontMats = useRef<THREE.Material[]>([]);
  const collectFront = (m: THREE.Material | null) => {
    if (m && !frontMats.current.includes(m)) frontMats.current.push(m);
  };

  useFrame((s) => {
    const p = useStore.getState().progress;
    // fade in with the field (~0.52), stay solid through the whole approach so the
    // window close-up reads as OUTSIDE, then dissolve through to the interior only
    // at the threshold (~0.72 -> 0.77)
    const o = THREE.MathUtils.clamp(Math.min((p - 0.515) / 0.02, (0.77 - p) / 0.05), 0, 1);
    if (group.current) group.current.visible = o > 0.01;
    for (const m of mats.current) (m as THREE.Material).opacity = o;
    // front face opens up as the camera reaches the window (z -> FRONT_Z): opaque
    // on approach, but fully GONE a bit before the camera crosses the wall plane
    // (FRONT_Z=24.6), so we never graze a half-opaque wall — the warm entry bloom
    // covers the last of the crossing.
    const frontFade = THREE.MathUtils.clamp((s.camera.position.z - 26.8) / 2.6, 0, 1);
    for (const m of frontMats.current) (m as THREE.Material).opacity = o * frontFade;
    // the window pulses faintly warmer so it reads as lit-from-within (also fades
    // on approach so we fly through the pane, not into it)
    if (winMat.current)
      winMat.current.opacity = o * frontFade * (0.9 + 0.1 * Math.sin(s.clock.elapsedTime * 0.9));
    if (spillMat.current) spillMat.current.opacity = o * frontFade * 0.2;
  });

  const wallMat = (
    <meshStandardMaterial ref={collect} map={logs} roughness={1} transparent opacity={0} />
  );

  return (
    <group ref={group} visible={false}>
      {/* own warm daylight key so the timber reads even as the field light fades */}
      <directionalLight position={[2, 6, 12]} intensity={1.5} color="#fff0d2" />
      <ambientLight intensity={0.5} color="#cfe0ff" />

      {/* contact shadow grounding the whole cabin footprint (wider than the base
          so it reads as a soft cast shadow, fades with the cabin) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[CX, GROUND_Y + 0.04, CZ + 0.3]}>
        <planeGeometry args={[HALF_W * 2 + 3, HALF_D * 2 + 2.4]} />
        <meshBasicMaterial ref={collect} map={shadow} transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* four log walls — the FRONT one opens as we fly through */}
      <mesh position={[CX, BASE_Y, FRONT_Z]}>
        <boxGeometry args={[HALF_W * 2, WALL_H, 0.3]} />
        <meshStandardMaterial ref={collectFront} map={logs} roughness={1} transparent opacity={0} />
      </mesh>
      <mesh position={[CX, BASE_Y, CZ - HALF_D]}>
        <boxGeometry args={[HALF_W * 2, WALL_H, 0.3]} />
        {wallMat}
      </mesh>
      <mesh position={[CX - HALF_W, BASE_Y, CZ]}>
        <boxGeometry args={[0.3, WALL_H, HALF_D * 2]} />
        {wallMat}
      </mesh>
      <mesh position={[CX + HALF_W, BASE_Y, CZ]}>
        <boxGeometry args={[0.3, WALL_H, HALF_D * 2]} />
        {wallMat}
      </mesh>

      {/* gable ends (front/back), filling under the roof peak */}
      <mesh geometry={gable} position={[CX, GROUND_Y + WALL_H, FRONT_Z]}>
        <meshStandardMaterial ref={collect} map={logs} roughness={1} transparent opacity={0} />
      </mesh>
      <mesh geometry={gable} position={[CX, GROUND_Y + WALL_H, CZ - HALF_D]}>
        <meshStandardMaterial ref={collect} map={logs} roughness={1} transparent opacity={0} />
      </mesh>

      {/* gabled roof: two slabs meeting at the ridge */}
      <mesh position={[CX - HALF_W / 2, GROUND_Y + WALL_H + WALL_H * 0.35, CZ]} rotation={[0, 0, 0.62]}>
        <boxGeometry args={[HALF_W * 1.25, 0.18, HALF_D * 2 + 0.7]} />
        <meshStandardMaterial ref={collect} color="#3a2a1c" roughness={1} transparent opacity={0} />
      </mesh>
      <mesh position={[CX + HALF_W / 2, GROUND_Y + WALL_H + WALL_H * 0.35, CZ]} rotation={[0, 0, -0.62]}>
        <boxGeometry args={[HALF_W * 1.25, 0.18, HALF_D * 2 + 0.7]} />
        <meshStandardMaterial ref={collect} color="#3a2a1c" roughness={1} transparent opacity={0} />
      </mesh>

      {/* door on the front, to the right of the window */}
      <mesh position={[CX + 1.5, GROUND_Y + 1.05, FRONT_Z + 0.16]}>
        <planeGeometry args={[1.1, 2.1]} />
        <meshStandardMaterial ref={collectFront} color="#241610" roughness={0.9} transparent opacity={0} />
      </mesh>

      {/* ── the lit window (the sun is inside) — the target we dolly toward ── */}
      <group position={[CX - 1.3, GROUND_Y + 1.9, FRONT_Z + 0.16]}>
        {/* frame */}
        <mesh position={[0, 0, -0.02]}>
          <planeGeometry args={[1.5, 1.7]} />
          <meshStandardMaterial ref={collectFront} color="#2a1c12" roughness={0.9} transparent opacity={0} />
        </mesh>
        {/* warm glowing pane */}
        <mesh>
          <planeGeometry args={[1.24, 1.44]} />
          <meshBasicMaterial ref={winMat} map={glow} transparent opacity={0} toneMapped={false} />
        </mesh>
        {/* mullions */}
        <mesh position={[0, 0, 0.02]}>
          <planeGeometry args={[0.06, 1.44]} />
          <meshStandardMaterial ref={collectFront} color="#2a1c12" transparent opacity={0} />
        </mesh>
        <mesh position={[0, 0, 0.02]}>
          <planeGeometry args={[1.24, 0.06]} />
          <meshStandardMaterial ref={collectFront} color="#2a1c12" transparent opacity={0} />
        </mesh>
        {/* soft outdoor spill hugging the window (not a wall-wide glow blob) */}
        <mesh position={[0, 0, 0.05]}>
          <planeGeometry args={[1.75, 1.95]} />
          <meshBasicMaterial
            ref={spillMat}
            map={glow}
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}
