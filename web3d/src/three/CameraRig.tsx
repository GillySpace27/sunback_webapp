import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore, spaceAt, SpaceKey, SPACES } from "../store";

// Camera scrubs a spline through the seven spaces, one control point per space.
// Composition is deliberately off-center at the threshold (the Sun sits on a
// third, black breathing above); the path then flies from the Sun at the origin
// down to the Room far along -Z, so the light literally travels to the wall.
// Sun at origin; Earth at (5,-2,-8); the home interior around (1.7,-1,-33).
// The path arcs OUT past the Sun to Earth and down to the home — it never
// dives through the Sun.
const POS: [number, number, number][] = [
  [2.0, 1.2, 10.6], // threshold — small Sun, lower-left third
  [0, 0, 3.0], // surface — push in, awe
  [0, 0, 6.6], // aperture — pull back so the filter wheel reads as a full ring
  [-2.5, 2.2, 12.0], // crossing — pulled back: Sun small + Earth lit by a sunbeam
  [4.6, -1.2, -3.0], // darkroom — arc past the Sun, descend toward Earth
  [2.0, -0.4, -25.5], // room — inside the home: window (Sun outside) + print
  [2.1, -0.5, -25.8], // gift — settle
];
const TGT: [number, number, number][] = [
  [1.05, 0.68, 0], // sun pushed to lower-left of frame
  [0, 0, 0],
  [0, 0, 0], // aperture — the wheel around the Sun
  [2.2, -1.0, -4.0], // crossing — frame the Sun/Earth vista
  [5, -2, -8], // darkroom — Earth
  [1.7, -1.2, -33], // room — between the window and the print
  [1.7, -1.1, -33], // gift
];

const REACT: Record<SpaceKey, number> = {
  threshold: 0.3,
  surface: 0.4,
  crossing: 0.1,
  aperture: 0.8,
  darkroom: 0.3,
  room: 0.5,
  gift: 0.4,
};

const smooth = (f: number) => f * f * (3 - 2 * f); // cine dwell: slow at both ends

// Remap raw scroll into an eased curve parameter that HOLDS at each space and
// moves quickly between them — film cutting, not linear scrubbing.
function easedParam(progress: number) {
  const n = SPACES.length; // 7 points
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

  useFrame((state) => {
    const { progress, reducedMotion } = useStore.getState();
    const t = easedParam(progress);
    posCurve.getPoint(t, pos.current);
    tgtCurve.getPoint(t, tgt.current);

    const gate = reducedMotion ? 0 : REACT[spaceAt(progress)];
    parallax.current.x += (state.pointer.x * gate - parallax.current.x) * 0.05;
    parallax.current.y += (state.pointer.y * gate - parallax.current.y) * 0.05;

    const cam = state.camera;
    scratch.current.copy(pos.current);
    scratch.current.x += parallax.current.x * 0.5;
    scratch.current.y += parallax.current.y * 0.35;
    // reduced motion: snap (no inertial glide); otherwise damped follow
    cam.position.lerp(scratch.current, reducedMotion ? 1 : 0.1);
    cam.lookAt(tgt.current);
  });

  return null;
}
