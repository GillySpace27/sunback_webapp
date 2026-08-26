import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import Sun from "./Sun";
import Starfield from "./Starfield";
import { useStore } from "../store";
import { useEffect, useRef } from "react";

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

// Does this plate want the sky behind it?
//
// ?sky=1 says so explicitly, and that is what the print pipeline sends. But
// the store's handoff quad stopped sending it in 513fcb9, when a single sky
// toggle was replaced by six per-layer chips: the query became
// "&stars=1&con=1&planets=1&grid=1…" and the one param that MOUNTS the
// starfield quietly went missing. Every layer flag then arrived, was written
// into the store correctly, and had no component to act on — so the two
// Dimensional cells rendered a bare Sun on black for two days (Gilly,
// 2026-08-26).
//
// So the layers are now their own answer: ask for any of them and you get the
// sky that draws them. sky=1 still works and still wins, which keeps the
// print pipeline's existing calls intact, but nothing has to remember to send
// a second parameter that merely repeats what the first six already said.
const SKY = (() => {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search);
  if (q.get("sky") === "1") return true;
  return ["stars", "con", "art", "labels", "planets", "grid"].some(
    (k) => q.get(k) === "1"
  );
})();

export default function PlateScene() {
  // Shared with the film's Scene.tsx: lets the sky's planet labels occlude
  // against the disk when guide=1 is printed. See Sun.tsx.
  const sunDiskRef = useRef<THREE.Mesh | null>(null);
  // ?look=rhef selects the enhanced frame for the master. Read here rather than
  // in the renderer so the plate and the film share one code path.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const st = useStore.getState();
    // Identity comes from the URL so this view is SHAREABLE and reproducible:
    // the same link renders the same plate for the same Sun, which is what lets
    // it be a print master and a preview of one at the same time. `d`/`t` match
    // the deep-link params the store already uses, so a handoff link can be
    // turned into a plate link by adding plate=1.
    const d = q.get("d");
    if (d) st.setDate(d);
    // No setter: `time` is fixed at 12:00 in the store because the experience
    // has no per-day time picker yet. The plate still has to honour a time,
    // since the store's deep links carry one and the same instant must render.
    const t = q.get("t");
    if (t) useStore.setState({ time: t });
    const wl = q.get("ch");
    if (wl !== null && wl !== "") st.setChannel(Number(wl));
    if (q.get("rainbow") === "1") st.setRainbow(true);
    // guide= is the LEGACY single switch, and it must not overrule the six
    // per-layer params that replaced it. setSkyGuide writes both
    // showConstellations and showPlanets, so on a query carrying
    // "guide=1&con=0" it ran after App.tsx had already honoured con=0 and put
    // the lines straight back — unticking Constellations (or Planets) in the
    // handoff panel reloaded the plate with the right URL and changed nothing
    // on screen (Gilly, 2026-08-26). Explicit beats inherited: only fall back
    // to guide when the caller said nothing more specific.
    const LAYER_PARAMS = ["stars", "con", "art", "labels", "planets", "grid"];
    const explicitLayers = LAYER_PARAMS.some((k) => q.get(k) !== null);
    // explicit, never inherited from the film's opening demonstration
    if (!explicitLayers) st.setSkyGuide(q.get("guide") === "1");
    const look = q.get("look");
    // dimensional plates default to the enhanced frame, since that is what the
    // SKU is for; an explicit look= still wins
    if (look === "rhef" || look === "raw") st.setLook(look);
    else if (q.get("rainbow") !== "1") st.setLook("rhef");
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
        <Sun diskOccluderRef={sunDiskRef} />
        {/* The real sky, optionally, behind the Sun.
            This was cut from the master on the grounds that the stars were
            INVENTED — procedural, the same sky on every date — so printing them
            would have re-introduced exactly the fabricated light the corona
            work removed. That objection died when the starfield became the
            actual Yale catalogue rotated to the visitor's own date: these are
            the stars that were genuinely behind their Sun. It is now a real
            option rather than decoration, which is why the sky had to be
            correct before it could be printed. */}
        {SKY && <Starfield sunOccluderRef={sunDiskRef} />}
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
