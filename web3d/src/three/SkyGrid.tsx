import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";

// The coordinate scaffolding of the sky: an RA/Dec graticule, the ecliptic
// drawn as a track, and a marker riding it at the Sun's own position.
//
// RA/Dec rather than Alt-Az, and the reason is not preference: Alt-Az is
// defined by where the OBSERVER is standing and at what moment. This product
// never asks for a location — the visitor picks a date, not a place — so an
// alt-az grid would have to invent a latitude and a local time, and would then
// be confidently wrong for everyone who did not happen to live there. RA/Dec
// is a property of the sky itself, so it is true for every visitor. (If a
// location is ever collected, alt-az becomes worth adding beside it, not
// instead of it.)
//
// Everything here is built in the SAME equatorial J2000 frame as stars.json,
// so it is mounted inside Starfield's rotating group and the one date rotation
// carries all of it together.

const DEG = Math.PI / 180;
const OBLIQUITY = 23.439 * DEG; // Earth's axial tilt: the ecliptic's inclination

/** Equatorial (RA, Dec) in degrees -> unit vector, matching stars.json. */
function eq(raDeg: number, decDeg: number): THREE.Vector3 {
  const a = raDeg * DEG;
  const d = decDeg * DEG;
  const cd = Math.cos(d);
  return new THREE.Vector3(cd * Math.cos(a), cd * Math.sin(a), Math.sin(d));
}

/** Ecliptic longitude (degrees, latitude 0) -> equatorial unit vector. */
function ecliptic(lonDeg: number): THREE.Vector3 {
  const l = lonDeg * DEG;
  return new THREE.Vector3(
    Math.cos(l),
    Math.cos(OBLIQUITY) * Math.sin(l),
    Math.sin(OBLIQUITY) * Math.sin(l)
  );
}

/** The Sun's ecliptic longitude on a date (USNO low-precision, as Starfield). */
function sunLongitude(dateStr: string): number {
  const d = new Date(`${dateStr || "2015-01-01"}T12:00:00Z`);
  const n = d.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * DEG;
  return L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
}

function lineGeometry(points: THREE.Vector3[], radius: number, loop: boolean) {
  const pos: number[] = [];
  const n = points.length;
  const last = loop ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    pos.push(a.x * radius, a.y * radius, a.z * radius);
    pos.push(b.x * radius, b.y * radius, b.z * radius);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  return g;
}

export default function SkyGrid({ shell }: { shell: number }) {
  const showGrid = useStore((s) => s.showGrid);
  const date = useStore((s) => s.date);
  const reduced = useStore((s) => s.reducedMotion);

  const gridRef = useRef<THREE.LineSegments>(null);
  const eclRef = useRef<THREE.LineSegments>(null);
  const stemRef = useRef<THREE.LineSegments>(null);
  const headRef = useRef<THREE.Group>(null);
  const headMat = useRef<THREE.MeshBasicMaterial>(null);
  // Two fades, not one. The graticule is scaffolding and belongs to the GRID
  // switch; the ecliptic and its marker are the date SCRUBBER, so they also
  // come up on their own whenever a drag is running. Tying the marker to the
  // grid chip meant the one moment it exists to explain — the sky winding under
  // your hand — was the one moment it was usually switched off.
  const amt = useRef(0);
  const trackAmt = useRef(0);

  // Graticule: meridians every 2h of RA, parallels every 15 degrees of Dec.
  // Coarse on purpose — this is orientation, not a measuring instrument, and a
  // finer mesh turns the sky into graph paper.
  const gridGeo = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const seg: number[] = [];
    const push = (list: THREE.Vector3[], loop: boolean) => {
      const g = lineGeometry(list, shell * 0.995, loop);
      const arr = g.getAttribute("position").array as Float32Array;
      for (let i = 0; i < arr.length; i++) seg.push(arr[i]);
      g.dispose();
    };
    for (let ra = 0; ra < 360; ra += 30) {
      const line: THREE.Vector3[] = [];
      for (let dec = -85; dec <= 85; dec += 5) line.push(eq(ra, dec));
      push(line, false);
    }
    for (let dec = -75; dec <= 75; dec += 15) {
      const line: THREE.Vector3[] = [];
      for (let ra = 0; ra <= 360; ra += 5) line.push(eq(ra, dec));
      push(line, false);
    }
    void pts;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(seg), 3));
    return g;
  }, [shell]);

  // The ecliptic: the Sun's own path through the year, and therefore the track
  // the date-drag scrubs along. Drawn slightly inside the graticule so the two
  // never z-fight.
  const eclGeo = useMemo(() => {
    const line: THREE.Vector3[] = [];
    for (let lon = 0; lon <= 360; lon += 2) line.push(ecliptic(lon));
    return lineGeometry(line, shell * 0.99, true);
  }, [shell]);

  // Where the marker sits: the Sun's position on the ecliptic for this date,
  // nudged toward ecliptic north so it rides just ABOVE the Sun rather than
  // being swallowed by it. The Sun sphere sits at the origin and the sky is a
  // 150-unit shell, so anything at the Sun's exact direction is behind it.
  const headPos = useMemo(() => {
    const lon = sunLongitude(date);
    const here = ecliptic(lon);
    const ahead = ecliptic(lon + 1);
    // ecliptic "north" at this point: perpendicular to both the track and the
    // outward direction, so the offset stays on the sphere and square to the line
    const north = new THREE.Vector3().crossVectors(here, ahead).normalize();
    // 16 degrees. The two earlier values were both wrong, in opposite
    // directions, and measuring the actual camera settles it:
    //
    //   9 deg  — swallowed. At the surface beat the camera is 3 units from a
    //            1.6-radius Sun, so the disk alone subtends 32 deg.
    //   32 deg — off the top of the frame. The camera's VERTICAL fov is 45 deg,
    //            i.e. 22.5 deg of half-frame, and the offset runs toward the
    //            ecliptic pole, which is very nearly screen-up. A 32-degree
    //            offset from a Sun already composed below centre puts the
    //            marker outside the viewport entirely. That is why it was never
    //            visible, not occlusion (Gilly, 2026-08-25).
    //
    // At the threshold beat, where the drag actually lives, the camera stands
    // 9.2 units off and the Sun+corona reach ~13 deg; 20 deg clears them with
    // margin. Measured: 20 deg lands at NDC y=0.917, inside the frame but
    // within 4% of the top edge and sitting on the headline; 16 at 0.749,
    // still on the subhead. 13.5 clears the corona — whose own shader fades
    // it out by ~1.12 solar radii, i.e. 11.3 deg from here, not the 13 the
    // raycast bound suggests — and lands under the copy instead of through
    // it. At the surface beat
    // the Sun genuinely fills the frame and the marker is behind it — that is
    // not a bug to fix, it is what "the Sun is exactly where you are pointing"
    // looks like from three units away.
    return here.clone().addScaledVector(north, Math.tan(13.5 * DEG)).normalize();
  }, [date]);

  // The stem: a hairline from the Sun's true point on the ecliptic up to the
  // triangle. Without it, an offset marker is just a triangle hanging in the
  // sky near the Sun; with it, the marker unambiguously POINTS AT a specific
  // place on the track, which is the whole job.
  const stemGeo = useMemo(
    () => lineGeometry([ecliptic(sunLongitude(date)), headPos], shell * 0.985, false),
    [date, headPos, shell]
  );

  useFrame((state, dt) => {
    const dragging = useStore.getState().dateDragging;
    const k = 1 - Math.exp(-dt / 0.4);
    amt.current += ((showGrid ? 1 : 0) - amt.current) * k;
    // The track and its playhead are on by default (Gilly, 2026-08-25): they
    // are the date scrubber's face, and a scrubber that only appears once you
    // have already found the gesture teaches nobody. Only the graticule stays
    // behind the GRID chip — it is reference furniture, not a control.
    //
    // But only where the gesture EXISTS. The drag is armed below 0.22 (see
    // useDateDrag's ARM_BELOW_PROGRESS); past that the track kept riding into
    // the aperture beat, where the triangle and its stem landed on the filter
    // wheel and read as a pointer aimed at the 171 wedge — an indicator for a
    // control that is no longer live, pointing at a different control
    // entirely (audit in Chrome, 2026-08-26). A live drag overrides, so the
    // marker never vanishes out from under a hand that is using it.
    const live = useStore.getState().progress < 0.22 || dragging;
    trackAmt.current += ((live ? 1 : 0) - trackAmt.current) * k;
    const a = amt.current;
    const tr = trackAmt.current;
    if (gridRef.current) {
      (gridRef.current.material as THREE.LineBasicMaterial).opacity = 0.13 * a;
      gridRef.current.visible = a > 0.004;
    }
    if (eclRef.current) {
      (eclRef.current.material as THREE.LineBasicMaterial).opacity = 0.42 * tr;
      eclRef.current.visible = tr > 0.004;
    }
    if (stemRef.current) {
      (stemRef.current.material as THREE.LineBasicMaterial).opacity = 0.55 * tr;
      stemRef.current.visible = tr > 0.004;
    }
    if (headRef.current) {
      headRef.current.visible = tr > 0.004;
      // Face the camera so the triangle always reads as a triangle rather than
      // as an edge-on sliver.
      headRef.current.lookAt(state.camera.position);
      // Flashy, as asked: a slow breath plus a brighter pulse while a drag is
      // actually running, so the marker reads as the thing being moved.
      const t = state.clock.elapsedTime;
      const beat = reduced ? 1 : 1 + Math.sin(t * (dragging ? 7 : 2.2)) * (dragging ? 0.18 : 0.07);
      // 0.018, was 0.055. At 0.055 the caret rendered about a third the
      // width of the Sun: not flashy, obstructive. An indicator has to be
      // findable, not loud.
      headRef.current.scale.setScalar(shell * 0.018 * beat);
      if (headMat.current) headMat.current.opacity = tr * (dragging ? 1 : 0.6);
    }
  });

  return (
    <group>
      <lineSegments ref={gridRef} geometry={gridGeo} frustumCulled={false}>
        <lineBasicMaterial color="#8fa6c4" transparent opacity={0} depthWrite={false} toneMapped={false} />
      </lineSegments>

      <lineSegments ref={eclRef} geometry={eclGeo} frustumCulled={false}>
        <lineBasicMaterial color="#d9a91a" transparent opacity={0} depthWrite={false} toneMapped={false} />
      </lineSegments>

      {/* The playhead. The sky rotates under a Sun that never moves, so this
          marker stays put in frame while the ecliptic — and the zodiac strung
          along it — slides through: a scrubber with a fixed head and a moving
          tape, which is exactly what the date-drag is. */}
      <lineSegments ref={stemRef} geometry={stemGeo} frustumCulled={false}>
        <lineBasicMaterial color="#ffd97a" transparent opacity={0} depthWrite={false} depthTest={false} toneMapped={false} />
      </lineSegments>

      <group ref={headRef} position={headPos.clone().multiplyScalar(shell * 0.975).toArray()}>
        {/* -PI/2, not PI. lookAt keeps local +Y pointing at world up, i.e.
            screen up, and circleGeometry's first vertex sits at +X — so a half
            turn aimed the caret sideways across the frame. A quarter turn back
            aims it DOWN the stem, at the Sun. */}
        <mesh rotation={[0, 0, -Math.PI / 2]}>
          {/* a 3-sided cone is a triangle that always has a clean silhouette */}
          <circleGeometry args={[1, 3]} />
          <meshBasicMaterial
            ref={headMat}
            color="#ffd97a"
            transparent
            opacity={0}
            side={THREE.DoubleSide}
            // it is an indicator, not scenery: never let the corona quad or a
            // constellation plate bury it
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}
