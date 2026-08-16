import { useRef, useState } from "react";
import { ThreeEvent, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore, dateValid } from "../store";
import { CHANNELS } from "../data/wavelengths";
import { buyUrl, warmBackend, GALLERY_CATEGORY, GalleryKind } from "../lib/handoff";

// The "make one on anything" beat: pan right from the wall print to a small
// gallery, every piece bearing the same Sun the visitor chose. Sits in the same
// room, just to the right, revealed as the camera dollies over. The real "Make
// one" is the pinned bar at the bottom of the screen.
const WALL_Z = 21.6; // just in front of the room's back wall
const PLINTH_Y = -5.85; // centre; short pedestal that sits ON the floor, top at -5.5

// a low wooden display pedestal (shared) — short so objects don't rise in front
// of the wall art, seated on the floor rather than sunk through it
function Plinth({ x, z }: { x: number; z: number }) {
  return (
    <mesh position={[x, PLINTH_Y, z]}>
      <boxGeometry args={[0.9, 0.7, 0.9]} />
      <meshStandardMaterial color="#221a12" roughness={0.8} />
    </mesh>
  );
}

// a t-shirt silhouette (body + short sleeves + collar dip), EXTRUDED with a soft
// bevel so it reads as a real garment, not a flat decal. The Sun goes on the
// chest as a separate graphic (see below), so the shirt stays a fabric colour.
const TEE_GEO = (() => {
  const s = new THREE.Shape();
  s.moveTo(-0.45, -0.62);
  s.lineTo(0.45, -0.62);
  s.lineTo(0.45, 0.25);
  s.lineTo(0.82, 0.44);
  s.lineTo(0.6, 0.74);
  s.lineTo(0.32, 0.52);
  s.lineTo(0.22, 0.62);
  s.quadraticCurveTo(0, 0.46, -0.22, 0.62);
  s.lineTo(-0.32, 0.52);
  s.lineTo(-0.6, 0.74);
  s.lineTo(-0.82, 0.44);
  s.lineTo(-0.45, 0.25);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.1,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 10,
  });
  g.center();
  return g;
})();

// a plump square throw pillow: a rounded-square profile extruded with a generous
// bevel so every edge is soft (a cushion, not a flat tile). Front-face UVs are
// remapped to 0..1 so the printed Sun sits centred and round.
function roundedSquare(size: number, r: number) {
  const h = size / 2;
  const s = new THREE.Shape();
  s.moveTo(-h + r, -h);
  s.lineTo(h - r, -h);
  s.quadraticCurveTo(h, -h, h, -h + r);
  s.lineTo(h, h - r);
  s.quadraticCurveTo(h, h, h - r, h);
  s.lineTo(-h + r, h);
  s.quadraticCurveTo(-h, h, -h, h - r);
  s.lineTo(-h, -h + r);
  s.quadraticCurveTo(-h, -h, -h + r, -h);
  return s;
}
const PILLOW_GEO = (() => {
  const g = new THREE.ExtrudeGeometry(roundedSquare(0.9, 0.24), {
    depth: 0.16,
    bevelEnabled: true,
    bevelThickness: 0.16,
    bevelSize: 0.16,
    bevelSegments: 6,
    curveSegments: 14,
  });
  g.center();
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / 0.86 + 0.5, pos.getY(i) / 0.86 + 0.5);
  uv.needsUpdate = true;
  return g;
})();

// a round chest-print disc whose UVs sample ONLY the solar disk (~0.19–0.81 of
// the full-frame thumb), so the Sun fills the circle with no black margin
const DISC = 0.31; // solar-disk radius in the thumb's UV space (matches Sun.tsx)
const CHEST_GEO = (() => {
  const r = 0.28;
  const g = new THREE.CircleGeometry(r, 40);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++)
    uv.setXY(i, (pos.getX(i) / r) * DISC + 0.5, (pos.getY(i) / r) * DISC + 0.5);
  uv.needsUpdate = true;
  return g;
})();

// engraved-brass plaque: a canvas texture (dark brass plate, embossed caps
// text) on a thin plane — the cheap, lazy stand-in for a "real" engraved
// look: a dark base fill, a slightly-offset light stroke, then the fill text.
function plaqueTexture(text: string) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3a2c14";
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = "rgba(201,163,78,0.5)";
  g.lineWidth = 4;
  g.strokeRect(8, 8, c.width - 16, c.height - 16);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.letterSpacing = "0.12em";
  // Fit-to-width: a fixed 46px overflowed the plate on the longest label
  // ("Gifts & Stationery", live 2026-08-15). Shrink until the engraved text
  // clears the border with margin; measureText includes letterSpacing.
  const label = text.toUpperCase();
  let size = 46;
  while (size > 24) {
    g.font = `600 ${size}px "Inter Variable", Inter, system-ui, sans-serif`;
    if (g.measureText(label).width <= c.width - 72) break;
    size -= 2;
  }
  const x = c.width / 2 + 2;
  const y = c.height / 2 + 2;
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillText(label, x, y);
  g.fillStyle = "#e8c877";
  g.fillText(label, c.width / 2, c.height / 2);
  return new THREE.CanvasTexture(c);
}

function Plaque({ x, y, z, text }: { x: number; y: number; z: number; text: string }) {
  const tex = getPlaqueTexture(text);
  return (
    <mesh position={[x, y, z]} raycast={() => null}>
      <planeGeometry args={[0.86, 0.215]} />
      <meshBasicMaterial map={tex} toneMapped={false} />
    </mesh>
  );
}

// tiny memo cache so the same label's canvas isn't redrawn every render
const plaqueCache = new Map<string, THREE.CanvasTexture>();
function getPlaqueTexture(text: string) {
  let t = plaqueCache.get(text);
  if (!t) {
    t = plaqueTexture(text);
    plaqueCache.set(text, t);
  }
  return t;
}

// dial face UVs cropped to just the solar disk (matches CHEST_GEO/mug), so the
// full circle fills with Sun instead of mostly the frame's black margin
const DIAL_GEO = (() => {
  const r = 1.02;
  const g = new THREE.CircleGeometry(r, 40);
  const pos = g.attributes.position;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++)
    uv.setXY(i, (pos.getX(i) / r) * DISC + 0.5, (pos.getY(i) / r) * DISC + 0.5);
  uv.needsUpdate = true;
  return g;
})();

// a wall clock: brass rim, the chosen Sun as the dial, two static hands
// (fixed near 10:10 — the classic display pose) — stands in for one framed
// print so the wall doesn't read as three identical posters.
function ClockHand({ len, width, angle }: { len: number; width: number; angle: number }) {
  // pivots at the clock center: offset half its length outward along `angle`
  // (measured from 12 o'clock, clockwise), then rotated to point that way.
  return (
    <mesh
      position={[Math.sin(angle) * (len / 2), Math.cos(angle) * (len / 2), 0.03]}
      rotation={[0, 0, -angle]}
    >
      <planeGeometry args={[width, len]} />
      <meshStandardMaterial color="#161208" />
    </mesh>
  );
}

function Clock({ pos, tex }: { pos: [number, number, number]; tex: THREE.Texture | null }) {
  return (
    <group position={pos}>
      {/* matte-ish brass rim, set well behind the dial — rotating a cylinder
          90° about X swaps its +Y cap to +Z, so a shallow z-offset here left
          the rim's FRONT cap sitting in front of the dial and hiding it
          entirely; -0.06 clears the dial's 0.08-thick front cap either side */}
      <mesh position={[0, 0, -0.06]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[1.18, 1.18, 0.08, 40]} />
        <meshStandardMaterial color="#a5793a" roughness={0.7} metalness={0.35} />
      </mesh>
      <mesh geometry={DIAL_GEO} position={[0, 0, 0.001]}>
        {tex ? (
          <meshBasicMaterial map={tex} toneMapped={false} />
        ) : (
          <meshStandardMaterial color="#1a0d08" roughness={1} />
        )}
      </mesh>
      {/* hands, static at the classic 10:10 display pose */}
      <ClockHand len={0.62} width={0.06} angle={-Math.PI / 3} />
      <ClockHand len={0.42} width={0.08} angle={Math.PI / 3} />
    </group>
  );
}

function Frame({
  pos,
  w,
  h,
  tex,
  rotY = 0,
}: {
  pos: [number, number, number];
  w: number;
  h: number;
  tex: THREE.Texture | null;
  rotY?: number;
}) {
  return (
    <group position={pos} rotation={[0, rotY, 0]}>
      <mesh position={[0, 0, -0.04]}>
        <planeGeometry args={[w + 0.28, h + 0.28]} />
        <meshStandardMaterial color="#100e0a" roughness={0.5} metalness={0.1} />
      </mesh>
      <mesh position={[0, 0, -0.02]}>
        <planeGeometry args={[w + 0.12, h + 0.12]} />
        <meshStandardMaterial color="#a89a7e" roughness={0.95} />
      </mesh>
      {/* the Sun image is a CENTERED SQUARE (matted by the paper around it) so the
          disk stays circular no matter the frame's proportions — never an ellipse */}
      <mesh position={[0, 0, 0.001]}>
        <planeGeometry args={[Math.min(w, h), Math.min(w, h)]} />
        {tex ? (
          <meshBasicMaterial map={tex} toneMapped={false} />
        ) : (
          <meshStandardMaterial color="#1a0d08" roughness={1} />
        )}
      </mesh>
    </group>
  );
}


// Selection affordance for a gallery piece.
//
// The first version was an additive gold plane behind the object, which is
// exactly what it sounds like: a glowing square sitting under a mug. It read as
// a placeholder, not as "this is selectable".
//
// This lights the OBJECT instead. On hover it walks the group's own materials
// and raises their emissive toward gold, so the shape that glows is the actual
// silhouette — a mug rims like a mug, a t-shirt like a t-shirt. Bloom (already
// running in Effects.tsx) spreads that into a halo for free, so the result is a
// rim-lit object rather than a lightbox behind one.
//
// Plus two quiet cues that read as "interactive" without shouting: the piece
// lifts very slightly, and a thin ring breathes on the surface beneath it —
// a contact light, not a backdrop.
function Selectable({
  active,
  children,
  ring,
}: {
  active: boolean;
  children: React.ReactNode;
  ring?: { pos: [number, number, number]; r: number };
}) {
  const grp = useRef<THREE.Group>(null!);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null!);
  const level = useRef(0);
  const cache = useRef<{ mat: THREE.MeshStandardMaterial; base: number; hex: number }[] | null>(null);

  useFrame((state, dt) => {
    if (!grp.current) return;
    // Collect the standard materials once; skip basic materials (the printed
    // Suns), which have no emissive channel and would throw.
    if (!cache.current) {
      const found: { mat: THREE.MeshStandardMaterial; base: number; hex: number }[] = [];
      grp.current.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          const sm = m as THREE.MeshStandardMaterial;
          found.push({ mat: sm, base: sm.emissiveIntensity ?? 1, hex: sm.emissive.getHex() });
        }
      });
      cache.current = found;
    }
    const k = 1 - Math.pow(0.001, dt); // frame-rate independent ease
    level.current += ((active ? 1 : 0) - level.current) * k;
    const L = level.current;
    // idle and settled: skip the material walk once the level has decayed to
    // ~0 and isn't chasing a nonzero target (six of these ran every frame even
    // with nothing hovered)
    if (!active && L < 0.001) return;

    for (const e of cache.current) {
      // Blend the material's own emissive toward gold rather than replacing it,
      // so pieces that already emit keep their character.
      e.mat.emissive.setHex(e.hex).lerp(GOLD, 0.55 * GLOW * L);
      e.mat.emissiveIntensity = e.base + 0.9 * GLOW * L;
    }
    grp.current.position.y = 0.055 * L;
    if (ringMat.current) {
      const t = state.clock.elapsedTime;
      ringMat.current.opacity = L * GLOW * (0.34 + 0.12 * Math.sin(t * 2.6));
    }
  });

  return (
    <group ref={grp}>
      {children}
      {ring && (
        <mesh position={ring.pos} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
          <ringGeometry args={[ring.r * 0.82, ring.r, 48]} />
          <meshBasicMaterial
            ref={ringMat}
            color="#f5cd64"
            transparent
            opacity={0}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      )}
    </group>
  );
}
const GOLD = new THREE.Color("#f7d071");
// Overall strength of the hover treatment, as a single knob.
//
// The first pass ran at 1.0 and was painful to look at: bloom is already
// running over this scene with a low luminance threshold, so every unit of
// emissive gets amplified before it reaches the eye. What reads as a tasteful
// value in isolation arrives several times brighter on screen. 0.25 is a
// rim that says "clickable" rather than one that makes you squint.
const GLOW = 0.25;

export default function Gallery() {
  const tex = useStore((s) => s.currentTexture);
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const channel = useStore((s) => s.channel);
  const valid = useStore(dateValid);
  // present from the room beat on; off-frame (to the right) until the pan.
  // on-screen visibility keeps the original threshold.
  const show = useStore((s) => s.progress > 0.8);
  // ...but MOUNTING is widened and hysteresised: building ~40 meshes, ~30
  // materials, and 6 lights in the same frame the pan reveals them was the
  // owner's hard-cut shader-compile pop. Mount early (during the room dwell,
  // while `show` above still keeps the group invisible), so that work (and
  // the scene-wide shader recompile the new lights trigger) happens frames
  // before anything is on screen. Unmount only well below the mount point so
  // scrubbing near the boundary doesn't thrash mount/unmount every frame.
  const [mounted, setMounted] = useState(false);
  useFrame(() => {
    const p = useStore.getState().progress;
    if (!mounted && p > 0.7) setMounted(true);
    else if (mounted && p < 0.65) setMounted(false);
  });

  const [hovered, setHovered] = useState<GalleryKind | null>(null);

  // Clicking a piece hands off to the store at the PRODUCT PICKER, scrolled to
  // the category that piece represents: click a mug, land on drinkware. The
  // date and wavelength are already settled by the experience, so this is the
  // next real decision. (An earlier version landed on the fine-tune panel,
  // which put the visitor back on a date screen they had just come through —
  // it answered a question nobody was asking at that point.)
  const go = (kind: GalleryKind) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (!valid) return; // no committed date; a purchase click has nothing honest to buy
    warmBackend();
    window.location.href = buyUrl(date, time, CHANNELS[channel].angstrom, {
      cat: GALLERY_CATEGORY[kind],
    });
  };
  const over = (kind: GalleryKind) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    warmBackend();
    setHovered(kind);
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    setHovered(null);
    document.body.style.cursor = "auto";
  };
  const hit = (kind: GalleryKind) => ({
    onClick: go(kind),
    onPointerOver: over(kind),
    onPointerOut: out,
  });

  if (!mounted) return null;

  return (
    // dropped to the ground floor so it shares the (lowered) room's standing
    // height — the camera enters level and the gallery is right there
    <group position={[0, -2.4, 0]} visible={show}>
      {/* warm gallery lighting for the product wall — gentle, so the light mats
          don't blow out into white-edged glows under bloom */}
      <ambientLight intensity={0.5} color="#ffe6c8" />
      <pointLight position={[11, -1.5, 24.5]} intensity={12} distance={26} color="#ffe0b0" />
      <pointLight position={[15, -2, 24]} intensity={8} distance={22} color="#ffd9a0" />

      {/* wall pieces: poster, wall clock, small landscape — flat on the wall
          (no toe-in), viewed nearly head-on by the centered gallery camera so the
          Suns read round; toe-in over-rotated them into tall ellipses and broke
          the view from the room angle. The clock stands in for the old middle
          poster so the wall doesn't read as three identical frames. */}
      <group {...hit("print")}>
        <Selectable active={hovered === "print"}>
          <Frame pos={[9.5, -3.6, WALL_Z]} w={2.0} h={2.7} tex={tex} />
          <Clock pos={[12.4, -3.7, WALL_Z]} tex={tex} />
          <Frame pos={[15.0, -4.1, WALL_Z]} w={2.0} h={1.5} tex={tex} />
          <Plaque x={12.4} y={-1.95} z={WALL_Z + 0.05} text="Wall Art" />

        </Selectable>
      </group>

      {/* ── a pedestal row: one object per remaining product category, so every
             category the store sells is represented (home, drink, apparel, desk,
             gifts). All at plinth height, spread across the wall so the pan reveals
             them; each is clickable, deep-links to its category, and carries an
             engraved-brass plaque naming the category. ── */}

      {/* HOME — a plump printed throw pillow */}
      <group {...hit("pillow")}>
        <Selectable active={hovered === "pillow"} ring={{ pos: [8.7, -5.48, 23.4], r: 0.60 }}>
          <Plinth x={8.7} z={23.4} />
          <mesh geometry={PILLOW_GEO} position={[8.7, -5.0, 23.5]} rotation={[-0.18, 0.18, 0.05]}>
            {tex ? (
              <meshStandardMaterial map={tex} color="#ffffff" roughness={0.95} toneMapped={false} />
            ) : (
              <meshStandardMaterial color="#c25a2a" roughness={0.95} />
            )}
          </mesh>
          <Plaque x={8.7} y={-5.8} z={23.86} text="Home & Cozy" />

        </Selectable>
      </group>

      {/* DRINK — a mug, the Sun wrapped around it */}
      <group {...hit("mug")}>
        <Selectable active={hovered === "mug"} ring={{ pos: [10.3, -5.48, 23.4], r: 0.58 }}>
          <Plinth x={10.3} z={23.4} />
          <Plaque x={10.3} y={-5.8} z={23.86} text="Drinkware" />
          <group position={[10.3, -4.95, 23.4]} rotation={[0, -0.5, 0]}>
            <mesh>
              <cylinderGeometry args={[0.46, 0.42, 1.0, 28, 1, false]} />
              {tex ? (
                <meshStandardMaterial map={tex} color="#ffffff" roughness={0.35} toneMapped={false} />
              ) : (
                <meshStandardMaterial color="#c25a2a" roughness={0.4} />
              )}
            </mesh>
            <mesh position={[0.52, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
              <torusGeometry args={[0.24, 0.07, 12, 24]} />
              <meshStandardMaterial color="#f4efe6" roughness={0.4} />
            </mesh>
          </group>

        </Selectable>
      </group>

      {/* APPAREL — a fabric t-shirt with the Sun printed on the chest */}
      <group {...hit("tee")}>
        <Selectable active={hovered === "tee"} ring={{ pos: [11.9, -5.48, 23.4], r: 0.60 }}>
          <Plinth x={11.9} z={23.4} />
          <Plaque x={11.9} y={-5.8} z={23.86} text="Apparel" />
          <group position={[11.9, -4.75, 23.5]} scale={0.92}>
            <mesh geometry={TEE_GEO}>
              <meshStandardMaterial color="#b7ada0" roughness={0.95} />
            </mesh>
            {/* chest print: a clean round Sun graphic on the shirt */}
            <mesh geometry={CHEST_GEO} position={[0, 0.04, 0.13]}>
              {tex ? (
                <meshBasicMaterial map={tex} toneMapped={false} />
              ) : (
                <meshBasicMaterial color="#c25a2a" />
              )}
            </mesh>
          </group>

        </Selectable>
      </group>

      {/* GIFTS — a glass ornament (bauble) with cap + hanging loop */}
      <group {...hit("ornament")}>
        <Selectable active={hovered === "ornament"} ring={{ pos: [13.5, -5.48, 23.4], r: 0.58 }}>
          <Plinth x={13.5} z={23.4} />
          <Plaque x={13.5} y={-5.8} z={23.86} text="Gifts & Stationery" />
          <mesh position={[13.5, -4.95, 23.4]}>
            <sphereGeometry args={[0.5, 32, 32]} />
            {tex ? (
              <meshStandardMaterial map={tex} color="#ffffff" roughness={0.55} metalness={0.0} toneMapped={false} />
            ) : (
              <meshStandardMaterial color="#c25a2a" roughness={0.5} />
            )}
          </mesh>
          <mesh position={[13.5, -4.42, 23.4]}>
            <cylinderGeometry args={[0.12, 0.15, 0.16, 16]} />
            <meshStandardMaterial color="#c9a34e" roughness={0.35} metalness={0.7} />
          </mesh>
          <mesh position={[13.5, -4.26, 23.4]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.1, 0.03, 10, 20]} />
            <meshStandardMaterial color="#c9a34e" roughness={0.35} metalness={0.7} />
          </mesh>

        </Selectable>
      </group>

      {/* DESK & TECH — a phone case, the Sun printed on the back */}
      <group {...hit("phone")}>
        <Selectable active={hovered === "phone"} ring={{ pos: [15.1, -5.48, 23.4], r: 0.58 }}>
          <Plinth x={15.1} z={23.4} />
          <Plaque x={15.1} y={-5.8} z={23.86} text="Desk & Tech" />
          <group position={[15.1, -4.75, 23.4]} rotation={[-0.1, -0.12, 0]}>
            <mesh>
              <boxGeometry args={[0.62, 1.28, 0.08]} />
              <meshStandardMaterial color="#15110c" roughness={0.5} metalness={0.2} />
            </mesh>
            {/* square Sun print centred on the back so the disk stays round */}
            <mesh position={[0, 0.06, 0.045]}>
              <planeGeometry args={[0.52, 0.52]} />
              {tex ? (
                <meshBasicMaterial map={tex} toneMapped={false} />
              ) : (
                <meshStandardMaterial color="#c25a2a" roughness={0.6} />
              )}
            </mesh>
          </group>

        </Selectable>
      </group>
    </group>
  );
}
