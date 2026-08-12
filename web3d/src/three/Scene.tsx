import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import { useStore } from "../store";
import Sun from "./Sun";
import Heliograph from "./Heliograph";
import Dust from "./Dust";
import Beam from "./Beam";
import Room from "./Room";
import CameraRig from "./CameraRig";
import Effects from "./Effects";

// Single persistent Canvas for the whole film. Sections are state, never
// remounted. Quality tier drops adaptively on sustained frame loss.
export default function Scene() {
  const setQuality = useStore((s) => s.setQuality);
  const quality = useStore((s) => s.quality);
  // drop resolution before shader quality on weak GPUs (cheap global win)
  const dpr: [number, number] | number =
    quality === "high" ? [1, 2] : quality === "medium" ? 1.5 : 1;
  return (
    <Canvas
      className="canvas"
      dpr={dpr}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      camera={{ fov: 45, position: [0, 0, 7.2], near: 0.1, far: 100 }}
      onCreated={(state) => {
        state.gl.toneMapping = THREE.ACESFilmicToneMapping;
        state.gl.toneMappingExposure = 1.0;
        (window as unknown as { __three?: unknown }).__three = state;
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
        <Beam />
        <Dust />
        <Room />
      </Suspense>
      <CameraRig />
      <Effects />
    </Canvas>
  );
}
