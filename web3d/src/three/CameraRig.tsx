import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore, spaceAt, SpaceKey, SPACES } from "../store";

// Camera scrubs a spline through the nine spaces, one control point per space.
// Composition is deliberately off-center at the threshold (the Sun sits on a
// third, black breathing above); the path then flies from the Sun at the origin
// down to the Room far along -Z, so the light literally travels to the wall.
// Sun at origin; Earth at (3,-2,9) and the home at (2.5,-2.5,13) — both on the
// VIEWER side (+Z). The camera pulls back toward the viewer to reveal Earth,
// then settles into the home: "coming back to Earth, where I am", never diving
// behind the Sun.
const POS: [number, number, number][] = [
  [1.5, 0.95, 9.0], // threshold — larger Sun, pulled toward center-left to close the dead gulf under the headline
  [0, 0, 3.0], // surface — push in, awe
  [0, 0, 7.4], // aperture — pull back so the wheel reads as a full ring, clear of the title
  [3.0, -1.2, 34.0], // crossing — pulled back toward the viewer: Sun small+far, Earth near, beam
  [5.5, -5.9, 42.0], // sky — standing back in the field, the whole log cabin in view
  [4.3, -6.75, 28.5], // darkroom — dolly right up to the cabin's warm, lit window
  [5.2, -6.4, 25.5], // room — just inside the (dissolved) window, a proper viewing distance from the print
  [5.45, -6.35, 26.6], // gift — settle, still on the ground floor
  [11.5, -6.2, 31.5], // gallery — pull back to fit the whole product display (frames + object shelf)
];
const TGT: [number, number, number][] = [
  [0.72, 0.46, 0], // sun sits on the lower-left third, but nearer center so it and the headline read as one composition
  [0, 0, 0],
  [0, 0, 0], // aperture — the wheel around the Sun
  [5.7, -3.8, 17], // crossing — frame Earth's sun-facing limb (where we descend), Sun off to the side
  [5.4, -6.7, 24.6], // sky — the cabin sitting in the field, mountains behind
  [4.2, -6.9, 24.6], // darkroom — the glowing window we zoom into
  [6.3, -6.8, 22], // room — the print on the wall where the light lands
  [6.3, -6.75, 22], // gift
  [12.0, -7.1, 21.6], // gallery — look slightly down so the object shelf sits in frame below the wall art
];

const REACT: Record<SpaceKey, number> = {
  threshold: 0.3,
  surface: 0.4,
  crossing: 0.1,
  aperture: 0.18, // keep the wheel centered/stable, not drifting with the cursor
  sky: 0.15, // a gentle up-look; too much parallax here reads as a wobble
  darkroom: 0.3,
  room: 0.5,
  gift: 0.4,
  gallery: 0.35,
};

const smooth = (f: number) => f * f * (3 - 2 * f); // cine dwell: slow at both ends

// Remap raw scroll into an eased curve parameter that HOLDS at each space and
// moves quickly between them — film cutting, not linear scrubbing.
function easedParam(progress: number) {
  const n = SPACES.length; // one control point per space
  let i = 0;
  for (let k = 0; k < n; k++) if (progress >= SPACES[k].start) i = k;
  if (i >= n - 1) return 1;
  const start = SPACES[i].start;
  const end = SPACES[i + 1].start;
  const f = THREE.MathUtils.clamp((progress - start) / (end - start), 0, 1);
  return (i + smooth(f)) / (n - 1);
}

export default function CameraRig() {
  const posCurve = useMemo(() => {
    const c = new THREE.CatmullRomCurve3(POS.map((p) => new THREE.Vector3(...p)));
    c.curveType = "centripetal"; // no overshoot across the big Sun->Room jump
    return c;
  }, []);
  const tgtCurve = useMemo(() => {
    const c = new THREE.CatmullRomCurve3(TGT.map((p) => new THREE.Vector3(...p)));
    c.curveType = "centripetal";
    return c;
  }, []);
  const pos = useRef(new THREE.Vector3(...POS[0]));
  const tgt = useRef(new THREE.Vector3(...TGT[0]));
  const parallax = useRef(new THREE.Vector2());
  const scratch = useRef(new THREE.Vector3());

  useFrame((state, dt) => {
    const { progress, reducedMotion } = useStore.getState();
    const t = easedParam(progress);
    posCurve.getPoint(t, pos.current);
    tgtCurve.getPoint(t, tgt.current);

    const gate = reducedMotion ? 0 : REACT[spaceAt(progress)];
    // dt-corrected ease (was a fixed 0.05/frame lerp, tied to frame rate); τ≈0.32
    // matches the old 60fps feel while staying correct at any frame rate.
    const aParallax = 1 - Math.exp(-dt / 0.32);
    parallax.current.x += (state.pointer.x * gate - parallax.current.x) * aParallax;
    parallax.current.y += (state.pointer.y * gate - parallax.current.y) * aParallax;

    const cam = state.camera;
    scratch.current.copy(pos.current);
    scratch.current.x += parallax.current.x * 0.5;
    scratch.current.y += parallax.current.y * 0.35;
    // reduced motion: snap (no inertial glide); otherwise damped follow.
    // dt-corrected ease (was a fixed 0.1/frame lerp: ~22 frames to converge
    // regardless of frame rate, so a fast scroll flick left the camera far
    // behind the spline target until the user scrolled back). τ≈0.15.
    const aPos = 1 - Math.exp(-dt / 0.15);
    cam.position.lerp(scratch.current, reducedMotion ? 1 : aPos);
    cam.lookAt(tgt.current);
  });

  return null;
}
