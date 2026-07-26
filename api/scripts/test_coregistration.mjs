/* Co-registration self-check for the editor's per-tier image scaling.
 *
 * Run: node api/scripts/test_coregistration.mjs
 *
 * The invariant: whichever tier is on screen, the SOLAR DISK must occupy the
 * same fraction of the frame. Break it and the framing visibly jumps as tiers
 * land — a disk that fit inside the round clock suddenly clips at the bottom
 * (Conner, 2026-07-26: "the HQ image is cropped before the bottom of the
 * clock").
 *
 * The subtlety this guards: the Helioviewer JPG covers 3000 arcsec while the
 * FITS frames cover 2458 (4096 px x 0.6 "/px), so the JPG needs a 1.22x
 * scale-up. That correction used to be keyed to `fmt === "jpg"`, but since the
 * Preview tier was folded into Original the JPG is also drawn UNDER fmt ===
 * "raw" as its instant first-paint — and silently missed the correction.
 */

const HV_FOV = 3000;              // arcsec across a Helioviewer screenshot
const FITS_FOV = 4096 * 0.6;      // arcsec across an AIA full-disk frame
const SUN_RADIUS_ARCSEC = 960;    // photospheric radius, near enough

// Mirrors _renderCanvasInner: cover-fit, then correct Helioviewer plate scale.
function diskFractionOfFrame({ fmt, imgW, imgH, imgFovArcsec, refCW, refCH, isJpgImage }) {
  let scaleImg = Math.max(refCW / imgW, refCH / imgH);
  if (fmt === "jpg" || isJpgImage) scaleImg *= HV_FOV / FITS_FOV;
  const arcsecPerSrcPx = imgFovArcsec / imgW;
  const diskRadiusSrcPx = SUN_RADIUS_ARCSEC / arcsecPerSrcPx;
  return (diskRadiusSrcPx * scaleImg) / refCW;   // disk radius / frame width
}

const REF = { refCW: 512, refCH: 512 };
const JPG  = { imgW: 384,  imgH: 384,  imgFovArcsec: HV_FOV,   isJpgImage: true  };
const FITS = { imgW: 4096, imgH: 4096, imgFovArcsec: FITS_FOV, isJpgImage: false };

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("ok  " + name); }
  else { console.log("FAIL " + name + "  " + detail); failures++; }
}

const fitsRaw = diskFractionOfFrame({ fmt: "raw", ...REF, ...FITS });
const jpgUnderRaw = diskFractionOfFrame({ fmt: "raw", ...REF, ...JPG });
const jpgUnderJpg = diskFractionOfFrame({ fmt: "jpg", ...REF, ...JPG });
const fitsHq = diskFractionOfFrame({ fmt: "hq_rhef", ...REF, ...FITS });

const near = (a, b) => Math.abs(a - b) < 0.005;

// The regression: JPG shown under the Original tier must match the FITS frame
// that replaces it. Pre-fix this was ~22% small.
check("JPG drawn under the Original tier co-registers with FITS",
  near(jpgUnderRaw, fitsRaw),
  `jpg=${jpgUnderRaw.toFixed(4)} fits=${fitsRaw.toFixed(4)}`);

check("JPG under its own legacy tier still co-registers",
  near(jpgUnderJpg, fitsRaw),
  `jpg=${jpgUnderJpg.toFixed(4)} fits=${fitsRaw.toFixed(4)}`);

check("HQ tier co-registers with Original",
  near(fitsHq, fitsRaw),
  `hq=${fitsHq.toFixed(4)} raw=${fitsRaw.toFixed(4)}`);

// Guard the guard: without the correction the mismatch must be big enough to
// see, or this test would pass for the wrong reason.
const uncorrected = (() => {
  let s = Math.max(REF.refCW / JPG.imgW, REF.refCH / JPG.imgH);
  const diskPx = SUN_RADIUS_ARCSEC / (HV_FOV / JPG.imgW);
  return (diskPx * s) / REF.refCW;
})();
check("uncorrected JPG really is visibly smaller (test is meaningful)",
  fitsRaw / uncorrected > 1.15,
  `ratio=${(fitsRaw / uncorrected).toFixed(3)}`);

console.log(failures === 0
  ? "all co-registration checks passed"
  : failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
