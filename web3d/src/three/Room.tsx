import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// The landing, on Earth. The light that left the Sun crosses the dark and
// arrives in someone's home: it comes through a window (the Sun glowing
// outside) and a soft shaft falls across the wall, materializing as a framed
// print of the real SDO/AIA disk for the chosen day. Cosmic -> domestic.
// Hidden until approached so nothing floats into the earlier beats.
// On the viewer side (+Z), near Earth — the home you settle back into.
// Ground-floor interior: sits low so the camera ENTERS the cabin at standing
// height (through the window) and is already in the room — not risen above it.
const ROOM_POS: [number, number, number] = [5.5, -6.6, 22];

// The view OUT the window: the same blue sky + warm Sun we crossed the field
// under, so the star that made the print is still up there in the background
// while we're inside. (Matches SkyGround's sky gradient + sun disk.)
function makeSky() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 160;
  const g = c.getContext("2d")!;
  // daytime blue, deeper at the top, hazier toward the horizon
  const grad = g.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0, "#3f7ec9");
  grad.addColorStop(0.55, "#8fbce8");
  grad.addColorStop(1, "#dce9f4");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 160);
  // the Sun, warm, in the upper-left of the pane
  const sx = 44;
  const sy = 46;
  const halo = g.createRadialGradient(sx, sy, 0, sx, sy, 66);
  halo.addColorStop(0, "rgba(255,247,224,0.95)");
  halo.addColorStop(0.28, "rgba(255,228,150,0.5)");
  halo.addColorStop(0.6, "rgba(255,214,110,0.16)");
  halo.addColorStop(1, "rgba(255,214,110,0)");
  g.fillStyle = halo;
  g.fillRect(0, 0, 128, 160);
  const core = g.createRadialGradient(sx, sy, 0, sx, sy, 15);
  core.addColorStop(0, "#fffdf3");
  core.addColorStop(0.7, "#fff2cf");
  core.addColorStop(1, "rgba(255,240,200,0)");
  g.fillStyle = core;
  g.fillRect(0, 0, 128, 160);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// a soft-edged light shaft (fades on all four sides) — never a hard shape
function makeShaft() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff2d6";
  g.fillRect(0, 0, 256, 96);
  g.globalCompositeOperation = "destination-in";
  const gv = g.createLinearGradient(0, 0, 0, 96);
  gv.addColorStop(0, "rgba(0,0,0,0)");
  gv.addColorStop(0.5, "rgba(0,0,0,1)");
  gv.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gv;
  g.fillRect(0, 0, 256, 96);
  const gh = g.createLinearGradient(0, 0, 256, 0);
  gh.addColorStop(0, "rgba(0,0,0,0)");
  gh.addColorStop(0.18, "rgba(0,0,0,1)");
  gh.addColorStop(0.85, "rgba(0,0,0,1)");
  gh.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = gh;
  g.fillRect(0, 0, 256, 96);
  const t = new THREE.CanvasTexture(c);
  return t;
}

// The print materializes as you scroll in: an inkblot bloom (noise-thresholded
// reveal with a soft ink edge), driven by scroll progress 0.76 -> 0.92.
const printVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const printFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform float uReveal;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
               mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
  }
  void main(){
    // blotchy threshold: big blobs + finer detail -> organic ink bleed
    float n = noise(vUv * 5.0) * 0.62 + noise(vUv * 15.0) * 0.38;
    float a = smoothstep(n - 0.10, n + 0.06, uReveal);
    vec3 col = texture2D(uMap, vUv).rgb * 0.82;
    if (a <= 0.001) discard;
    gl_FragColor = vec4(col, a);
  }
`;

function MaterializingPrint({ tex }: { tex: THREE.Texture }) {
  const uniforms = useMemo(
    () => ({ uMap: { value: tex }, uReveal: { value: 0 } }),
    [tex]
  );
  useFrame(() => {
    const { progress, reducedMotion } = useStore.getState();
    // scroll-driven inkblot bloom as you settle into the room
    uniforms.uReveal.value = reducedMotion
      ? 1
      : THREE.MathUtils.clamp((progress - 0.74) / 0.09, 0, 1);
  });
  return (
    <mesh position={[0, 0, 0.02]}>
      <planeGeometry args={[1.8, 1.8]} />
      <shaderMaterial
        vertexShader={printVert}
        fragmentShader={printFrag}
        uniforms={uniforms}
        transparent
        toneMapped={false}
      />
    </mesh>
  );
}

// pulsing placeholder inside the frame while the print's photo loads
function Shimmer() {
  const mat = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame((s) => {
    if (mat.current) mat.current.opacity = 0.12 + 0.08 * Math.sin(s.clock.elapsedTime * 2.2);
  });
  return (
    <mesh position={[0, 0, 0.015]}>
      <planeGeometry args={[1.8, 1.8]} />
      <meshBasicMaterial ref={mat} color="#c25a2a" transparent opacity={0.15} toneMapped={false} />
    </mesh>
  );
}

export default function Room() {
  const tex = useStore((s) => s.currentTexture);
  // reveal as the cabin exterior dissolves — a hair earlier than the wall-cross
  // so the interior is already present UNDER the warm entry bloom (no see-through
  // gap while the exterior front wall has faded but the interior hasn't shown)
  const near = useStore((s) => s.progress > 0.7);
  const showPrint = near && !!tex;
  const sky = useMemo(makeSky, []);
  const shaft = useMemo(makeShaft, []);
  const shaftMat = useRef<THREE.MeshBasicMaterial>(null!);

  // the shaft breathes very slightly so it reads as living light, not a decal
  useFrame((s) => {
    if (shaftMat.current)
      shaftMat.current.opacity = 0.32 + 0.05 * Math.sin(s.clock.elapsedTime * 0.8);
  });

  return (
    <group position={ROOM_POS} visible={near}>
      {/* warm tungsten room light + a stronger warm key from the window side */}
      <ambientLight intensity={0.5} color="#ffe0bf" />
      <directionalLight position={[-3, 3, 6]} intensity={1.3} color="#ffddab" />
      <pointLight position={[-1.8, 1.2, 4]} intensity={7} distance={26} color="#ffcf90" />

      {/* back wall, warm; a soft light pool from the window keeps it from
          reading as a flat plane */}
      <mesh position={[0, 0, -0.5]}>
        <planeGeometry args={[60, 36]} />
        <meshStandardMaterial color="#3a2717" roughness={1} />
      </mesh>
      {/* wood floor at standing height (just below the eye), wide + deep enough
          to fully cover the field grass behind it as we step inside — so the
          interior never shows green underfoot */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.9, 6]}>
        <planeGeometry args={[80, 40]} />
        <meshStandardMaterial color="#2a1c12" roughness={1} />
      </mesh>

      {/* ── the window: the Sun, outside ── */}
      <group position={[-1.85, 1.15, -0.35]}>
        <mesh position={[0, 0, -0.02]}>
          <planeGeometry args={[2.4, 3.0]} />
          <meshStandardMaterial color="#0f0b08" roughness={0.6} />
        </mesh>
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[2.1, 2.7]} />
          <meshBasicMaterial map={sky} toneMapped={false} />
        </mesh>
        {/* mullions (cross bars) so it reads as a window */}
        <mesh position={[0, 0, 0.02]}>
          <planeGeometry args={[0.06, 2.7]} />
          <meshStandardMaterial color="#0f0b08" />
        </mesh>
        <mesh position={[0, 0, 0.02]}>
          <planeGeometry args={[2.1, 0.06]} />
          <meshStandardMaterial color="#0f0b08" />
        </mesh>
      </group>

      {/* ── the light shaft: window -> print, soft on every edge ── */}
      <mesh position={[-0.3, 0.4, -0.2]} rotation={[0, 0, -0.42]}>
        <planeGeometry args={[3.6, 1.7]} />
        <meshBasicMaterial
          ref={shaftMat}
          map={shaft}
          color="#ffdca0"
          transparent
          opacity={0.32}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* ── the framed print, where the light lands ── */}
      <group position={[1.2, 0.1, 0]}>
        <mesh position={[0, 0, -0.02]}>
          <planeGeometry args={[2.36, 2.36]} />
          <meshStandardMaterial color="#0f0b08" roughness={0.6} metalness={0.1} />
        </mesh>
        {/* muted paper mat — a near-white mat blooms into a harsh white rim */}
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[2.12, 2.12]} />
          <meshStandardMaterial color="#a89a7e" roughness={0.95} />
        </mesh>
        {/* warm-dark backing so the print reads as a dim image while it
            materializes, not a black void inside a glowing frame */}
        <mesh position={[0, 0, 0.01]}>
          <planeGeometry args={[1.8, 1.8]} />
          <meshBasicMaterial color="#1c120c" toneMapped={false} />
        </mesh>
        {near && !showPrint && <Shimmer />}
        {showPrint && tex && <MaterializingPrint tex={tex} />}
      </group>
    </group>
  );
}
