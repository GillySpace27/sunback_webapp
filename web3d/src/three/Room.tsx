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
const ROOM_POS: [number, number, number] = [2.5, -2.5, 13];

// warm daylight sky with a bright sun glow, seen through the window
function makeSky() {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 160;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 160);
  grad.addColorStop(0, "#ffe6c0");
  grad.addColorStop(1, "#ffcf97");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 160);
  const sun = g.createRadialGradient(64, 46, 2, 64, 46, 46);
  sun.addColorStop(0, "#fffdf5");
  sun.addColorStop(0.5, "rgba(255,240,200,0.85)");
  sun.addColorStop(1, "rgba(255,220,160,0)");
  g.fillStyle = sun;
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
      : THREE.MathUtils.clamp((progress - 0.76) / 0.16, 0, 1);
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
  // reveal only once we've left the Earth vista and are descending to the home
  const near = useStore((s) => s.progress > 0.66);
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
      <ambientLight intensity={0.45} color="#ffe0bf" />
      <directionalLight position={[-3, 3, 6]} intensity={2.1} color="#ffddab" />
      <pointLight position={[-1.8, 1.2, 4]} intensity={16} distance={26} color="#ffcf90" />

      {/* back wall, warm; a soft light pool from the window keeps it from
          reading as a flat plane */}
      <mesh position={[0, 0, -0.5]}>
        <planeGeometry args={[60, 36]} />
        <meshStandardMaterial color="#3a2717" roughness={1} />
      </mesh>
      {/* floor, to give the room depth instead of a floating frame */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -4.2, 3]}>
        <planeGeometry args={[60, 16]} />
        <meshStandardMaterial color="#241812" roughness={1} />
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
      <group position={[1.2, -0.2, 0]}>
        <mesh position={[0, 0, -0.02]}>
          <planeGeometry args={[2.36, 2.36]} />
          <meshStandardMaterial color="#0f0b08" roughness={0.6} metalness={0.1} />
        </mesh>
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[2.12, 2.12]} />
          <meshStandardMaterial color="#efe9dc" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0, 0.01]}>
          <planeGeometry args={[1.8, 1.8]} />
          <meshBasicMaterial color="#0b0705" toneMapped={false} />
        </mesh>
        {near && !showPrint && <Shimmer />}
        {showPrint && tex && <MaterializingPrint tex={tex} />}
      </group>
    </group>
  );
}
