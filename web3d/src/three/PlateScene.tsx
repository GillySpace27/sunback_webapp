import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import Sun from "./Sun";
import { useStore } from "../store";
import { useEffect } from "react";

// The print master for the "Dimensional" SKU.
//
// Deliberately NOT a screenshot of the film. Three things make the film frame
// the wrong product: the starfield is non-diegetic (those are not the real
// stars for that date or that viewing geometry, and we just finished removing
// invented light from the corona for exactly that reason), tiny white dots on
// a black ground are where printer dithering does its worst work, and no 16:9
// frame survives a crop from 2:3 poster to 7:3 mug wrap.
//
// So: the same Sun, through the SAME shaders as the film — that identity is the
// whole point, it is what makes the render a soft proof rather than an advert
// for a different object — composed square, on a clean ground, with margin
// sized so the disk plus corona survives the widest crop the catalogue sells.
// api/main.py::_crop_to_aspect then frames it per product, the same way every
// other product is already framed. One master, every SKU.

// The Sun's disk is radius 1.6 and its corona reaches 1.6/0.31 ~= 5.16 across.
// A 7:3 mug wrap keeps only ~43% of a square's height-equivalent width, so the
// subject has to sit well inside the frame. At this camera distance the corona
// spans roughly half the frame, which survives every aspect in the catalogue.
const PLATE_CAMERA_Z = 9.4;

export default function PlateScene() {
  // ?look=rhef selects the enhanced frame for the master. Read here rather than
  // in the renderer so the plate and the film share one code path.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const look = q.get("look");
    if (look === "rhef" || look === "raw") useStore.getState().setLook(look);
    const wl = q.get("ch");
    if (wl !== null && wl !== "") useStore.getState().setChannel(Number(wl));
  }, []);
  return (
    <Canvas
      className="canvas"
      // Fixed dpr: a print master must not vary with the rendering machine.
      // Resolution comes from the viewport the renderer is driven at.
      dpr={1}
      gl={{ antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true }}
      camera={{ fov: 45, position: [0, 0, PLATE_CAMERA_Z], near: 0.1, far: 260 }}
      onCreated={(state) => {
        state.gl.toneMapping = THREE.ACESFilmicToneMapping;
        state.gl.toneMappingExposure = 1.0;
      }}
    >
      {/* the store's ground, not the film's void: no stars, flat enough to
          print without banding */}
      <color attach="background" args={["#0a0908"]} />
      <Suspense fallback={null}>
        <Sun />
      </Suspense>
      <EffectComposer multisampling={0}>
        {/* Bloom stays: the corona's above-1.0 values are what become glow, and
            without it the plate loses the light the film promised. */}
        {/* Threshold 0.55, not 0.2: RHEF equalises the corona to near-disk
            brightness, so a low threshold bloomed the ENTIRE corona and turned
            sharp radial plumes into a soft symmetric halo. Bloom is a camera
            effect; letting it run over data is how diegetic structure starts
            reading as an effect. Now only genuine highlights bloom. */}
        <Bloom intensity={0.45} luminanceThreshold={0.55} luminanceSmoothing={0.9} mipmapBlur />
      </EffectComposer>
    </Canvas>
  );
}
