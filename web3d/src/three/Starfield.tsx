import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Html } from "@react-three/drei";
import { useStore } from "../store";
import { PLANETS, PLANET_TINT, planetDirection } from "../lib/planets";

// The real sky behind the Sun on the visitor's date.
//
// Previously this was drei's procedural <Stars>: pleasant, but invented — the
// same sky for every date, which is the same non-diegetic problem the corona
// had. These are the 8,355 stars of the Yale Bright Star Catalogue down to
// V=6.5 (roughly the naked-eye limit), at their real J2000 positions, with
// size from visual magnitude and colour from B-V index. The catalogue is built
// once by tools/build-starfield.py and committed, so runtime has no external
// dependency.
//
// PARALLAX, honestly: real stars are effectively at infinite distance, so a
// camera moving 1 AU sees no stellar parallax at all. The depth motion here
// comes from placing the (correct) sky on a finite shell, which is a
// deliberate, disclosed stylisation — the same scale fiction the rest of the
// scene already runs on, where the Earth sits nine units from the Sun. What is
// real is every star's DIRECTION, magnitude and colour; what is stylised is the
// distance. That split is the honest version of "correct sky, with parallax".
const SHELL = 150;

type Star = [number, number, number, number, number]; // x,y,z (J2000), Vmag, B-V
type Segment = { c: string; p: number[] };            // constellation polyline

// USNO low-precision solar position. Validated against astropy's get_sun over
// 2010-2026: worst separation 22 arcmin, i.e. less than the Sun's own 32-arcmin
// disk. Ample for deciding which stars sit behind it; not an ephemeris.
function sunDirection(dateStr: string): THREE.Vector3 {
  const d = new Date(`${dateStr || "2015-01-01"}T12:00:00Z`);
  const jd = d.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const DEG = Math.PI / 180;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = (((357.528 + 0.9856003 * n) % 360) + 360) % 360 * DEG;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 3.6e-7 * n) * DEG;
  return new THREE.Vector3(
    Math.cos(lam),
    Math.cos(eps) * Math.sin(lam),
    Math.sin(eps) * Math.sin(lam)
  ).normalize();
}

// B-V colour index -> approximate stellar colour. Blue-white O/B stars through
// white A/F, yellow G, orange K, red M.
function bvColor(bv: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [-0.35, [0.61, 0.71, 1.0]],
    [0.0, [0.79, 0.86, 1.0]],
    [0.3, [1.0, 0.99, 0.98]],
    [0.6, [1.0, 0.94, 0.79]],
    [1.0, [1.0, 0.82, 0.62]],
    [1.6, [1.0, 0.68, 0.49]],
  ];
  const v = Math.max(-0.35, Math.min(1.6, bv));
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i];
    const [b, cb] = stops[i + 1];
    if (v <= b) {
      const t = (v - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
  }
  return stops[stops.length - 1][1];
}

const vert = /* glsl */ `
  attribute float aSize;
  attribute float aBright;
  attribute vec3 aColor;
  uniform float uDpr;
  varying vec3 vColor;
  varying float vBright;
  void main() {
    vColor = aColor;
    vBright = aBright;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // no distance attenuation: the shell is rigid, so a star's apparent size
    // should track its magnitude, not how far the camera drifted
    gl_PointSize = aSize * uDpr;
  }
`;
const frag = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vBright;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    // soft core + faint halo, so bright stars read as bright rather than big
    float a = pow(1.0 - r, 1.9) * vBright;
    gl_FragColor = vec4(vColor * a, a);
  }
`;

export default function Starfield() {
  const g = useRef<THREE.Group>(null);
  const uniforms = useMemo(
    () => ({ uDpr: { value: Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1) } }),
    []
  );
  const date = useStore((s) => s.date);
  const guide = useStore((s) => s.skyGuide);
  const [stars, setStars] = useState<Star[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}stars.json`)
      .then((r) => r.json())
      .then((j) => alive && setStars(j.stars as Star[]))
      .catch(() => {
        /* no sky is better than a fake one */
      });
    return () => { alive = false; };
  }, []);

  // Geometry is built ONCE, in the equatorial frame. The date does not move the
  // stars relative to each other — it changes which way we are looking — so it
  // belongs on the object's rotation, not in the vertex buffer. That also makes
  // the change animatable: see the slew in useFrame below.
  const geo = useMemo(() => {
    if (!stars) return null;
    const n = stars.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const siz = new Float32Array(n);
    const brt = new Float32Array(n);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const [x, y, z, mag, bv] = stars[i];
      v.set(x, y, z).multiplyScalar(SHELL);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = v.y;
      pos[i * 3 + 2] = v.z;
      const c = bvColor(bv);
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      // A raw flux law spans 30:1 from Sirius to a mag-6.5 star, which put
      // most of the catalogue under one pixel and left the sky looking empty.
      // Compressed to a linear-in-magnitude ramp: the ORDER and relative
      // spacing of brightnesses stay true, the dynamic range is exposed like a
      // long exposure rather than like the naked eye. Sizes are in framebuffer
      // pixels, so they carry dpr.
      siz[i] = THREE.MathUtils.clamp(1.5 + 1.15 * (6.5 - mag), 1.2, 11.0);
      brt[i] = THREE.MathUtils.clamp(0.42 + 0.58 * ((6.5 - mag) / 8.0), 0.34, 1.0);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    bg.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    bg.setAttribute("aSize", new THREE.BufferAttribute(siz, 1));
    bg.setAttribute("aBright", new THREE.BufferAttribute(brt, 1));
    return bg;
  }, [stars]);

  // Where the sky must end up for this date: the Sun's own direction rotated to
  // sit behind the Sun in the scene (the camera looks down -Z), with celestial
  // north toward screen up.
  const target = useMemo(() => {
    const f = sunDirection(date);
    const north = new THREE.Vector3(0, 0, 1);
    let right = new THREE.Vector3().crossVectors(north, f);
    if (right.lengthSq() < 1e-6) right = new THREE.Vector3(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(f, right).normalize();
    const negF = f.clone().multiplyScalar(-1);
    // x is NEGATED right. (right, up, -f) is left-handed — right x up = +f, so
    // its determinant is -1 and setFromRotationMatrix returns a non-rotation:
    // the Sun's own direction came out at (-0.24, 0.81, -0.05) instead of
    // (0,0,-1), and not even unit length. (-right, up, -f) is right-handed and
    // still puts celestial north on +Y.
    const negRight = right.clone().multiplyScalar(-1);
    const m = new THREE.Matrix4().makeBasis(negRight, up, negF).transpose();
    return new THREE.Quaternion().setFromRotationMatrix(m);
  }, [date]);

  const first = useRef(true);
  useFrame((_, dt) => {
    const el = g.current;
    if (!el) return;
    // belongs to the space beats; gone before the atmosphere flash
    el.visible = useStore.getState().progress < 0.51;
    if (first.current) {
      // the opening sky is simply correct — there is nothing to slew from
      el.quaternion.copy(target);
      first.current = false;
      return;
    }
    // Slew, do not snap. Changing the date can move the sky by half a celestial
    // sphere, and cutting between two orientations reads as a glitch where the
    // drift reads as the year turning. Frame-rate independent.
    el.quaternion.slerp(target, 1 - Math.exp(-dt / 1.6));
  });

  // Constellation figures, in the same frame as the stars so one rotation
  // registers both. Fetched lazily: nobody pays for them until they ask.
  const [segs, setSegs] = useState<Segment[] | null>(null);
  useEffect(() => {
    if (!guide || segs) return;
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}constellations.json`)
      .then((r) => r.json())
      .then((j) => alive && setSegs(j.segments as Segment[]))
      .catch(() => {});
    return () => { alive = false; };
  }, [guide, segs]);

  const lineGeo = useMemo(() => {
    if (!segs) return null;
    const pos: number[] = [];
    for (const seg of segs) {
      const p = seg.p;
      // polyline -> line segments, drawn just inside the star shell so the
      // figures never occlude the stars they connect
      for (let i = 0; i + 5 < p.length; i += 3) {
        pos.push(p[i] * SHELL * 0.99, p[i + 1] * SHELL * 0.99, p[i + 2] * SHELL * 0.99);
        pos.push(p[i + 3] * SHELL * 0.99, p[i + 4] * SHELL * 0.99, p[i + 5] * SHELL * 0.99);
      }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    return bg;
  }, [segs]);

  // The naked-eye planets, on the ecliptic where they actually are that day.
  const planets = useMemo(
    () =>
      PLANETS.map((name) => {
        const [x, y, z] = planetDirection(name, date);
        return { name, pos: new THREE.Vector3(x, y, z).multiplyScalar(SHELL * 0.97) };
      }),
    [date]
  );

  if (!geo) return null;
  return (
    <group ref={g}>
      <points geometry={geo} frustumCulled={false}>
        <shaderMaterial
          vertexShader={vert}
          fragmentShader={frag}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>

      {guide && lineGeo && (
        <lineSegments geometry={lineGeo} frustumCulled={false}>
          <lineBasicMaterial
            color="#7fa8d8"
            transparent
            opacity={0.34}
            depthWrite={false}
            toneMapped={false}
          />
        </lineSegments>
      )}

      {guide &&
        planets.map((pl) => (
          <group key={pl.name} position={pl.pos.toArray()}>
            <mesh>
              <sphereGeometry args={[SHELL * 0.006, 12, 12]} />
              <meshBasicMaterial color={PLANET_TINT[pl.name]} toneMapped={false} />
            </mesh>
            <Html center distanceFactor={SHELL * 0.9} wrapperClass="sky-html">
              <span className="planet-label">{pl.name}</span>
            </Html>
          </group>
        ))}

      {/* The click target for "the empty sky". A back-side sphere just inside
          the star shell: it sits behind everything, so anything nearer (the
          Sun, the corona quad, which stops propagation) is hit first and only
          genuinely empty sky reaches it. Invisible, but raycast. */}
      <mesh
        onClick={(e) => {
          if (useStore.getState().progress >= 0.51) return;
          e.stopPropagation();
          const st = useStore.getState();
          st.setSkyGuide(!st.skyGuide);
        }}
      >
        <sphereGeometry args={[SHELL * 0.995, 16, 16]} />
        <meshBasicMaterial side={THREE.BackSide} transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}
