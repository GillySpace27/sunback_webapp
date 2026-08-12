import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useStore } from "../store";
import { CHANNELS } from "../data/wavelengths";

// Procedural plasma sphere. fbm noise -> granulation; the same geometry
// recolors per wavelength by lerping two color uniforms (tint + hot core).
// This is the only heavy shader in the scene; everything else is cheap.
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
  uniform float uOctaves; // quality knob: fewer octaves on weak GPUs

  // hash / value-noise fbm
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
    vec3 p = vPos * 2.4;
    // domain-warped granulation, slowly convecting
    float t = uTime * 0.06;
    float warp = fbm(p + vec3(0.0, t, 0.0));
    float n = fbm(p * 1.6 + warp * 1.4 + vec3(t, 0.0, -t));
    n = smoothstep(-0.6, 0.9, n);

    // limb darkening: dimmer toward the edge (grazing view)
    float limb = pow(clamp(dot(vN, vView), 0.0, 1.0), 0.55);

    vec3 base = uTint * (0.25 + 0.75 * n);
    vec3 col = mix(vec3(0.02), base, limb);
    // hot cores where granulation peaks
    col += uHot * pow(n, 5.0) * limb * 1.4;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export default function Sun() {
  const mat = useRef<THREE.ShaderMaterial>(null!);
  const tint = useRef(new THREE.Color(CHANNELS[5].tint));
  const hot = useRef(new THREE.Color(CHANNELS[5].hot));

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uTint: { value: tint.current.clone() },
      uHot: { value: hot.current.clone() },
      uOctaves: { value: 6 },
    }),
    []
  );

  useFrame((_, dt) => {
    const { channel, quality, reducedMotion } = useStore.getState();
    const ch = CHANNELS[channel];
    // lerp color toward selected channel (600ms-ish crossfade feel)
    tint.current.set(ch.tint);
    hot.current.set(ch.hot);
    (uniforms.uTint.value as THREE.Color).lerp(tint.current, 0.08);
    (uniforms.uHot.value as THREE.Color).lerp(hot.current, 0.08);
    uniforms.uTime.value += reducedMotion ? dt * 0.15 : dt;
    uniforms.uOctaves.value = quality === "high" ? 6 : quality === "medium" ? 4 : 3;
  });

  return (
    <mesh>
      <icosahedronGeometry args={[1.6, 64]} />
      <shaderMaterial
        ref={mat}
        vertexShader={vertex}
        fragmentShader={fragment}
        uniforms={uniforms}
        toneMapped={false}
      />
    </mesh>
  );
}
