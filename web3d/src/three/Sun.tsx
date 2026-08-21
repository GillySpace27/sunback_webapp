import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";
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
    // fast path: once the photo has fully resolved, skip the expensive fbm
    // plasma entirely (its result would be discarded by the mix anyway)
    if (uHasMap > 0.5 && uMapMix > 0.99) {
      vec2 muv = (vPos.xy / 1.6) * uDiscR + 0.5;
      vec3 photo = texture2D(uMap, muv).rgb * uExposure;
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

    vec3 p = vPos * 2.4;
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

  void main() {
    float r = length(vUv - 0.5);

    // Feather across the limb so the annulus meets the sphere without a seam,
    // and fade before the texture's own edge so the field does not end in a
    // hard circular cut against the void.
    float inner = smoothstep(uDiscR * 0.97, uDiscR * 1.05, r);
    float outer = 1.0 - smoothstep(0.40, 0.499, r);
    float mask = inner * outer;
    if (mask <= 0.001) discard;

    vec3 col;
    if (uHasRhef > 0.5 && uLookMix > 0.001) {
      // The RHEF frame is the point of this SKU: in the coronal channels (171
      // especially) it carries real off-limb structure — plumes, streamer fans,
      // the dark lanes between them — that the JP2 threw away at byte-scaling.
      // Its field is narrower, so remap the annulus onto this quad's uv.
      float rr = (r - uDiscR) / (0.5 - uDiscR);          // 0 at limb, 1 at edge
      float rRhef = uRhefDiscR + rr * (0.5 - uRhefDiscR);
      vec2 dir = normalize(vUv - 0.5 + vec2(1e-6));
      vec3 rhefCol = texture2D(uRhef, dir * rRhef + 0.5).rgb * uRhefExposure;
      // Past ~1.25 Rsun even 171 drops under the noise floor and RHEF
      // faithfully equalises the noise; fade the far field rather than sell
      // speckle as corona.
      float noiseGate = 1.0 - smoothstep(0.62, 0.92, rr);
      vec3 rawCol = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb * uExposure : vec3(0.0);
      col = mix(rawCol, rhefCol * noiseGate * uCorona, uLookMix);
    } else if (uHasMap > 0.5) {
      // the real off-disk data, at the same exposure the disk uses
      col = texture2D(uMap, vUv).rgb * uExposure;
    } else {
      // loading state only: a neutral falloff so the Sun is not a bare cut
      // while the frame is still in flight
      float t = clamp((r - uDiscR) / (0.5 - uDiscR), 0.0, 1.0);
      col = uTint * pow(1.0 - t, 6.0) * 0.5;
    }

    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(col * uStrength * mask, lum * mask);
  }
`;

const BLACK_1PX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLACK_1PX.needsUpdate = true;

export default function Sun() {
  const corona = useRef<THREE.Mesh>(null);
  const tint = useRef(new THREE.Color(CHANNELS[5].tint));
  const hot = useRef(new THREE.Color(CHANNELS[5].hot));

  // the real texture is loaded centrally (useSunTextureLoader) and published to
  // the store; null while loading/on error, so we fall back to the plasma
  const tex = useStore((s) => s.currentTexture);
  const rhefTex = useStore((s) => s.rhefTexture) as THREE.Texture | null;
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
      uCorona: { value: CHANNELS[5].corona },
      uDiscR: { value: CORONA_DISC_R },
      uExposure: { value: 1.4 },
      uMap: { value: BLACK_1PX as THREE.Texture },
      uHasMap: { value: 0 },
      uRhef: { value: BLACK_1PX as THREE.Texture },
      uHasRhef: { value: 0 },
      uRhefDiscR: { value: RHEF_DISC_R },
      uLookMix: { value: 0 },
      uRhefExposure: { value: RHEF_EXPOSURE },
    }),
    []
  );

  useEffect(() => {
    uniforms.uMap.value = tex ?? BLACK_1PX;
    uniforms.uHasMap.value = tex ? 1 : 0;
    // the corona reads the SAME frame as the disk — one texture, one identity
    coronaUniforms.uMap.value = tex ?? BLACK_1PX;
    coronaUniforms.uHasMap.value = tex ? 1 : 0;
    uniforms.uRhef.value = rhefTex ?? BLACK_1PX;
    uniforms.uHasRhef.value = rhefTex ? 1 : 0;
    coronaUniforms.uRhef.value = rhefTex ?? BLACK_1PX;
    coronaUniforms.uHasRhef.value = rhefTex ? 1 : 0;
  }, [tex, rhefTex, uniforms, coronaUniforms]);

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
    const wantRhef = useStore.getState().look === "rhef" && uniforms.uHasRhef.value > 0.5 ? 1 : 0;
    const lm = uniforms.uLookMix.value + (wantRhef - uniforms.uLookMix.value) * (1 - Math.exp(-dt / 0.6));
    uniforms.uLookMix.value = lm;
    coronaUniforms.uLookMix.value = lm;
  });

  return (
    <>
      <mesh visible={visible}>
        <icosahedronGeometry args={[1.6, 12]} />
        <shaderMaterial
          vertexShader={vertex}
          fragmentShader={fragment}
          uniforms={uniforms}
          toneMapped={false}
        />
      </mesh>
      {/* Corona quad, kept facing the camera in useFrame below. */}
      <mesh ref={corona} visible={visible}>
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
