import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { useSunTexture } from "../hooks/useSunTexture";

// The landing. A warm interior with the finished piece on the wall: a framed
// print of the real SDO/AIA disk for the chosen date + wavelength (the same
// Helioviewer image the 3D Sun uses, shown flat as a photo). This is where
// cosmic collapses to domestic — the climax. Sits far down -Z; the camera
// flies here after the aperture.
const Z = -40;

export default function Room() {
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const channel = useStore((s) => s.channel);
  const near = useStore((s) => s.progress > 0.5); // only fetch once approaching
  // shares the Sun's cached texture (same url) — no extra request
  const tex = useSunTexture(date, time, CHANNELS[channel].angstrom);
  const showPrint = near && !!tex;

  return (
    <group position={[0, 0, Z]}>
      {/* warm tungsten room light */}
      <ambientLight intensity={0.5} color="#ffe0bf" />
      <directionalLight position={[6, 7, 8]} intensity={1.9} color="#ffd2a0" />
      <pointLight position={[-4, 2, 6]} intensity={22} distance={34} color="#ffb877" />

      {/* back wall, warm */}
      <mesh position={[0, 0, -0.4]}>
        <planeGeometry args={[60, 36]} />
        <meshStandardMaterial color="#3c2a1c" roughness={1} />
      </mesh>

      {/* frame + mat + the printed photo (square, disk centered) */}
      <group>
        <mesh position={[0, 0, -0.02]}>
          <planeGeometry args={[2.98, 2.98]} />
          <meshStandardMaterial color="#0f0b08" roughness={0.6} metalness={0.1} />
        </mesh>
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[2.72, 2.72]} />
          <meshStandardMaterial color="#efe9dc" roughness={0.9} />
        </mesh>
        {/* dark base under the print */}
        <mesh position={[0, 0, 0.01]}>
          <planeGeometry args={[2.4, 2.4]} />
          <meshBasicMaterial color="#0b0705" toneMapped={false} />
        </mesh>
        {/* the printed photo — mounted fresh once the JPG is ready so the
            material compiles WITH the map (setting map= late on an existing
            basic material doesn't recompile and renders flat). Dimmed a touch
            so the bright disk reads as a print, not a lamp that blooms out. */}
        {showPrint && (
          <mesh position={[0, 0, 0.02]}>
            <planeGeometry args={[2.4, 2.4]} />
            <meshBasicMaterial map={tex} color="#c2c2c2" toneMapped={false} />
          </mesh>
        )}
      </group>
    </group>
  );
}
