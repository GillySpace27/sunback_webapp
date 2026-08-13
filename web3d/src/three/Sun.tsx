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
      gl_FragColor = vec4(texture2D(uMap, muv).rgb * uExposure, 1.0);
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

const BLACK_1PX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
BLACK_1PX.needsUpdate = true;

export default function Sun() {
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

  useEffect(() => {
    uniforms.uMap.value = tex ?? BLACK_1PX;
    uniforms.uHasMap.value = tex ? 1 : 0;
  }, [tex, uniforms]);

  useFrame((_, dt) => {
    const { channel: ch, quality, reducedMotion } = useStore.getState();
    const c = CHANNELS[ch];
    tint.current.set(c.tint);
    hot.current.set(c.hot);
    const k = 1 - Math.exp(-dt / 0.26);
    (uniforms.uTint.value as THREE.Color).lerp(tint.current, k);
    (uniforms.uHot.value as THREE.Color).lerp(hot.current, k);
    uniforms.uTime.value += reducedMotion ? 0 : dt;
    uniforms.uOctaves.value = quality === "high" ? 6 : quality === "medium" ? 4 : 3;
    // resolve procedural -> photo (or back) over ~0.5s
    const target = uniforms.uHasMap.value;
    uniforms.uMapMix.value += (target - uniforms.uMapMix.value) * (1 - Math.exp(-dt / 0.5));
  });

  return (
    <mesh visible={visible}>
      <icosahedronGeometry args={[1.6, 12]} />
      <shaderMaterial
        vertexShader={vertex}
        fragmentShader={fragment}
        uniforms={uniforms}
        toneMapped={false}
      />
    </mesh>
  );
}
