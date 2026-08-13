import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// Earth, out in the dark, lit by the Sun. After you choose the light at the Sun,
// the camera pulls back TOWARD the viewer and sunlight streams across to a real
// blue marble, then settles into a home. Positioned on the viewer side (+Z) so
// the journey reads as "coming back to Earth, where I am".
const SUN = new THREE.Vector3(0, 0, 0);
// Earth sits ~twice as far from the Sun as the home cluster used to, so the
// beam reads as a long crossing (the Sun small and far), not a near neighbor.
const EARTH = new THREE.Vector3(6, -4, 18);
const EARTH_R = 0.95; // a smidge smaller than before
const COLO_Y = -0.05; // base yaw so North America (~Colorado) faces the camera on entry
// unit vector Earth -> Sun; we descend onto the SUN-FACING limb (the lit,
// atmosphere-glowing edge) rather than the disk center, which is usually ocean
const TO_SUN = SUN.clone().sub(EARTH).normalize();

// A soft light shaft baked as a feathered CONE: narrow + bright at the Sun (top),
// spreading + softening toward Earth (bottom). No streaks or rings — on an
// additive, camera-facing billboard this reads as a volume of light, not a tube.
function godRays() {
  const S = 256;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, S, S);
  g.filter = "blur(14px)"; // feather every edge so there's no hard silhouette
  // cone: apex near the top (Sun), mouth at the bottom (Earth)
  const topHalf = S * 0.06;
  const botHalf = S * 0.42;
  g.beginPath();
  g.moveTo(S / 2 - topHalf, S * 0.04);
  g.lineTo(S / 2 + topHalf, S * 0.04);
  g.lineTo(S / 2 + botHalf, S * 0.98);
  g.lineTo(S / 2 - botHalf, S * 0.98);
  g.closePath();
  const vg = g.createLinearGradient(0, 0, 0, S);
  vg.addColorStop(0, "rgba(255,247,224,0.95)"); // bright at the Sun
  vg.addColorStop(0.55, "rgba(255,244,214,0.5)");
  vg.addColorStop(1, "rgba(255,240,206,0.0)"); // dissolves onto Earth
  g.fillStyle = vg;
  g.fill();
  g.filter = "none";
  const t = new THREE.CanvasTexture(c);
  return t;
}

export default function Earth() {
  // the space vista (Earth + god-ray) lives in the crossing beat; it DISSOLVES
  // as we descend so the Earth never floats in the daytime sky during the handoff
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
  const rays = useMemo(godRays, []);
  const grp = useRef<THREE.Group>(null!);
  const earth = useRef<THREE.Mesh>(null!);
  const atmo = useRef<THREE.Mesh>(null!);
  const earthMat = useRef<THREE.MeshStandardMaterial>(null!);
  const atmoMat = useRef<THREE.MeshBasicMaterial>(null!);
  const beamMat = useRef<THREE.MeshBasicMaterial>(null!);

  // a light shaft that NARROWS at the Sun and SPREADS onto Earth (sunlight
  // streaming down), landing on the sun-facing point of the disk
  const beamRef = useRef<THREE.Mesh>(null!);
  const beam = useMemo(() => {
    const spot = EARTH.clone().add(SUN.clone().sub(EARTH).normalize().multiplyScalar(EARTH_R * 1.05));
    const dir = spot.clone().sub(SUN); // Sun -> spot
    const len = dir.length();
    const mid = SUN.clone().add(spot).multiplyScalar(0.5);
    return {
      len,
      width: 2.6,
      mid: mid.toArray() as [number, number, number],
      up: SUN.clone().sub(spot).normalize(), // plane +Y points back to the Sun (cone apex)
      spot: spot.toArray() as [number, number, number],
    };
  }, []);
  // scratch vectors for the per-frame billboard basis (no per-frame allocs)
  const bY = useRef(new THREE.Vector3());
  const bZ = useRef(new THREE.Vector3());
  const bX = useRef(new THREE.Vector3());
  const bMid = useRef(new THREE.Vector3(...beam.mid));
  const bMat = useRef(new THREE.Matrix4());

  useFrame((s) => {
    const { reducedMotion: reduced, progress: p } = useStore.getState();
    // appear at the crossing; stay solid and GROW as we dive onto it (descended
    // upon, not faded in the sky). Hidden under the atmosphere flash once it has
    // rushed up to fill the frame.
    const appear = THREE.MathUtils.clamp((p - 0.35) / 0.04, 0, 1);
    // Earth (the planet) must be GONE before the ground (its surface) appears —
    // they're the same object, so never co-visible. It fills the frame and is
    // cut at 0.515, under the opaque atmosphere flash that bridges the handoff.
    const visible = appear > 0.01 && p < 0.515;
    if (grp.current) grp.current.visible = visible;
    if (!visible) return;
    // deterministic spin so the disk reliably ENTERS with North America (Colorado)
    // facing the viewer, then drifts slowly; COLO_Y tuned so ~105°W faces camera.
    // The spin is scroll-linked (not autonomous), so it's fine under reduced
    // motion; the only autonomous motion here is the beam flicker, gated below.
    if (earth.current)
      earth.current.rotation.set(0, COLO_Y + THREE.MathUtils.smoothstep(p, 0.35, 0.53) * 0.35, 0.35);
    // grow ~6.5x through the dive so the disk rushes up like a planet approached
    // and FILLS the frame by 0.515 (so the flash covers solid Earth, not a gap),
    // pivoting on the sun-facing limb so THAT lit edge is what we descend into
    const grow = 1 + THREE.MathUtils.smoothstep(p, 0.44, 0.515) * 5.5;
    const shift = EARTH_R * (1 - grow); // negative for grow>1 => moves away from Sun
    // ENTER from screen-right: slide in along +x rather than fading in place
    const slideX = (1 - THREE.MathUtils.smoothstep(p, 0.35, 0.42)) * 16;
    if (earth.current) {
      earth.current.scale.setScalar(grow);
      earth.current.position.copy(EARTH).addScaledVector(TO_SUN, shift);
      earth.current.position.x += slideX;
    }
    if (atmo.current) {
      // 1.08, not 1.14: a tighter rim reads as soft atmospheric scatter rather
      // than a hard blue ring around the limb (award-review finding).
      atmo.current.scale.setScalar(grow * 1.08);
      atmo.current.position.copy(EARTH).addScaledVector(TO_SUN, shift);
      atmo.current.position.x += slideX;
    }
    // opaque quickly so it reads as a body sliding in, not a cross-fade
    if (earthMat.current) earthMat.current.opacity = THREE.MathUtils.clamp((p - 0.35) / 0.02, 0, 1);
    // atmosphere rim brightens as we enter it
    const enter = THREE.MathUtils.smoothstep(p, 0.48, 0.53);
    if (atmoMat.current) atmoMat.current.opacity = (0.1 + 0.32 * enter) * appear;
    // beam belongs to the FAR crossing; it lights up only AFTER Earth has slid
    // into place (~0.41) so it never points at empty space, and is gone before the dive
    const beamFade = THREE.MathUtils.clamp(Math.min((p - 0.41) / 0.02, (0.47 - p) / 0.02), 0, 1);
    if (beamMat.current) {
      // reduced motion: hold a steady beam (no autonomous flicker)
      const flicker = reduced ? 0 : 0.08 * Math.sin(s.clock.elapsedTime * 1.1);
      beamMat.current.opacity = (0.7 + flicker) * beamFade;
    }
    // billboard the shaft around the Sun->Earth axis so it always faces the
    // camera edge-on and reads as soft light, never a tube silhouette
    if (beamRef.current && beamFade > 0.001) {
      bY.current.copy(beam.up); // +Y toward the Sun (cone apex)
      bZ.current.copy(s.camera.position).sub(bMid.current);
      bZ.current.addScaledVector(bY.current, -bZ.current.dot(bY.current)).normalize();
      bX.current.crossVectors(bY.current, bZ.current).normalize();
      bMat.current.makeBasis(bX.current, bY.current, bZ.current);
      beamRef.current.quaternion.setFromRotationMatrix(bMat.current);
    }
  });

  return (
    <group ref={grp}>
      <pointLight position={[0, 0, 0]} intensity={110} distance={26} decay={2} color="#fff2d6" />
      <directionalLight position={[6, 2, 26]} intensity={2.8} color="#cadcf5" />

      {/* Earth — real NASA Blue Marble texture */}
      <mesh ref={earth} position={EARTH.toArray()} rotation={[0, -1.2, 0.35]}>
        <sphereGeometry args={[EARTH_R, 64, 64]} />
        <meshStandardMaterial
          ref={earthMat}
          key={map ? "tex" : "notex"}
          map={map || undefined}
          color={map ? "#ffffff" : "#274b74"}
          roughness={0.9}
          metalness={0.02}
          transparent
        />
      </mesh>
      {/* atmosphere rim */}
      <mesh ref={atmo} position={EARTH.toArray()} scale={1.08}>
        <sphereGeometry args={[EARTH_R, 48, 48]} />
        <meshBasicMaterial
          ref={atmoMat}
          color="#7cc0ff"
          transparent
          opacity={0.14}
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* sunlight streaming down: a soft, camera-facing shaft (billboarded in the
          frame loop), narrow + bright at the Sun, spreading onto Earth */}
      <mesh ref={beamRef} position={beam.mid}>
        <planeGeometry args={[beam.width, beam.len]} />
        <meshBasicMaterial
          ref={beamMat}
          map={rays}
          color="#fff2d8"
          transparent
          opacity={0.85}
          depthWrite={false}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
