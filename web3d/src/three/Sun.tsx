import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";

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
      // The fast path used to blit the texture flat, with no limb term at all,
      // so the moment the real frame arrived the Sun stopped being a lit body
      // and became a decal on a sphere with a razor silhouette. Keep the limb
      // falloff the procedural branch computes, and push bright cores above
      // 1.0 so the bloom pass has real headroom: a star reads as light because
      // it blows out, not because it is orange.
      float limbF = pow(clamp(dot(vN, vView), 0.0, 1.0), 0.55);
      float lum = dot(photo, vec3(0.2126, 0.7152, 0.0722));
      photo *= 0.62 + 0.38 * limbF;
      photo *= 1.0 + 2.6 * pow(clamp(lum, 0.0, 1.0), 2.5);
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

// Corona.
//
// First attempt was the usual back-side shell, and it was geometrically wrong
// for this: on a back-side sphere the rim term peaks at the SHELL's own outer
// silhouette and saturates toward its centre, so it renders a bright ring at
// the far edge of the shell with a filled middle — a fried egg, not an
// atmosphere, and with bloom on top it washed the whole void brown.
//
// A camera-facing billboard puts the falloff where it actually belongs:
// anchored to the limb and decaying outward. The quad sits at the Sun's centre,
// so the sphere itself (which writes depth) occludes everything inside the
// limb, and only the annulus outside it survives.
const CORONA_SIZE = 8.0;                    // quad edge, world units
const CORONA_LIMB = (1.6 / (CORONA_SIZE / 2)); // where the disk edge falls in uv

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
  uniform vec3 uTint;
  uniform float uStrength;
  uniform float uLimb;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float t = clamp((r - uLimb) / (1.0 - uLimb), 0.0, 1.0);
    // two terms: a tight bright collar on the limb, plus a much fainter wide
    // halo, which is roughly how a real corona falls off and stops the glow
    // reading as a single soft ring
    float collar = pow(1.0 - t, 7.0);
    float halo = pow(1.0 - t, 2.0) * 0.22;
    float i = collar + halo;
    gl_FragColor = vec4(uTint * i * uStrength, i);
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
    }),
    []
  );

  const coronaUniforms = useMemo(
    () => ({
      uTint: { value: hot.current.clone() },
      uStrength: { value: 0.85 },
      uLimb: { value: CORONA_LIMB },
    }),
    []
  );

  useEffect(() => {
    uniforms.uMap.value = tex ?? BLACK_1PX;
    uniforms.uHasMap.value = tex ? 1 : 0;
  }, [tex, uniforms]);

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
    uniforms.uTime.value += reducedMotion ? 0 : dt;
    uniforms.uOctaves.value = quality === "high" ? 6 : quality === "medium" ? 4 : 3;
    // resolve procedural -> photo (or back) over ~0.5s
    const target = uniforms.uHasMap.value;
    uniforms.uMapMix.value += (target - uniforms.uMapMix.value) * (1 - Math.exp(-dt / 0.5));
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
