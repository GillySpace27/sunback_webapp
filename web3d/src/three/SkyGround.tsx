import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// The landing, from the ground. Instead of panning the Sun away and cutting to
// blue, we descend INTO the atmosphere: the black of space gives way to blue
// sky, the Sun warms from its filtered color to plain yellow sunlight, and a
// landscape rises into frame — grass underfoot, trees, mountains on the horizon.
// We're standing in a field, the same star overhead, the home a turn away.
// One big stage the camera stands inside; it fades in as we drop and out as we
// step indoors, so it never bleeds into the space beats.
const CENTER: [number, number, number] = [5.5, -3, 22]; // around the home
const GROUND_Y = -8.7; // the home's floor level
const SUN_POS: [number, number, number] = [2.0, -2.8, 15]; // warm sun, upper-left of the sky, in frame

function makeSkyDome() {
  const c = document.createElement("canvas");
  c.width = 16;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#2f6fc4"); // zenith (canvas top -> dome top)
  grad.addColorStop(0.6, "#7fb2e6");
  grad.addColorStop(1, "#dfeaf4"); // horizon haze
  g.fillStyle = grad;
  g.fillRect(0, 0, 16, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function sunDisk() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,250,225,1)");
  grad.addColorStop(0.18, "rgba(255,236,150,0.98)");
  grad.addColorStop(0.5, "rgba(255,214,110,0.5)");
  grad.addColorStop(1, "rgba(255,200,90,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// grass: green, a touch hazier/paler toward the far edge for aerial perspective
function makeGround() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 10, 128, 128, 150);
  grad.addColorStop(0, "#4a7a34");
  grad.addColorStop(1, "#3a6630");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  // LARGE-scale color patches (meadow variation that reads at distance) rather
  // than fine speckle that vanishes a few metres out
  const greens = ["#437033", "#3c6a2d", "#548539", "#35602b", "#4d7a36"];
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 40 + Math.random() * 70;
    const col = greens[(Math.random() * greens.length) | 0];
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.globalAlpha = 0.35;
    g.fillStyle = rg;
    g.fillRect(0, 0, 256, 256);
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}

// a 360° ridge silhouette wrapped on a cylinder at the horizon, hazy blue-grey
function makeMountains() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const g = c.getContext("2d")!;
  const draw = (baseY: number, amp: number, col: string, step: number) => {
    g.beginPath();
    g.moveTo(0, 256);
    let y = baseY;
    for (let x = 0; x <= 1024; x += step) {
      y = baseY + (Math.random() - 0.5) * amp;
      g.lineTo(x, y);
    }
    g.lineTo(1024, 256);
    g.closePath();
    g.fillStyle = col;
    g.fill();
  };
  // far range (lighter/hazier), then a nearer, darker range in front
  draw(150, 60, "rgba(150,170,196,0.85)", 60);
  draw(185, 70, "rgba(110,134,166,0.95)", 46);
  // aerial haze: a pale wash rising from the horizon so the ridges dissolve into
  // atmosphere at their base instead of meeting the ground on a hard line
  const haze = g.createLinearGradient(0, 130, 0, 256);
  haze.addColorStop(0, "rgba(223,233,244,0)");
  haze.addColorStop(0.7, "rgba(223,233,244,0.45)");
  haze.addColorStop(1, "rgba(223,233,244,0.8)");
  g.fillStyle = haze;
  g.fillRect(0, 130, 1024, 126);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}

// soft round contact shadow so trees/cabin sit IN the grass, not float on it
function blobShadow() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(18,28,12,0.5)");
  r.addColorStop(0.55, "rgba(18,28,12,0.24)");
  r.addColorStop(1, "rgba(18,28,12,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// a simple low-poly tree: brown trunk + two stacked green cones, grounded by a
// soft contact shadow. Foliage carries a faint warm emissive so the sun-lit
// side reads as lit rather than flat.
function Tree({
  position,
  scale = 1,
  shadow,
}: {
  position: [number, number, number];
  scale?: number;
  shadow: THREE.Texture;
}) {
  return (
    <group position={position} scale={scale}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <planeGeometry args={[2.3, 2.3]} />
        <meshBasicMaterial map={shadow} transparent depthWrite={false} opacity={0.75} />
      </mesh>
      <mesh position={[0, 0.6, 0]}>
        <cylinderGeometry args={[0.12, 0.16, 1.2, 6]} />
        <meshStandardMaterial color="#5a3a22" roughness={1} transparent />
      </mesh>
      <mesh position={[0, 1.5, 0]}>
        <coneGeometry args={[0.8, 1.4, 8]} />
        <meshStandardMaterial color="#37662f" roughness={1} emissive="#16240e" emissiveIntensity={0.35} transparent />
      </mesh>
      <mesh position={[0, 2.2, 0]}>
        <coneGeometry args={[0.6, 1.1, 8]} />
        <meshStandardMaterial color="#3f7235" roughness={1} emissive="#1a2a10" emissiveIntensity={0.35} transparent />
      </mesh>
    </group>
  );
}

export default function SkyGround() {
  const sky = useMemo(makeSkyDome, []);
  const disk = useMemo(sunDisk, []);
  const ground = useMemo(makeGround, []);
  const mountains = useMemo(makeMountains, []);
  const shadow = useMemo(blobShadow, []);
  const group = useRef<THREE.Group>(null!);
  const sun = useRef<THREE.Mesh>(null!);
  const mats = useRef<THREE.Material[]>([]);

  // a stand of trees on the field, placed to the sides so the center path to
  // the home stays clear (deterministic so the framing is stable)
  const trees = useMemo(() => {
    const off: [number, number, number][] = [
      [-12, 2, 1.9], [-9, -4, 1.3], [-14, -1, 2.3], [-7, 3, 1.5], [-10, 5, 2.0], [-6, -6, 1.2],
      [10, 3, 2.0], [13, -2, 1.4], [7, 4, 1.6], [15, 1, 2.4], [9, -5, 1.3], [6, 6, 1.1],
    ];
    return off.map(([dx, dz, s]) => ({
      pos: [CENTER[0] + dx, GROUND_Y, CENTER[2] + dz] as [number, number, number],
      s,
    }));
  }, []);

  const collect = (m: THREE.Material | null) => {
    if (m && !mats.current.includes(m)) mats.current.push(m);
  };

  useFrame((s) => {
    const p = useStore.getState().progress;
    // appear only AFTER Earth-the-planet is cut and the flash is covering (0.515),
    // so the ground and the planet are never on screen together; hold; fade out
    // as we step indoors
    const o = THREE.MathUtils.clamp(Math.min((p - 0.515) / 0.02, (0.77 - p) / 0.04), 0, 1);
    if (group.current) group.current.visible = o > 0.01;
    for (const m of mats.current) (m as THREE.Material).opacity = o;
    if (sun.current) sun.current.lookAt(s.camera.position);
  });

  return (
    <group ref={group} visible={false}>
      {/* soft daylight so the grass, trees, and mountains read warm */}
      <hemisphereLight args={["#bfe0ff", "#3a5a2e", 0.9]} />
      <directionalLight position={[SUN_POS[0], SUN_POS[1], SUN_POS[2]]} intensity={1.6} color="#fff0cf" />
      {/* warm rim from the sun's side + a hair above the camera, so the low-poly
          cones catch a lit edge and read as dimensional, not flat cut-outs */}
      <directionalLight position={[3, 6, 12]} intensity={1.0} color="#ffe2ac" />

      {/* sky dome — we stand inside it */}
      <mesh position={CENTER}>
        <sphereGeometry args={[40, 32, 16]} />
        <meshBasicMaterial
          ref={collect}
          map={sky}
          side={THREE.BackSide}
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
          fog={false}
        />
      </mesh>

      {/* the Sun, warm yellow, in the sky (billboarded). Normal blending, not
          additive, so it reads as a bright disk ON the blue rather than washing
          into it. */}
      <mesh ref={sun} position={SUN_POS}>
        <planeGeometry args={[6, 6]} />
        <meshBasicMaterial
          ref={collect}
          map={disk}
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* grass field */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[CENTER[0], GROUND_Y, CENTER[2] - 2]}>
        <planeGeometry args={[140, 140]} />
        <meshStandardMaterial ref={collect} map={ground} roughness={1} transparent />
      </mesh>

      {/* mountains on the horizon (360° ridge band) */}
      <mesh position={[CENTER[0], GROUND_Y + 5, CENTER[2]]}>
        <cylinderGeometry args={[30, 30, 12, 48, 1, true]} />
        <meshBasicMaterial
          ref={collect}
          map={mountains}
          side={THREE.BackSide}
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
          fog={false}
        />
      </mesh>

      {/* trees */}
      {trees.map((t, i) => (
        <Tree key={i} position={t.pos} scale={t.s} shadow={shadow} />
      ))}
    </group>
  );
}
