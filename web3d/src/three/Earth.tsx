import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// Earth, out in the dark, lit by the Sun. After you choose the light at the Sun,
// the camera pulls back TOWARD the viewer and the light crosses to a real blue
// marble, then settles into a home. Positioned on the viewer side (+Z) so the
// journey reads as "coming back to Earth, where I am" — not diving behind the Sun.
const SUN = new THREE.Vector3(0, 0, 0);
const EARTH = new THREE.Vector3(3, -2, 9);

// soft length-wise gradient so the beam is a continuous ray, faded at both ends
function beamAlpha() {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0.15)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 128);
  return new THREE.CanvasTexture(c);
}

export default function Earth() {
  const show = useStore((s) => s.progress > 0.44 && s.progress < 0.9);
  // the daylight fill is only for the Earth vista; off by the time the (closer)
  // warm home is on screen so it doesn't cool the room
  const crossingView = useStore((s) => s.progress < 0.64);
  // load the Blue Marble lazily (not needed until the crossing) so it never
  // blocks the initial Scene render
  const [map, setMap] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    let alive = true;
    new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}earth.jpg`, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      if (alive) setMap(t);
    });
    return () => {
      alive = false;
    };
  }, []);
  const alpha = useMemo(beamAlpha, []);
  const earth = useRef<THREE.Mesh>(null!);
  const beamMat = useRef<THREE.MeshBasicMaterial>(null!);

  // orient a thin open cylinder along Sun -> Earth (continuous, linear beam)
  const beam = useMemo(() => {
    const dir = EARTH.clone().sub(SUN);
    const len = dir.length();
    const mid = SUN.clone().add(EARTH).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir.clone().normalize()
    );
    return { len, mid: mid.toArray() as [number, number, number], quat: q };
  }, []);

  useFrame((s, dt) => {
    const reduced = useStore.getState().reducedMotion;
    if (earth.current && !reduced) earth.current.rotation.y += dt * 0.04;
    if (beamMat.current)
      beamMat.current.opacity = 0.5 + 0.12 * Math.sin(s.clock.elapsedTime * 1.1);
  });

  return (
    <group visible={show}>
      {/* the Sun as a warm key on Earth's sun-facing edge... */}
      <pointLight position={[0, 0, 0]} intensity={110} distance={22} decay={2} color="#fff2d6" />
      {/* ...plus a soft daylight fill from the viewer side (directional, so it
          doesn't fall off with distance) to reveal the marble to the camera */}
      {crossingView && (
        <directionalLight position={[3, 2, 22]} intensity={2.8} color="#cadcf5" />
      )}

      {/* Earth — real NASA Blue Marble texture */}
      <mesh ref={earth} position={EARTH.toArray()} rotation={[0, -1.2, 0.35]}>
        <sphereGeometry args={[1.1, 64, 64]} />
        <meshStandardMaterial
          key={map ? "tex" : "notex"}
          map={map || undefined}
          color={map ? "#ffffff" : "#274b74"}
          roughness={0.9}
          metalness={0.02}
        />
      </mesh>
      {/* atmosphere rim */}
      <mesh position={EARTH.toArray()} scale={1.14}>
        <sphereGeometry args={[1.1, 32, 32]} />
        <meshBasicMaterial
          color="#7cc0ff"
          transparent
          opacity={0.14}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* continuous sunbeam Sun -> Earth (thin open cylinder, no hard caps) */}
      <mesh position={beam.mid} quaternion={beam.quat}>
        <cylinderGeometry args={[0.05, 0.05, beam.len, 12, 1, true]} />
        <meshBasicMaterial
          ref={beamMat}
          alphaMap={alpha}
          color="#ffe6b0"
          transparent
          opacity={0.55}
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
