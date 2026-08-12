import { RenderTexture, PerspectiveCamera } from "@react-three/drei";
import Sun from "./Sun";
import { useStore } from "../store";

// The landing. A warm interior with the finished piece on the wall: a framed
// print whose image is a live render of the Sun at the chosen wavelength
// (render-to-texture). This is where cosmic collapses to domestic — the climax.
// Sits far down -Z; the camera flies here after the aperture.
const Z = -40;

export default function Room() {
  // Only render the (expensive) live print once the room is being approached.
  // Mounts during the aperture so the shader compiles while it is still
  // off-screen, then holds for the darkroom/room/gift climax.
  const showPrint = useStore((s) => s.progress > 0.5);

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

      {/* frame + mat + print (a portrait piece) */}
      <group>
        <mesh position={[0, 0, -0.02]}>
          <planeGeometry args={[2.62, 3.52]} />
          <meshStandardMaterial color="#0f0b08" roughness={0.6} metalness={0.1} />
        </mesh>
        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[2.3, 3.2]} />
          <meshStandardMaterial color="#efe9dc" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.05, 0.01]}>
          <planeGeometry args={[1.95, 2.75]} />
          {/* the print is self-lit: it shows their Sun, full disc with margin */}
          <meshBasicMaterial color={showPrint ? "#ffffff" : "#1a120c"}>
            {showPrint && (
              <RenderTexture attach="map" width={384} height={540}>
                <color attach="background" args={["#050307"]} />
                {/* manual aspect to match the portrait FBO so the disc stays round */}
                <PerspectiveCamera
                  makeDefault
                  manual
                  position={[0, 0, 11]}
                  fov={42}
                  aspect={384 / 540}
                  near={0.1}
                  far={40}
                />
                <Sun />
              </RenderTexture>
            )}
          </meshBasicMaterial>
        </mesh>
      </group>
    </group>
  );
}
