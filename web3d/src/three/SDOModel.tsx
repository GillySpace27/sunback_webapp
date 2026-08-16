import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFrame, ThreeEvent } from "@react-three/fiber";
import { useGLTF, Html } from "@react-three/drei";
import * as THREE from "three";
import { useStore } from "../store";

// The real spacecraft that took the picture: a glTF of NASA's Solar Dynamics
// Observatory, parked bottom-right of the "select a color" wheel with its AIA
// telescopes aimed sunward. Hover names it; click opens the mission page.
// Model: "Solar Dynamics Observatory" by uperesito (CC BY). Self-hosted glb.
const URL = `${import.meta.env.BASE_URL}models/sdo.glb`;
const INFO_URL = "https://sdo.gsfc.nasa.gov/";
const SDO_POS = new THREE.Vector3(3.1, -2.15, 4.2);
const AIM_AT = SDO_POS.clone().multiplyScalar(2); // +Z (AIA cylinders) -> Sun (lookAt faces -Z)
const TARGET = 2.2; // largest dimension in world units (auto-fit handles native scale)

function SDO() {
  const { scene } = useGLTF(URL);
  const model = useMemo(() => {
    const s = scene.clone(true);
    s.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.material) {
        const mat = (m.material as THREE.Material).clone();
        mat.transparent = true;
        m.material = mat;
      }
    });
    return s;
  }, [scene]);
  // normalize native units/origin to a fixed size, centered on its bounding box
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const scale = TARGET / (Math.max(size.x, size.y, size.z) || 1);
    return { scale, offset: center.multiplyScalar(-scale) };
  }, [model]);
  const outer = useRef<THREE.Group>(null!);
  const inner = useRef<THREE.Group>(null!);
  const [hover, setHover] = useState(false);
  // materials collected once per model, so the per-frame opacity write doesn't
  // re-traverse the whole glTF scene graph every frame
  const mats = useRef<THREE.Material[]>([]);
  const lastFade = useRef(-1); // sentinel != 0 so the first frame always runs

  useEffect(() => {
    inner.current?.lookAt(AIM_AT); // aim the AIA cylinders (+Z face) at the Sun, once
  }, []);
  useEffect(() => {
    const found: THREE.Material[] = [];
    model.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m) found.push(m);
    });
    mats.current = found;
  }, [model]);
  useEffect(() => () => model.traverse((o) => (o as THREE.Mesh).geometry?.dispose?.()), [model]);

  useFrame(() => {
    const p = useStore.getState().progress;
    // present through the aperture beat (matches the wheel window), soft edges
    const fade = THREE.MathUtils.clamp(
      Math.min((p - 0.22) / 0.04, (0.4 - p) / 0.04),
      0,
      1
    );
    if (!outer.current) return;
    const visible = fade > 0.01;
    outer.current.visible = visible;
    // onPointerOut never fires once the group flips invisible (R3F still
    // raycasts it), so a lingering hover would float the tooltip and keep the
    // pointer cursor over every later scene; clear it here (same guard as
    // Heliograph's wheel)
    if (!visible && hover) {
      setHover(false);
      document.body.style.cursor = "auto";
    }
    // SDO is only on screen for ~18% of the scroll; skip the material walk
    // once fade has already settled at zero, so the other ~78% costs nothing
    if (fade === 0 && lastFade.current === 0) return;
    for (const m of mats.current) m.opacity = fade;
    lastFade.current = fade;
  });

  const enter = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHover(true);
    document.body.style.cursor = "pointer";
  };
  const leave = () => {
    setHover(false);
    document.body.style.cursor = "auto";
  };
  const open = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    window.open(INFO_URL, "_blank", "noopener,noreferrer");
  };

  return (
    <group ref={outer} position={SDO_POS.toArray()} visible={false}>
      <ambientLight intensity={0.7} color="#cfe0ff" />
      <pointLight position={[1.5, 1.2, 3]} intensity={40} distance={30} color="#fff2d6" />
      <group ref={inner} onPointerOver={enter} onPointerOut={leave} onClick={open}>
        <group scale={fit.scale} position={fit.offset.toArray()}>
          <primitive object={model} />
        </group>
      </group>
      {hover && (
        <Html position={[0, 1.6, 0]} center distanceFactor={10} zIndexRange={[20, 0]} wrapperClass="sdo-html">
          <div className="sdo-tip" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
            <span className="sdo-tip-name">NASA Solar Dynamics Observatory</span>
            <a href={INFO_URL} target="_blank" rel="noopener noreferrer" className="sdo-tip-link">
              About the mission ↗
            </a>
          </div>
        </Html>
      )}
    </group>
  );
}

// Local boundary: if the glb is missing/unfetchable, render nothing rather than
// taking down the whole scene (Scene's Suspense/ErrorBoundary is shared).
class Guard extends Component<{ children: ReactNode }, { dead: boolean }> {
  state = { dead: false };
  static getDerivedStateFromError() {
    return { dead: true };
  }
  render() {
    return this.state.dead ? null : this.props.children;
  }
}

export default function SDOModel() {
  return (
    <Guard>
      <Suspense fallback={null}>
        <SDO />
      </Suspense>
    </Guard>
  );
}
