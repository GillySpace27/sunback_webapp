import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS, DEFAULT_CHANNEL } from "../data/wavelengths";
import { RHEF_DISC_R } from "../hooks/useRhefTextureLoader";

// The Sun surface: the real SDO/AIA full-disk image for the chosen date +
// wavelength, orthographically mapped onto the front hemisphere. A procedural
// plasma shader is the loading/fallback state and crossfades out as the photo
// arrives, so the Sun always reads as *their* Sun once the frame is fetched.
const vertex = /* glsl */ `
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vPos;
  void main() {
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = normalize(-mv.xyz);
    vPos = position;
    gl_Position = projectionMatrix * mv;
  }
`;

const fragment = /* glsl */ `
  precision highp float;
  varying vec3 vN;
  varying vec3 vView;
  varying vec3 vPos;

  uniform float uTime;
  uniform vec3 uTint;
  uniform vec3 uHot;
  uniform float uOctaves;
  uniform sampler2D uMap;   // real SDO/AIA disk
  uniform float uHasMap;    // 1 once a photo is loaded
  uniform float uMapMix;    // crossfade procedural -> photo
  uniform float uDiscR;     // uv radius of the solar disk in the image (~0.31)
  uniform float uExposure;  // lift the (dim) raw disk so it reads on dark bg
  uniform sampler2D uRhef;  // FITS-derived, radially-equalised frame
  uniform float uHasRhef;
  uniform float uRhefDiscR; // ~0.39: the FITS field is narrower than the JP2's
  uniform float uLookMix;   // 0 = raw (JP2), 1 = RHEF
  // RHEF output is histogram-equalised: by construction it already fills the
  // display range. uExposure exists to lift the DIM raw frame, so applying it
  // to RHEF pushed an already-full-range image into clipping — which is what
  // made the enhanced look washed out and milky.
  uniform float uRhefExposure;
  // Time-lapse: the NEXT real frame in the day's sequence, cross-faded against
  // uMap. Both are observations; the blend between them is the only invented
  // part, and it is a dissolve, not a simulation of what happened in between.
  uniform sampler2D uNext;
  uniform float uHasNext;
  uniform float uSeqMix;
  // Rainbow: three GREYSCALE RHEF frames (171/193/211) as R/G/B, straight from
  // the backend's un-colour-mapped product.
  uniform sampler2D uRainR;
  uniform sampler2D uRainG;
  uniform sampler2D uRainB;
  uniform float uHasRainbow;
  // Solar rotation, driven by the DATE rather than by elapsed time: one turn
  // per 27.2753 days, the synodic Carrington period — the Sun's rotation as
  // seen from a moving Earth, which is the one an observer actually measures.
  uniform float uSpin;

  // Rotate about the scene's +Y, which is solar north here (B0 and P angle are
  // not modelled; at up to ~7 and ~26 degrees they would matter for a
  // measurement and do not for a turning ball of plasma).
  vec3 rotY(vec3 p, float a){
    float c = cos(a), s = sin(a);
    return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  }

  vec3 hash3(vec3 p){
    p = vec3(dot(p,vec3(127.1,311.7,74.7)),
             dot(p,vec3(269.5,183.3,246.1)),
             dot(p,vec3(113.5,271.9,124.6)));
    return -1.0 + 2.0*fract(sin(p)*43758.5453123);
  }
  float noise(vec3 p){
    vec3 i = floor(p); vec3 f = fract(p);
    vec3 u = f*f*(3.0-2.0*f);
    return mix(mix(mix(dot(hash3(i+vec3(0,0,0)),f-vec3(0,0,0)),
                       dot(hash3(i+vec3(1,0,0)),f-vec3(1,0,0)),u.x),
                   mix(dot(hash3(i+vec3(0,1,0)),f-vec3(0,1,0)),
                       dot(hash3(i+vec3(1,1,0)),f-vec3(1,1,0)),u.x),u.y),
               mix(mix(dot(hash3(i+vec3(0,0,1)),f-vec3(0,0,1)),
                       dot(hash3(i+vec3(1,0,1)),f-vec3(1,0,1)),u.x),
                   mix(dot(hash3(i+vec3(0,1,1)),f-vec3(0,1,1)),
                       dot(hash3(i+vec3(1,1,1)),f-vec3(1,1,1)),u.x),u.y),u.z);
  }
  float fbm(vec3 p){
    float a = 0.5, s = 0.0;
    for(int i=0;i<6;i++){
      if(float(i) >= uOctaves) break;
      s += a*noise(p);
      p *= 2.02; a *= 0.5;
    }
    return s;
  }

  void main(){
    // Rainbow first, and OUTSIDE the fast path. It was nested inside the
    // uHasMap / uMapMix>0.99 gate, so whenever the Helioviewer JP2 had not
    // arrived the disk fell through to the procedural plasma while the corona
    // around it rendered the real composite — a fake Sun wearing a real
    // atmosphere. The rainbow is three RHEF frames and needs no JP2 at all.
    if (uHasRainbow > 0.5) {
      vec2 ruv = (vPos.xy / 1.6) * uRhefDiscR + 0.5;
      vec3 photo = vec3(
        texture2D(uRainR, ruv).r,
        texture2D(uRainG, ruv).r,
        texture2D(uRainB, ruv).r
      ) * uRhefExposure;
      float limbF = pow(clamp(dot(vN, vView), 0.0, 1.0), 0.55);
      float lum = dot(photo, vec3(0.2126, 0.7152, 0.0722));
      photo *= 0.62 + 0.38 * limbF;
      photo *= 1.0 + 0.8 * pow(clamp(lum, 0.0, 1.0), 3.0);
      gl_FragColor = vec4(photo, 1.0);
      return;
    }
    // fast path: once the photo has fully resolved, skip the expensive fbm
    // plasma entirely (its result would be discarded by the mix anyway)
    if (uHasMap > 0.5 && uMapMix > 0.99) {
      vec2 muv = (vPos.xy / 1.6) * uDiscR + 0.5;
      vec3 photo = texture2D(uMap, muv).rgb * uExposure;
      if (uHasNext > 0.5) {
        photo = mix(photo, texture2D(uNext, muv).rgb * uExposure, uSeqMix);
      }
      if (uHasRhef > 0.5 && uLookMix > 0.001) {
        // sampled with the RHEF frame's OWN disc radius, not the JP2's
        vec2 ruv = (vPos.xy / 1.6) * uRhefDiscR + 0.5;
        photo = mix(photo, texture2D(uRhef, ruv).rgb * uRhefExposure, uLookMix);
      }
      // The fast path used to blit the texture flat, with no limb term at all,
      // so the moment the real frame arrived the Sun stopped being a lit body
      // and became a decal on a sphere with a razor silhouette. Keep the limb
      // falloff the procedural branch computes, and push bright cores above
      // 1.0 so the bloom pass has real headroom: a star reads as light because
      // it blows out, not because it is orange.
      float limbF = pow(clamp(dot(vN, vView), 0.0, 1.0), 0.55);
      float lum = dot(photo, vec3(0.2126, 0.7152, 0.0722));
      photo *= 0.62 + 0.38 * limbF;
      // Only the genuinely brightest pixels get headroom, and much less of it
      // (was 2.6 at exponent 2.5, i.e. 3.6x at peak, which is what bloom then
      // smeared into a halo over everything).
      photo *= 1.0 + 0.8 * pow(clamp(lum, 0.0, 1.0), 3.0);
      gl_FragColor = vec4(photo, 1.0);
      return;
    }

    // The generative Sun turns; the photographed one never does. Sampling the
    // noise field at the INVERSE rotation makes the plasma appear to rotate by
    // +uSpin about the pole, carrying features from the east limb to the west
    // — left to right on screen, which is the direction the real Sun turns as
    // seen from Earth. Rotating the actual SDO frame would be a different
    // claim entirely: that we know what the far side looked like.
    vec3 p = rotY(vPos, -uSpin) * 2.4;
    float t = uTime * 0.06;
    float warp = fbm(p + vec3(0.0, t, 0.0));
    float n = fbm(p * 1.6 + warp * 1.4 + vec3(t, 0.0, -t));
    n = smoothstep(-0.6, 0.9, n);
    float limb = pow(clamp(dot(vN, vView), 0.0, 1.0), 0.55);
    vec3 base = uTint * (0.25 + 0.75 * n);
    vec3 col = mix(vec3(0.02), base, limb);
    col += uHot * pow(n, 5.0) * limb * 1.4;

    // real disk crossfading in, mapped so the silhouette edge lands on the limb
    if (uHasMap > 0.5) {
      vec2 muv = (vPos.xy / 1.6) * uDiscR + 0.5;
      vec3 photo = texture2D(uMap, muv).rgb * uExposure;
      col = mix(col, photo, uMapMix);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Corona — DIEGETIC.
//
// The first version of this was a procedural falloff: a pretty glow the engine
// invented, identical for every date and wavelength, taking credit for exactly
// the structure RHEF is supposed to reveal. That is an aspirational render. It
// makes the 3D Sun better than the thing in the cart and leaks conversion to a
// product that does not exist.
//
// It turns out none of it needed inventing. The texture is fetched at
// image_scale=3, size 1024 — a 3072-arcsec field — and the solar disk is only
// ~1920 arcsec across, so every frame already carries real off-disk corona out
// to about 1.6 solar radii. The sphere stops at the limb and discards all of
// it. This quad shows that discarded annulus, sampled from the same texture,
// with the same mapping the sphere uses.
//
// Consequence worth keeping: with raw data this corona is genuinely faint,
// because the raw corona IS faint. With an RHEF frame it should bloom out. The
// difference between Original and Enhanced stops being a claim in copy and
// becomes the thing you are looking at.
//
// CORONA_SIZE is derived, not tuned: at 1.6/uDiscR the quad's uv maps 1:1 onto
// the texture's uv, so the corona is pixel-aligned with the disk inside it.
// 1.0, not the raw frame's 1.4. RHEF is histogram-equalised, so it arrives
// already spread across the full range; lifting it again only clips it.
const RHEF_EXPOSURE = 1.0;
const CORONA_DISC_R = 0.31;
const CORONA_SIZE = 1.6 / CORONA_DISC_R;

const coronaVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const coronaFragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uMap;
  uniform float uHasMap;
  uniform float uDiscR;
  uniform float uExposure;
  uniform float uStrength;
  uniform float uCorona;   // per-channel: how much real off-limb corona exists
  uniform vec3 uTint;
  uniform sampler2D uRhef;
  uniform float uHasRhef;
  uniform float uRhefDiscR;
  uniform float uLookMix;
  uniform float uRhefExposure;
  uniform sampler2D uRainR;
  uniform sampler2D uRainG;
  uniform sampler2D uRainB;
  uniform float uHasRainbow;
  uniform float uQuadR;
  uniform float uHover;    // 0..1, lifts the corona while it is being pointed at    // quad half-width in solar radii

  // Everything here is done in SOLAR RADII rather than in each texture's own uv,
  // because the two sources do not share a field of view: the JP2 thumb reaches
  // 1.6 Rsun (disk at uv 0.31) and the FITS/RHEF frame only 1.28 (disk at 0.39).
  // Mapping the quad's full span onto whichever texture was bound stretched
  // RHEF's thin real annulus across half again its true extent, diluting exactly
  // the structure this quad exists to show — and then the outer fade cut into
  // what survived. In radii both sources land where they physically belong and
  // the masks mean the same thing for either.
  void main() {
    float rq = length(vUv - 0.5);      // 0 at centre, 0.5 at the quad edge
    float R = rq * uQuadR / 0.5;       // solar radii

    // Feather across the limb so the annulus meets the sphere without a seam.
    float inner = smoothstep(0.985, 1.03, R);
    if (inner <= 0.001) discard;

    vec3 col;
    float avail;                        // how far out this source has data

    if (uHasRainbow > 0.5) {
      vec2 dir = normalize(vUv - 0.5 + vec2(1e-6));
      vec2 ruv = dir * (R * uRhefDiscR) + 0.5;
      col = vec3(
        texture2D(uRainR, ruv).r,
        texture2D(uRainG, ruv).r,
        texture2D(uRainB, ruv).r
      ) * uRhefExposure;
      avail = 0.5 / uRhefDiscR;
    } else if (uHasRhef > 0.5 && uLookMix > 0.001) {
      vec2 dir = normalize(vUv - 0.5 + vec2(1e-6));
      vec2 ruv = dir * (R * uRhefDiscR) + 0.5;
      vec3 rhefCol = texture2D(uRhef, ruv).rgb * uRhefExposure;
      vec3 rawCol = uHasMap > 0.5
        ? texture2D(uMap, dir * (R * uDiscR) + 0.5).rgb * uExposure
        : vec3(0.0);
      col = mix(rawCol, rhefCol * uCorona, uLookMix);
      avail = 0.5 / uRhefDiscR;
    } else if (uHasMap > 0.5) {
      vec2 dir = normalize(vUv - 0.5 + vec2(1e-6));
      col = texture2D(uMap, dir * (R * uDiscR) + 0.5).rgb * uExposure;
      avail = 0.5 / uDiscR;
    } else {
      float t = clamp((R - 1.0) / 0.6, 0.0, 1.0);
      col = uTint * pow(1.0 - t, 6.0) * 0.5;
      avail = 1.6;
    }

    // One fade, doing two jobs: it stops before the texture's own edge (so the
    // field never ends in a hard circle) and it is where the signal genuinely
    // dies. Past ~1.2 Rsun even 171 drops under the noise floor and RHEF
    // faithfully equalises the noise, so this is the line between showing
    // structure and selling speckle.
    // A wide fade, not a cliff. At 0.02 Rsun this was a few pixels and the
    // corona ended in a visible hard ring, which reads as a rendered disc
    // rather than an atmosphere thinning out.
    float noiseEdge = min(1.12, avail - 0.14);
    float outer = 1.0 - smoothstep(noiseEdge, avail, R);
    float mask = inner * outer;
    if (mask <= 0.001) discard;

    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    // A control has to announce itself. Lifting the corona on hover says
    // "this is the thing you can act on" without putting a button over the
    // film, and it lifts the exact structure the click is about.
    gl_FragColor = vec4(col * uStrength * (1.0 + 0.85 * uHover) * mask, lum * mask);
  }
`;

const BLACK_1PX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLACK_1PX.needsUpdate = true;

// diskOccluderRef: the disk mesh registers itself here so the planet labels
// in Starfield (rendered as DOM via drei's <Html>) can depth-test against it.
// <Html> is a screen-projected DOM overlay with NO depth buffer participation
// by default, so without this a planet whose 3D position is behind the Sun's
// disk still draws its label on top of the photographic surface — exactly the
// "MERCURY floating on the disk" bug Gilly reported 2026-08-24. The corona
// quad is deliberately NOT an occluder: it is meant to read as translucent
// (see the diegetic-corona work), so a label showing through the glow is
// correct, only the solid disk should hide it.
export default function Sun({
  diskOccluderRef,
}: {
  diskOccluderRef?: React.MutableRefObject<THREE.Mesh | null>;
} = {}) {
  const corona = useRef<THREE.Mesh>(null);
  const seqT = useRef(0);
  const hover = useRef(false);

  // Clicking the corona toggles the enhancement.
  //
  // Direct manipulation of the actual subject rather than a control beside it:
  // the corona IS what RHEF reveals, so the thing you click is the thing that
  // changes. It is live through the aperture beat, where the SDO model — the
  // spacecraft that took this frame — is also on screen.
  //
  // The quad is a full square and the fragment shader DISCARDS everything
  // outside the annulus, but discard does not affect raycasting: without a uv
  // test, the whole square including the middle (in front of the disk) and the
  // empty corners would be clickable. So the annulus is re-derived here, in the
  // same solar radii the shader uses.
  const CORONA_QUAD_R = CORONA_SIZE / 2 / 1.6;
  const onCorona = (uv?: THREE.Vector2) => {
    if (!uv) return false;
    const R = Math.hypot(uv.x - 0.5, uv.y - 0.5) * CORONA_QUAD_R / 0.5;
    // The WHOLE Sun, disk included — not just the annulus. Requiring people to
    // find a ring a fraction of a radius wide to discover the enhancement made
    // the affordance a trick shot. The quad passes through the sphere's centre
    // and R3F reports both intersections, so the disk is hittable here even
    // though the sphere is drawn in front of it. Past ~1.3 Rsun there is
    // nothing rendered to point at.
    return R < 1.3;
  };
  // R3F keeps raycasting an invisible mesh, so gate on the same progress window
  // the corona itself uses rather than trusting `visible` (same trap the SDO
  // model documents).
  const armed = () => useStore.getState().progress < 0.4;
  const tint = useRef(new THREE.Color(CHANNELS[5].tint));
  const hot = useRef(new THREE.Color(CHANNELS[5].hot));

  // the real texture is loaded centrally (useSunTextureLoader) and published to
  // the store; null while loading/on error, so we fall back to the plasma
  const date = useStore((s) => s.date);
  const tex = useStore((s) => s.currentTexture);
  const rhefTex = useStore((s) => s.rhefTexture) as THREE.Texture | null;
  const seq = useStore((s) => s.sequence) as THREE.Texture[];
  const rain = useStore((s) => s.rainbow3) as THREE.Texture[];
  // the origin Sun belongs to the space beats; hide it UNDER the atmosphere flash
  // (~0.51) so the red AIA disk never lingers in the daytime sky (the ground has
  // its own warm sun) or shows through the fading ground
  const visible = useStore((s) => s.progress < 0.51);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uTint: { value: tint.current.clone() },
      uHot: { value: hot.current.clone() },
      uOctaves: { value: 6 },
      uMap: { value: BLACK_1PX as THREE.Texture },
      uHasMap: { value: 0 },
      uMapMix: { value: 0 },
      uDiscR: { value: 0.31 }, // ponytail: plate-scale knob; tune if framing drifts
      uExposure: { value: 1.4 },
      uRhef: { value: BLACK_1PX as THREE.Texture },
      uHasRhef: { value: 0 },
      uRhefDiscR: { value: RHEF_DISC_R },
      uLookMix: { value: 0 },
      uRhefExposure: { value: RHEF_EXPOSURE },
      uNext: { value: BLACK_1PX as THREE.Texture },
      uHasNext: { value: 0 },
      uSeqMix: { value: 0 },
      uRainR: { value: BLACK_1PX as THREE.Texture },
      uRainG: { value: BLACK_1PX as THREE.Texture },
      uRainB: { value: BLACK_1PX as THREE.Texture },
      uHasRainbow: { value: 0 },
      uSpin: { value: 0 },
    }),
    []
  );

  const coronaUniforms = useMemo(
    () => ({
      uTint: { value: hot.current.clone() },
      // 1.0, not 1.6. The corona is data, so it is shown at the same exposure
      // as the disk beside it. Multiplying it was the render asserting a
      // corona brighter than the instrument recorded — the exact
      // non-diegetic move this whole quad exists to avoid.
      uStrength: { value: 1.0 },
      uCorona: { value: CHANNELS[DEFAULT_CHANNEL].corona },
      uDiscR: { value: CORONA_DISC_R },
      uExposure: { value: 1.4 },
      uMap: { value: BLACK_1PX as THREE.Texture },
      uHasMap: { value: 0 },
      uRhef: { value: BLACK_1PX as THREE.Texture },
      uHasRhef: { value: 0 },
      uRhefDiscR: { value: RHEF_DISC_R },
      uLookMix: { value: 0 },
      uRhefExposure: { value: RHEF_EXPOSURE },
      // These were missing, and a missing uniform reads as zero rather than
      // failing, so `uHasRainbow > 0.5` was silently false and the corona never
      // once rendered the rainbow — it fell through to the JP2 branch, whose
      // off-limb field is nearly empty. That is what "the corona is too faint"
      // actually was.
      uRainR: { value: BLACK_1PX as THREE.Texture },
      uRainG: { value: BLACK_1PX as THREE.Texture },
      uRainB: { value: BLACK_1PX as THREE.Texture },
      uHasRainbow: { value: 0 },
      uQuadR: { value: CORONA_SIZE / 2 / 1.6 },  // quad half-width, in solar radii
      uHover: { value: 0 },
    }),
    []
  );

  // One turn per Carrington rotation, tied to the date itself — so winding the
  // date winds the Sun, and the two are the same gesture rather than two
  // things that happen to move at once (Gilly, 2026-08-25). Set, not eased: it
  // IS the date, and easing would mean the Sun briefly showed a rotation phase
  // belonging to no date at all.
  useEffect(() => {
    const ms = new Date(`${date || "2015-01-01"}T12:00:00Z`).getTime();
    const days = Number.isNaN(ms) ? 0 : ms / 86400000;
    uniforms.uSpin.value = (days / 27.2753) * Math.PI * 2;
  }, [date, uniforms]);

  useEffect(() => {
    uniforms.uMap.value = tex ?? BLACK_1PX;
    uniforms.uHasMap.value = tex ? 1 : 0;
    // the corona reads the SAME frame as the disk — one texture, one identity
    coronaUniforms.uMap.value = tex ?? BLACK_1PX;
    coronaUniforms.uHasMap.value = tex ? 1 : 0;
    const haveRainbow = rain.length === 3;
    uniforms.uRainR.value = haveRainbow ? rain[0] : BLACK_1PX;
    uniforms.uRainG.value = haveRainbow ? rain[1] : BLACK_1PX;
    uniforms.uRainB.value = haveRainbow ? rain[2] : BLACK_1PX;
    uniforms.uHasRainbow.value = haveRainbow ? 1 : 0;
    coronaUniforms.uRainR.value = haveRainbow ? rain[0] : BLACK_1PX;
    coronaUniforms.uRainG.value = haveRainbow ? rain[1] : BLACK_1PX;
    coronaUniforms.uRainB.value = haveRainbow ? rain[2] : BLACK_1PX;
    coronaUniforms.uHasRainbow.value = haveRainbow ? 1 : 0;
    uniforms.uRhef.value = rhefTex ?? BLACK_1PX;
    uniforms.uHasRhef.value = rhefTex ? 1 : 0;
    coronaUniforms.uRhef.value = rhefTex ?? BLACK_1PX;
    coronaUniforms.uHasRhef.value = rhefTex ? 1 : 0;
  }, [tex, rhefTex, rain, uniforms, coronaUniforms]);

  useFrame((state, dt) => {
    // billboard: the corona is a flat quad, so it must always face the camera
    if (corona.current) corona.current.quaternion.copy(state.camera.quaternion);
    const { channel: ch, quality, reducedMotion } = useStore.getState();
    const c = CHANNELS[ch];
    tint.current.set(c.tint);
    hot.current.set(c.hot);
    const k = 1 - Math.exp(-dt / 0.26);
    (uniforms.uTint.value as THREE.Color).lerp(tint.current, k);
    (uniforms.uHot.value as THREE.Color).lerp(hot.current, k);
    (coronaUniforms.uTint.value as THREE.Color).lerp(hot.current, k);
    // ease the corona weight with the channel so a swap does not pop
    coronaUniforms.uCorona.value += (c.corona - coronaUniforms.uCorona.value) * k;
    uniforms.uTime.value += reducedMotion ? 0 : dt;
    uniforms.uOctaves.value = quality === "high" ? 6 : quality === "medium" ? 4 : 3;
    // resolve procedural -> photo (or back) over ~0.5s
    const target = uniforms.uHasMap.value;
    uniforms.uMapMix.value += (target - uniforms.uMapMix.value) * (1 - Math.exp(-dt / 0.5));
    // Time-lapse: walk the day's real frames, holding on each and dissolving
    // between. SECONDS_PER_FRAME is deliberately slow — this is the Sun's day
    // passing, not a flipbook.
    if (seq.length > 1) {
      seqT.current += dt / 2.6;
      const i = Math.floor(seqT.current) % seq.length;
      const f = seqT.current - Math.floor(seqT.current);
      uniforms.uMap.value = seq[i];
      uniforms.uHasMap.value = 1;
      uniforms.uNext.value = seq[(i + 1) % seq.length];
      uniforms.uHasNext.value = 1;
      // hold, then dissolve, so each observation is actually legible
      uniforms.uSeqMix.value = THREE.MathUtils.smoothstep(f, 0.62, 1.0);
    } else {
      uniforms.uHasNext.value = 0;
    }
    const wantRhef = useStore.getState().look === "rhef" && uniforms.uHasRhef.value > 0.5 ? 1 : 0;
    const lm = uniforms.uLookMix.value + (wantRhef - uniforms.uLookMix.value) * (1 - Math.exp(-dt / 0.6));
    uniforms.uLookMix.value = lm;
    coronaUniforms.uLookMix.value = lm;
    const wantHover = hover.current && armed() ? 1 : 0;
    coronaUniforms.uHover.value +=
      (wantHover - coronaUniforms.uHover.value) * (1 - Math.exp(-dt / 0.18));
    // never leave the cursor as a pointer once the beat has moved on
    if (!armed() && hover.current) {
      hover.current = false;
      document.body.style.cursor = "auto";
    }
  });

  return (
    <>
      <mesh
        visible={visible}
        ref={(m) => {
          if (diskOccluderRef) diskOccluderRef.current = m;
        }}
      >
        <icosahedronGeometry args={[1.6, 12]} />
        <shaderMaterial
          vertexShader={vertex}
          fragmentShader={fragment}
          uniforms={uniforms}
          toneMapped={false}
        />
      </mesh>
      {/* Corona quad, kept facing the camera in useFrame below. */}
      <mesh
        ref={corona}
        visible={visible}
        onPointerOver={(e) => {
          if (useStore.getState().dateDragging) return;  // the tail of a sky-drag, not a tap
          if (!armed() || !onCorona(e.uv)) return;
          e.stopPropagation();
          hover.current = true;
          document.body.style.cursor = "pointer";
        }}
        onPointerMove={(e) => {
          if (!armed()) return;
          const on = onCorona(e.uv);
          if (on !== hover.current) {
            hover.current = on;
            document.body.style.cursor = on ? "pointer" : "auto";
          }
        }}
        onPointerOut={() => {
          hover.current = false;
          document.body.style.cursor = "auto";
        }}
        onClick={(e) => {
          if (!armed() || !onCorona(e.uv)) return;
          e.stopPropagation();
          const st = useStore.getState();
          st.setLook(st.look === "rhef" ? "raw" : "rhef");
        }}
      >
        <planeGeometry args={[CORONA_SIZE, CORONA_SIZE]} />
        <shaderMaterial
          vertexShader={coronaVertex}
          fragmentShader={coronaFragment}
          uniforms={coronaUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
    </>
  );
}
