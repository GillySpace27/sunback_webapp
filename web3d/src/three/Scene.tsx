import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import { useStore } from "../store";
import Sun from "./Sun";
import Heliograph from "./Heliograph";
import Dust from "./Dust";
import CameraRig from "./CameraRig";
import Effects from "./Effects";

// Single persistent Canvas for the whole film. Sections are state, never
// remounted. Quality tier drops adaptively on sustained frame loss.
export default function Scene() {
  const setQuality = useStore((s) => s.setQuality);
  return (
    <Canvas
      className="canvas"
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: 45, position: [0, 0, 7.2], near: 0.1, far: 100 }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.0;
      }}
    >
      <color attach="background" args={["#05060a"]} />
      <PerformanceMonitor
        onDecline={() => setQuality("medium")}
        onFallback={() => setQuality("low")}
        flipflops={3}
      />
      <Suspense fallback={null}>
        <Sun />
        <Heliograph />
        <Dust />
      </Suspense>
      <CameraRig />
      <Effects />
    </Canvas>
  );
}
