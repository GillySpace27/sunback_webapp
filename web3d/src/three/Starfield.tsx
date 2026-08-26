import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Line } from "@react-three/drei";
import { useStore, skyGuideOn } from "../store";
import { PLANETS, PLANET_TINT, planetDirection } from "../lib/planets";
import SkyGrid from "./SkyGrid";

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
// The framebuffer height the star point-sizes below were tuned against.
const REF_H = 900;

// Plate mode renders a print master, so nothing here may depend on elapsed time.
const PLATE =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("plate") === "1";

type Star = [number, number, number, number, number]; // x,y,z (J2000), Vmag, B-V
type Segment = { c: string; p: number[] };            // constellation polyline
type NamedConstellation = { c: string; name: string; zodiac: boolean; p: [number, number, number] };
type ArtPlate = { file: string; plate: string; c: string[]; p: [number, number, number]; r: number };

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

// Urania's Mirror plates composite onto a NIGHT SKY, which they were never
// drawn for: they are dark ink on pale paper, so blitting one as-is puts a
// bright cream rectangle over the stars. This keys the paper out by luminance
// — alpha rises as the pixel darkens — so the engraved figure survives and the
// page it was printed on does not. The card is otherwise untouched: no
// cropping, no per-constellation extraction (Gilly, 2026-08-24).
const artVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const artFrag = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform float uOpacity;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    float lum = dot(t.rgb, vec3(0.299, 0.587, 0.114));
    // Paper sits high (~0.85-1.0); ink and colour sit below. Smoothstep gives
    // a soft key so the engraving's fine hatching does not alias into a hard
    // cutout, and the top end is pushed to 0.97 so the faintest tint still
    // reads rather than vanishing with the page.
    // Paper must reach EXACTLY zero, not merely low. The first version keyed
    // with smoothstep(0.45, 0.97): at the scans' paper luminance (~0.9) that
    // still passed ~13% alpha, and with 33 plates tiling the whole sphere the
    // residue stacked into grey slabs that buried the stars. Measured on dev
    // 2026-08-24. The window now closes at 0.78, comfortably below paper and
    // above the darkest coloured washes.
    float ink = 1.0 - smoothstep(0.34, 0.78, lum);
    ink = ink * ink;                       // steepen: hatching reads, haze does not
    // The figures are dark ink on light paper being shown against a BLACK sky,
    // so the card's own value cannot be used directly — it would draw the
    // figure darker than the background it sits on. Ink density drives alpha
    // and the colour is a cool parchment tint, which keeps the engraving
    // legible and stops 33 plates from turning the sky into a collage.
    vec3 col = mix(vec3(0.58, 0.66, 0.86), t.rgb + vec3(0.35), 0.35);
    // Feather the plate's own edge. Each card is a printed rectangle with a
    // ruled border, and that border is dark — i.e. maximum ink — so without
    // this every plate reads as a picture frame hanging in space, which is
    // exactly the "cards floating in the sky" look the layer is trying not to
    // have. Falls off over the outer ~12% so the figure survives and the
    // furniture around it does not.
    // 0.22, was 0.12. Each card's ruled border is the DARKEST ink on it, so
    // a narrow feather left every plate outlined like a hung picture; the
    // wider falloff dissolves the furniture and keeps the figure.
    vec2 e = min(vUv, 1.0 - vUv) / 0.22;
    float edge = clamp(min(e.x, e.y), 0.0, 1.0);
    edge = edge * edge * (3.0 - 2.0 * edge);
    gl_FragColor = vec4(col, ink * uOpacity * edge);
    if (gl_FragColor.a < 0.02) discard;
  }
`;

// A label rendered INTO the scene, not over it.
//
// These were drei <Html>: real DOM in a portal. That works on screen and
// fails at the one moment that matters — a print master is captured with
// canvas.toDataURL(), which sees only WebGL, so every planet and
// constellation name silently vanished from the ordered print while still
// showing in the preview beside it (found 2026-08-26; the server-side
// renderer used page.screenshot(), which DID include the DOM, so the two
// capture paths disagreed about what the product even was).
//
// As sprites they are part of the picture: captured by either path, scaled
// with the framebuffer like everything else, and depth-tested against the
// Sun for free — which also retires the <Html occlude> workaround that
// existed only because DOM cannot depth-test against a canvas.
const LABEL_PAD = 12;
const labelCache = new Map<string, THREE.CanvasTexture>();

function labelTexture(text: string, tint: string): THREE.CanvasTexture {
  const key = `${text}|${tint}`;
  const hit = labelCache.get(key);
  if (hit) return hit;
  const font = 600;
  const px = 64;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = `${font} ${px}px "Inter Variable", Inter, system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + LABEL_PAD * 2;
  c.width = w;
  c.height = px + LABEL_PAD * 2;
  const g = c.getContext("2d")!;
  g.font = `${font} ${px}px "Inter Variable", Inter, system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  // A dark rim so a name stays readable over a bright limb or a star, the
  // same job the CSS text-shadow used to do.
  g.lineWidth = 6;
  g.strokeStyle = "rgba(4,4,6,0.85)";
  g.strokeText(text, c.width / 2, c.height / 2);
  g.fillStyle = tint;
  g.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  labelCache.set(key, tex);
  return tex;
}

function SkyLabel({
  text,
  tint,
  scale,
  registerMaterial,
}: {
  text: string;
  tint: string;
  scale: number;
  registerMaterial: (m: THREE.SpriteMaterial) => void;
}) {
  const tex = useMemo(() => labelTexture(text, tint), [text, tint]);
  const aspect = (tex.image as HTMLCanvasElement).width / (tex.image as HTMLCanvasElement).height;
  return (
    <sprite scale={[scale * aspect, scale, 1]}>
      <spriteMaterial
        ref={(m) => { if (m) registerMaterial(m as THREE.SpriteMaterial); }}
        map={tex}
        transparent
        opacity={0}
        depthWrite={false}
        toneMapped={false}
      />
    </sprite>
  );
}

// sunOccluderRef is gone with the <Html> labels. It existed for one reason:
// drei's Html is a screen-projected DOM overlay with no depth-buffer
// participation, so a planet behind the Sun still drew its name on top of the
// disk and had to be told, explicitly, what to hide behind. Sprites are scene
// objects and depth-test for free.
export default function Starfield() {
  const g = useRef<THREE.Group>(null);
  // gl_PointSize is in FRAMEBUFFER PIXELS, so a star's apparent size depends
  // on how big the framebuffer is — not on how big the picture is. At the
  // preview's 290px a 6px star is a clear point; captured at 2048 the same
  // star is still 6px, i.e. seven times smaller relative to the frame, and by
  // the time a product mockup shrinks that to ~160px the sky is empty.
  //
  // So this is driven from the actual drawing-buffer height each frame rather
  // than being fixed at mount from devicePixelRatio. REF_H is the height the
  // star sizes in `geo` were tuned against; the ratio makes them
  // resolution-independent, which is also just correct on a retina display.
  const uniforms = useMemo(() => ({ uDpr: { value: 1 } }), []);
  const date = useStore((s) => s.date);
  const showConstellations = useStore((s) => s.showConstellations);
  const showStars = useStore((s) => s.showStars);
  const showLabels = useStore((s) => s.showLabels);
  const showArt = useStore((s) => s.showArt);
  // Is the sky actually on screen? The group's `visible` below already hides
  // the WebGL half at 0.51, but the labels are drei <Html>: real DOM in a
  // portal, which does not participate in three's visibility at all. So
  // MERCURY, JUPITER and MARS went on floating over the cabin wall, over the
  // framed print, and over the product shelf — sky furniture indoors, at
  // exactly the three beats where the sale happens (audit in Chrome,
  // 2026-08-26).
  //
  // Unmounted rather than hidden: each <Html> re-projects its position every
  // frame, so leaving 5 (or 93, with names on) mounted through the whole
  // second half was also paying for labels nobody can see.
  //
  // A derived boolean, so this re-renders on the threshold crossing rather
  // than at 60Hz.
  const skyOnScreen = useStore((s) => s.progress < 0.51);
  // Any layer that needs the constellation GEOMETRY loaded: lines draw it,
  // labels and art are positioned from it.
  const needsFigures = showConstellations || showLabels;
  const [stars, setStars] = useState<Star[] | null>(null);

  // Dynamic import, not fetch. Vite emits it as a content-hashed chunk, so it
  // is versioned and cache-busted with the rest of the build, it cannot 404 on
  // a BASE_URL mistake (the baked-in Sun did exactly that in production, see
  // useSunTextureLoader), and it stays code-split — the bytes are still not in
  // the main bundle. Bundling by import gets the reliability without paying the
  // eager-load cost.
  useEffect(() => {
    let alive = true;
    import("../data/stars.json")
      // JSON widens to number[][]; the fixed-length tuple is ours to assert.
      // (fetch().json() was `any` and checked nothing — importing it at least
      // makes the shape visible.)
      .then((m) => alive && setStars((m.default.stars as unknown) as Star[]))
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

  const lines = useRef<THREE.Object3D & { material: THREE.Material & { opacity: number } }>(null);
  const planetMats = useRef<THREE.MeshBasicMaterial[]>([]);
  // Sprite labels fade in the render loop now that they are scene objects,
  // rather than cross-fading in CSS as the DOM ones did.
  const planetLabelMats = useRef<THREE.SpriteMaterial[]>([]);
  const conLabelMats = useRef<THREE.SpriteMaterial[]>([]);
  const labelAmt = useRef(0);
  // One fade amount PER LAYER, since they are now independently switchable —
  // a single shared value would make turning off planets also fade the lines.
  const conAmt = useRef(0);
  const planetAmt = useRef(0);
  const artAmt = useRef(0);
  const artMats = useRef<THREE.ShaderMaterial[]>([]);
  const first = useRef(true);
  const introAt = useRef<number | null>(null);
  useFrame((state, dt) => {
    const el = g.current;
    if (!el) return;
    // Star size tracks the framebuffer (see the uniforms note above). Capped
    // so a very large capture does not turn the sky into blobs.
    {
      const h = state.gl.domElement.height || REF_H;
      uniforms.uDpr.value = Math.min(4, Math.max(0.75, h / REF_H));
    }
    // belongs to the space beats; gone before the atmosphere flash
    el.visible = useStore.getState().progress < 0.51;
    if (first.current) {
      // the opening sky is simply correct — there is nothing to slew from
      el.quaternion.copy(target);
      first.current = false;
      return;
    }
    // Opening demonstration: the film starts with a bare sky and the figures
    // draw themselves in a few seconds later. Showing the layer arrive is what
    // teaches that it IS a layer — and therefore that the control in the bar
    // turns it off again. A static legend can only assert that.
    //
    // Counts from the first frame the sky is actually visible, so it cannot be
    // spent while the loader is still up, and it yields immediately to anyone
    // who has already worked the toggle themselves.
    {
      const st = useStore.getState();
      // Never in plate mode. A print master must be deterministic — one
      // rendered at 3.3s and one at 3.5s would otherwise differ — so the plate
      // takes the guide explicitly (?guide=1) and never from a timer.
      if (!PLATE && !st.skyGuideTouched && st.progress < 0.51) {
        if (introAt.current === null) introAt.current = 0;
        else introAt.current += dt;
        if (introAt.current > 3.4 && !skyGuideOn(st)) {
          // set directly, not through setSkyGuide: this is the film showing
          // the visitor the layer, not the visitor choosing it, so it must not
          // count as having been touched. Demonstrates the two layers the
          // sky-click controls; art stays off until asked for, being both
          // heavy and a strong stylistic statement.
          useStore.setState({ showConstellations: true, showPlanets: true });
        }
      }
    }

    // Fade each layer rather than cutting it in. Frame-rate independent, and
    // the layers stay mounted so there is something to fade.
    const stNow = useStore.getState();
    const k = 1 - Math.exp(-dt / 0.42);
    conAmt.current += ((stNow.showConstellations ? 1 : 0) - conAmt.current) * k;
    planetAmt.current += ((stNow.showPlanets ? 1 : 0) - planetAmt.current) * k;
    artAmt.current += ((stNow.showArt ? 1 : 0) - artAmt.current) * k;
    for (const m of artMats.current) {
      // 0.17, from 0.5 via 0.28. The engravings are large, high-contrast and
      // busy: at anything above this a single plate (Cancer's crab spans a
      // quarter of the frame) reads as the subject rather than as the sky's
      // annotation, and the real stars disappear behind the thing drawn to
      // point at them (Gilly, 2026-08-25: "make them more subtle, too").
      if (m) m.uniforms.uOpacity.value = artAmt.current * 0.17;
    }
    if (lines.current) {
      const m = lines.current.material as THREE.Material & { opacity: number };
      m.opacity = 0.34 * conAmt.current;
      lines.current.visible = conAmt.current > 0.004;
    }
    for (const m of planetMats.current) {
      if (!m) continue;
      m.opacity = planetAmt.current;
    }
    labelAmt.current += ((stNow.showLabels ? 1 : 0) - labelAmt.current) * k;
    // A planet's NAME belongs to the planet layer; a constellation's name is
    // its own switch (the NAMES chip), which is why these fade separately.
    for (const m of planetLabelMats.current) if (m) m.opacity = planetAmt.current;
    for (const m of conLabelMats.current) if (m) m.opacity = labelAmt.current;

    // Slew, do not snap. Changing the date can move the sky by half a celestial
    // sphere, and cutting between two orientations reads as a glitch where the
    // drift reads as the year turning. Frame-rate independent.
    el.quaternion.slerp(target, 1 - Math.exp(-dt / 1.6));
  });

  // Constellation figures, in the same frame as the stars so one rotation
  // registers both. Fetched lazily: nobody pays for them until they ask.
  const [segs, setSegs] = useState<Segment[] | null>(null);
  useEffect(() => {
    if (!needsFigures || segs) return;
    let alive = true;
    import("../data/constellations.json")
      .then((m) => alive && setSegs((m.default.segments as unknown) as Segment[]))
      .catch(() => {});
    return () => { alive = false; };
  }, [needsFigures, segs]);

  // Constellation NAMES (2026-08-24) — bundled into the SAME guide toggle
  // and lazy-loaded the same way: nobody pays for the 88-name list until
  // they ask for the guide. See tools/build-constellation-names.py for
  // where the names and the zodiac flag come from.
  const [art, setArt] = useState<ArtPlate[] | null>(null);
  useEffect(() => {
    if (!showArt || art) return;
    let alive = true;
    import("../data/constellation-art.json")
      .then((m) => alive && setArt((m.default.items as unknown) as ArtPlate[]))
      .catch(() => {});
    return () => { alive = false; };
  }, [showArt, art]);

  // Plate textures, loaded once the manifest lands. A plain TextureLoader
  // rather than drei's useLoader: useLoader suspends, and suspending here
  // would blank the entire scene the moment Art is switched on.
  const [artTextures, setArtTextures] = useState<Record<string, THREE.Texture>>({});
  useEffect(() => {
    if (!art) return;
    const loader = new THREE.TextureLoader();
    let alive = true;
    const base = import.meta.env.BASE_URL;
    art.forEach((a) => {
      loader.load(`${base}art/${a.file}`, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        if (alive) setArtTextures((prev) => (prev[a.file] ? prev : { ...prev, [a.file]: t }));
      });
    });
    return () => { alive = false; };
  }, [art]);

  const [names, setNames] = useState<NamedConstellation[] | null>(null);
  useEffect(() => {
    if (!showLabels || names) return;
    let alive = true;
    import("../data/constellation-names.json")
      .then((m) => alive && setNames((m.default.items as unknown) as NamedConstellation[]))
      .catch(() => {});
    return () => { alive = false; };
  }, [showLabels, names]);

  // Segment endpoints as point pairs, for drei's <Line segments>.
  //
  // Was a raw <lineSegments> with lineBasicMaterial, whose width is ONE
  // DEVICE PIXEL and cannot be changed — WebGL ignores lineWidth on nearly
  // every desktop driver. That is invisible at preview size and worse than
  // invisible in a print: the master is captured at 2048 and a product mockup
  // renders it at ~160, so a 1px line downsamples to about a twelfth of a
  // pixel and the constellations simply are not there (Gilly, 2026-08-26).
  //
  // drei's <Line> is LineMaterial underneath: it expands each segment into a
  // screen-space quad, so linewidth is real and is expressed in pixels
  // against a `resolution` uniform that drei keeps in step with the canvas.
  // That last part is what makes it survive the capture — when the plate
  // iframe is resized to 2048 to be photographed, the lines scale with it
  // instead of staying hairlines.
  const linePoints = useMemo(() => {
    if (!segs) return null;
    const pts: [number, number, number][] = [];
    for (const seg of segs) {
      const p = seg.p;
      // polyline -> line segments, drawn just inside the star shell so the
      // figures never occlude the stars they connect
      for (let i = 0; i + 5 < p.length; i += 3) {
        pts.push([p[i] * SHELL * 0.99, p[i + 1] * SHELL * 0.99, p[i + 2] * SHELL * 0.99]);
        pts.push([p[i + 3] * SHELL * 0.99, p[i + 4] * SHELL * 0.99, p[i + 5] * SHELL * 0.99]);
      }
    }
    return pts.length ? pts : null;
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

  // Constellation name positions: the centroid the build script computed for
  // each, at the SAME radius as the planets so both label kinds read as one
  // layer rather than the names hovering perceptibly nearer or farther.
  const constellationLabels = useMemo(
    () =>
      (names ?? []).map((it) => ({
        ...it,
        pos: new THREE.Vector3(...it.p).multiplyScalar(SHELL * 0.97),
      })),
    [names]
  );

  if (!geo) return null;
  return (
    <group ref={g}>
      {/* Coordinate scaffolding + the ecliptic track, inside this group so the
          one date rotation carries them with the stars. */}
      <SkyGrid shell={SHELL} />

      <points geometry={geo} frustumCulled={false} visible={showStars}>
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

      {/* Mounted once loaded and faded by opacity, NOT mounted/unmounted on the
          toggle. Conditional mounting is what made it blink: the figures
          appeared and vanished between one frame and the next, which reads as a
          glitch where a fade reads as an overlay being drawn. */}
      {linePoints && (
        <Line
          ref={lines as never}
          points={linePoints}
          segments
          color="#7fa8d8"
          // Pixels, against drei's resolution uniform. 2.6 reads as a fine
          // drawn line on screen and still survives a 12x downsample into a
          // product mockup.
          lineWidth={2.6}
          transparent
          opacity={0}
          depthWrite={false}
          toneMapped={false}
          frustumCulled={false}
        />
      )}

      {planets.map((pl, i) => (
        <group key={pl.name} position={pl.pos.toArray()}>
          <mesh
            ref={(m) => {
              if (m) planetMats.current[i] = m.material as THREE.MeshBasicMaterial;
            }}
          >
            <sphereGeometry args={[SHELL * 0.006, 12, 12]} />
            <meshBasicMaterial
              color={PLANET_TINT[pl.name]}
              transparent
              opacity={0}
              toneMapped={false}
            />
          </mesh>
          {skyOnScreen && (
            <SkyLabel
              text={pl.name}
              tint="#e9e4da"
              scale={SHELL * 0.021}
              registerMaterial={(m) => { planetLabelMats.current[i] = m; }}
            />
          )}
        </group>
      ))}

      {skyOnScreen && constellationLabels.map((c, i) => (
        <group key={c.c} position={c.pos.toArray()}>
          <SkyLabel
            text={c.name}
            // the zodiac reads gold, as it did in CSS: those are the twelve
            // the date actually travels through
            tint={c.zodiac ? "#d9b45a" : "#8fa6c4"}
            scale={SHELL * 0.019}
            registerMaterial={(m) => { conLabelMats.current[i] = m; }}
          />
        </group>
      ))}

      {/* Urania's Mirror, 1824 — each plate WHOLE, on the patch of sky it
          depicts. Placement comes from the constellations the plate names
          (see tools/build-constellation-art.py): the card is centred on their
          mean direction and sized to span them, so a multi-figure plate like
          "Lacerta, Cygnus, Lyra, Vulpecula and Anser" covers all five rather
          than being cut into pieces. */}
      {showArt && art && art.map((a, i) => (
        <ArtPlate
          key={a.file}
          plate={a}
          texture={artTextures[a.file]}
          registerMaterial={(m) => { artMats.current[i] = m; }}
        />
      ))}

      {/* The sky is no longer a single click target.
          It used to toggle "the guide" as one thing, which worked when the
          guide WAS one thing. It is now six independent layers — stars, lines,
          art, names, planets, grid — and one click cannot mean six switches;
          whatever it did would be wrong for most of them, and it would also
          fight the date-drag that now lives on the same surface (Gilly,
          2026-08-25). The HUD's chips are the control, and they say what they
          do. The opening demonstration still teaches that the layers exist by
          drawing them in a few seconds after the sky appears. */}
    </group>
  );
}

// One Urania's Mirror plate on the celestial sphere.
//
// Separate component so its uniforms object is created ONCE and mutated when
// the texture arrives. Passing `uniforms={{...}}` inline from the parent built
// a fresh object every render and the plate ended up sampling a null uMap —
// which the key reads as luminance 0, i.e. maximum ink, so all 33 plates
// painted flat parchment rectangles over the sky. Measured on dev 2026-08-24;
// the shader was right and the binding was not.
//
// It also renders NOTHING until its texture is present, so a slow or failed
// download leaves empty sky rather than a grey slab.
function ArtPlate({
  plate,
  texture,
  registerMaterial,
}: {
  plate: ArtPlate;
  texture?: THREE.Texture;
  registerMaterial: (m: THREE.ShaderMaterial) => void;
}) {
  const uniforms = useMemo(
    () => ({ uMap: { value: null as THREE.Texture | null }, uOpacity: { value: 0 } }),
    []
  );
  const group = useRef<THREE.Group>(null);
  useEffect(() => {
    if (texture) uniforms.uMap.value = texture;
  }, [texture, uniforms]);

  const pos = useMemo(
    () => new THREE.Vector3(...plate.p).normalize().multiplyScalar(SHELL * 0.985),
    [plate]
  );
  // Angular radius -> plane size at the shell distance. 1.42 is the plates'
  // own portrait aspect (they are engraved cards, not square).
  const w = 2 * SHELL * Math.tan(THREE.MathUtils.degToRad(plate.r) / 2);

  useEffect(() => {
    // face the origin, where the camera lives: the convention these charts
    // were drawn in, celestial north up.
    group.current?.lookAt(0, 0, 0);
    // `texture` is a dep because the group below does not EXIST until the
    // texture lands. On a cold load this effect first ran with group.current
    // still null, and `pos` never changes, so it never ran again: the plate
    // stayed in its unrotated XY orientation and every card hung edge-on and
    // askew. On a warm load the texture was already in memory on the first
    // render, the group mounted with it, and the same effect happened to work
    // — which is exactly why it looked right the second time (Gilly,
    // 2026-08-25).
  }, [pos, texture]);

  if (!texture) return null;
  return (
    <group ref={group} position={pos.toArray()}>
      <mesh>
        <planeGeometry args={[w, w * 1.42]} />
        <shaderMaterial
          ref={(m) => { if (m) registerMaterial(m as THREE.ShaderMaterial); }}
          vertexShader={artVert}
          fragmentShader={artFrag}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
