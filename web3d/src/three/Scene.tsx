import { Suspense, useEffect } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { PerformanceMonitor, Preload } from "@react-three/drei";
import * as THREE from "three";
import { useStore } from "../store";
import Sun from "./Sun";
import Heliograph from "./Heliograph";
import SDOModel from "./SDOModel";
import Starfield from "./Starfield";
import Earth from "./Earth";
import SkyGround from "./SkyGround";
import Cabin from "./Cabin";
import Room from "./Room";
import Gallery from "./Gallery";
import CameraRig from "./CameraRig";
import Effects from "./Effects";

// Every shot in CameraRig is composed off-center for a landscape frame — the
// threshold deliberately puts the Sun on the lower-left third. three's `fov` is
// the VERTICAL angle, so on a 375x812 phone the horizontal field collapses to
// about 22 degrees and that off-center Sun simply falls off the left edge.
//
// Widen the vertical fov as the viewport gets narrower, which buys back
// horizontal room without touching a single composed control point. Capped,
// because full compensation would need ~116 degrees and the wide-angle
// distortion would cost more than the clipping does.
const BASE_FOV = 45;
const REF_ASPECT = 1.6; // the aspect these shots were framed for
// 1.45 still left the Sun's left limb clipped by a few px at 375x812; 1.65
// clears it with margin and is the most wide-angle the shot takes before the
// perspective starts to read as a fisheye.
const MAX_WIDEN = 1.65;

function ResponsiveFov() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const widen = THREE.MathUtils.clamp(REF_ASPECT / Math.max(aspect, 0.01), 1, MAX_WIDEN);
    camera.fov = BASE_FOV * widen;
    camera.updateProjectionMatrix();
  }, [camera, size]);
  return null;
}

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
      // antialias:false — the EffectComposer owns the final render, so the
      // canvas's own MSAA buffer was pure cost (composer output isn't
      // multisampled through it anyway).
      gl={{ antialias: false, powerPreference: "high-performance" }}
      camera={{ fov: 45, position: [0, 0, 7.2], near: 0.1, far: 260 }}
      onCreated={(state) => {
        state.gl.toneMapping = THREE.ACESFilmicToneMapping;
        state.gl.toneMappingExposure = 1.0;
        if (import.meta.env.DEV) (window as unknown as { __three?: unknown }).__three = state;
      }}
    >
      <color attach="background" args={["#05060a"]} />
      <ResponsiveFov />
      <PerformanceMonitor
        onDecline={() => setQuality("medium")}
        onFallback={() => setQuality("low")}
        flipflops={3}
      />
      <Suspense fallback={null}>
        <Sun />
        <Heliograph />
        <SDOModel />
        <Starfield />
        <Earth />
        <SkyGround />
        <Cabin />
        <Room />
        <Gallery />
        {/* Compile every material's GL program once at load (behind the
            loader), so late-mounting subtrees (Gallery at p>0.8, Room's
            shimmer/print shaders) don't pay their shader compile as a visible
            hitch mid-pan. visible=false skips traversal, so without this the
            early-mount hysteresis only moved the JS cost, not the compile. */}
        <Preload all />
      </Suspense>
      <CameraRig />
      <Effects />
    </Canvas>
  );
}
