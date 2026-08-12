import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore, spaceAt, SpaceKey } from "../store";

// Camera scrubs a spline through the seven spaces (position + look target),
// with heavily damped cursor parallax gated per space. Motion is motivated:
// the camera only moves because the light moves.
const POS: [number, number, number][] = [
  [0, 0, 7.2], // threshold — small sun, far
  [0, 0, 3.1], // surface — push in
  [0.6, 0.4, 10.5], // crossing — pull back into the void
  [0, 0, 5.2], // aperture — face the filter wheel
  [0.1, -0.5, 3.3], // darkroom — close, low
  [0.7, 1.1, 6.4], // room — crane up and back
  [0.5, 0.7, 6.6], // gift — settle
];
const TGT: [number, number, number][] = [
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, -0.2, 0],
  [0, 0.2, 0],
  [0, 0.1, 0],
];

// per-space cursor reactivity (0..1)
const REACT: Record<SpaceKey, number> = {
  threshold: 0.3,
  surface: 0.4,
  crossing: 0.1,
  aperture: 0.8,
  darkroom: 0.3,
  room: 0.5,
  gift: 0.4,
};

export default function CameraRig() {
  const posCurve = useMemo(
    () => new THREE.CatmullRomCurve3(POS.map((p) => new THREE.Vector3(...p))),
    []
  );
  const tgtCurve = useMemo(
    () => new THREE.CatmullRomCurve3(TGT.map((p) => new THREE.Vector3(...p))),
    []
  );
  const pos = useRef(new THREE.Vector3(...POS[0]));
  const tgt = useRef(new THREE.Vector3(...TGT[0]));
  const parallax = useRef(new THREE.Vector2());

  useFrame((state) => {
    const { progress, reducedMotion } = useStore.getState();
    posCurve.getPoint(progress, pos.current);
    tgtCurve.getPoint(progress, tgt.current);

    // cursor parallax: damped, gated by space, off under reduced motion
    const gate = reducedMotion ? 0 : REACT[spaceAt(progress)];
    parallax.current.x += (state.pointer.x * gate - parallax.current.x) * 0.05;
    parallax.current.y += (state.pointer.y * gate - parallax.current.y) * 0.05;

    const cam = state.camera;
    cam.position.lerp(
      pos.current
        .clone()
        .add(new THREE.Vector3(parallax.current.x * 0.5, parallax.current.y * 0.35, 0)),
      0.12
    );
    cam.lookAt(tgt.current);
  });

  return null;
}
