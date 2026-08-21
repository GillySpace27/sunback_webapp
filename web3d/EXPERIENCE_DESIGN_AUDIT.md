# /experience — creative-director audit

**Evidence base, stated up front.** One live rendered frame (the opening beat,
1280×720) plus the complete source. The Browser pane would not stay displayed
in this session, so WebGL stopped painting and beats 2–9 could not be seen.
Everything below is either visible in that one frame, or counted/derived from
source. Where a claim needs a rendered frame to settle, it says so and is not
implemented.

---

## The one-line diagnosis

The film is not generic in its *ideas* — the beat structure, the copy, the
scrim strategy per background, the honest RHEF framing are all better than
most studio work. It reads cheap for two mechanical reasons:

1. **The hero object does not behave like light.** The Sun is a matte sphere
   with a razor edge on black. It has no headroom above 1.0, so bloom has
   nothing to lift, and no corona geometry, so the star has no atmosphere.
2. **No repeating interval.** 11 tracking values, 7 type sizes in a 0.24rem
   band, 7 radii, 7 durations, two easing vocabularies. Each value is locally
   defensible; none is derived. The eye reads that as assembled, not designed.

(2) is fixed. (1) is specified below and deliberately not shipped.

---

## FIXED (committed, not deployed)

### F1 · A design system
`styles.css` `:root` now carries 3 type steps, 3 tracking steps tied to size
and case, 4 radii, 3 durations, one easing curve. All 40+ scattered literals
collapsed onto them. Counted after: 0 remaining literals in each category.

### F2 · Masthead hierarchy ran backwards
Title was weight 380; the tagline beneath it was 500 — the subordinate line
was the heaviest text in the block. Tagline → 400.

### F3 · The void was the wrong black
`--bg` was retuned to warm `#0a0908` so the seam into the store would not
shift temperature. `Scene.tsx` still cleared to `#05060a`, the old blue-black.
The 3D void and the HTML page behind it were two different blacks, and every
scrim, vignette and fade resolved toward the wrong one. Unified.

### F4 · Two unreachable style blocks
`.eyebrow` renders only for a COPY entry defining `eyebrow`; none does.
`.overlay-line--hero` renders only for the `threshold` space, deliberately
absent from COPY. Both blocks and the branches emitting them are gone.

---

## NOT SHIPPED — needs a rendered frame

### N1 · The Sun (highest value in the whole audit)

Three separate causes, all in `three/Sun.tsx`:

**(a) No dynamic range.** Output peaks near 1.0–1.4. `toneMapped={false}`
bypasses ACES, so highlights clip flat instead of rolling off — the specific
look of cheap CG. A star wants the disk near 1.0 and its hot cores 4–20×, so
bloom reads as *light* rather than as a blurred texture.

```glsl
// after computing col, before gl_FragColor:
float core = pow(n, 3.0);
col *= 1.0 + 3.5 * core;        // HDR headroom for the bloom pass
```

**(b) The photo path throws away the limb.** The fast path is a flat blit:

```glsl
gl_FragColor = vec4(texture2D(uMap, muv).rgb * uExposure, 1.0);
```

No limb term, so once the real frame loads the Sun becomes a decal on a
sphere with a hard silhouette. Reinstate the falloff the procedural path
already computes:

```glsl
float limb = pow(clamp(dot(vN, vView), 0.0, 1.0), 0.55);
vec3 photo = texture2D(uMap, muv).rgb * uExposure;
gl_FragColor = vec4(photo * (0.55 + 0.45 * limb) * (1.0 + 2.5 * pow(limb, 6.0)), 1.0);
```

**(c) No corona.** Nothing renders outside the disk, and a star's identity is
mostly the atmosphere around it. Add an additive back-side shell sibling to
the existing mesh:

```tsx
<mesh visible={visible} scale={1.35}>
  <sphereGeometry args={[1.6, 48, 48]} />
  <shaderMaterial
    transparent depthWrite={false}
    side={THREE.BackSide}
    blending={THREE.AdditiveBlending}
    uniforms={coronaUniforms}      // { uTint, uTime }
    vertexShader={/* pass vN, vView as in the disk shader */}
    fragmentShader={/* glsl */`
      varying vec3 vN; varying vec3 vView; uniform vec3 uTint;
      void main(){
        float rim = 1.0 - clamp(dot(normalize(vN), normalize(vView)), 0.0, 1.0);
        float a = pow(rim, 3.2) * 0.9;         // tight, not a fog ball
        gl_FragColor = vec4(uTint * a * 2.2, a);
      }
    `}
  />
</mesh>
```

Tune `scale`, the `pow` exponent and the `2.2` on a real frame. Too much and
it becomes a lens-flare cliché, which is worse than the matte ball.

### N2 · Composition — the rule of thirds is intended but too small to read

`CameraRig.tsx:TGT[0]` is `[0.72, 0.46, 0]`, commented as putting the Sun on
the lower-left third. At 9 units with fov 45 and aspect 1.78 the frame is
≈13.3 units wide at the Sun's plane, so 0.72 moves it only **5.4% of frame
width** left of centre. The left third needs ≈2.2 units; the lower third
≈1.24.

```
TGT[0]: [0.72, 0.46, 0]  →  [2.2, 1.24, 0]
```

Do not apply alone. The masthead, hero date field and footer are all centred
on the same axis, so today everything stacks on one vertical line — the actual
reason the opening reads as a template. Moving the Sun to the third only works
if the copy moves off that axis with it (the deleted `.overlay-line--hero`
block was reaching for exactly this and had been dead for some time).

### N3 · The hero date field sits on the Sun

Visible in the captured frame: `PICK YOUR DATE` and its input land on the
disk's lower limb, and `THEN SCROLL INTO THE LIGHT` crosses the edge. The
brightest region of the composition is carrying the smallest text. Resolves
itself if N2 lands; otherwise `.hero-date { bottom: 16vh }` needs to clear the
disk, which is constrained below by `#buy` and `DataCredit`.

### N4 · Vignette

`Vignette offset 0.3, darkness 0.42` on top of an already near-black ground
compresses the corners toward the same value as the void, which flattens depth
rather than shaping it. Suggest `darkness 0.3`. Needs eyes.

---

## Smaller notes

- **Starfield is good** and should not be touched: two layers, differing
  `factor`/`saturation`/`speed`, real parallax. My first read from the
  screenshot was "uniform dots" and the source proved that wrong.
- **`Effects.tsx` DoF window** is well reasoned and matches the aperture beat.
- **The reduced-motion block** kills `animation` and `transition` globally,
  including the `.picker` reveal transform — a reduced-motion user gets the
  drawer snapping rather than a 1-frame settle. Consider exempting opacity.
