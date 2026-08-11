/**
 * Fidelity gate for the server-side print compositor.
 *
 * The unit tests pin the formulas; this answers the only question that
 * matters commercially: does the file the SERVER would print match what the
 * BROWSER showed the customer? It renders the same parameters through a real
 * Chromium canvas using the same transform order as renderCanvas, runs the
 * Python compositor over the same source, and reports per-case pixel deltas.
 *
 *   node api/scripts/compare_print_compose.mjs
 *
 * Exits non-zero if any case exceeds the tolerance. Resampling differs
 * (browser bilinear vs PIL bicubic) so exact equality is not the bar; the
 * bar is "no visible difference at print scale".
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'printcmp-'));
const REPO = new URL('../..', import.meta.url).pathname;

// Deterministic, feature-rich source: gradients catch colour errors, the
// off-centre disc catches geometry errors.
const SRC_PX = 512;
const mkSourceJs = `
  const c = document.createElement('canvas'); c.width = ${SRC_PX}; c.height = ${SRC_PX};
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0,0,${SRC_PX},${SRC_PX});
  g.addColorStop(0,'#301c0a'); g.addColorStop(0.5,'#c8781e'); g.addColorStop(1,'#f6e2b0');
  x.fillStyle = g; x.fillRect(0,0,${SRC_PX},${SRC_PX});
  x.fillStyle = '#ffffff'; x.beginPath(); x.arc(${SRC_PX*0.42}, ${SRC_PX*0.55}, ${SRC_PX*0.22}, 0, 7); x.fill();
  x.fillStyle = '#2b0f00'; x.fillRect(${SRC_PX*0.7}, ${SRC_PX*0.1}, ${SRC_PX*0.18}, ${SRC_PX*0.3});
  return c.toDataURL('image/png');
`;

const CASES = [
  { name: 'identity',        params: {} },
  { name: 'aspect-11x14',    params: { aspectRatio: { w: 11, h: 14 } } },
  { name: 'aspect-landscape',params: { aspectRatio: { w: 2250, h: 1650 } } },
  { name: 'zoom-140',        params: { cropZoom: 140 } },
  { name: 'zoom-pan',        params: { cropZoom: 160, panX: 300, panY: 200 } },
  { name: 'colour',          params: { brightness: 15, contrast: 25, saturation: 130 } },
  { name: 'hue-45',          params: { hue: 45 } },
  { name: 'desaturated',     params: { saturation: 0 } },
  { name: 'inverted',        params: { inverted: true } },
  { name: 'flip-h',          params: { flipH: true } },
  { name: 'rotate-90',       params: { rotation: 90 } },
  { name: 'vignette',        params: { vignette: 60, vignetteWidth: 70, vignetteFade: 'black' } },
  { name: 'feather',         params: { cropEdgeFeatherX: 60, vignetteFade: 'black' } },
  { name: 'circle-clock',    params: { printShape: 'circle', aspectRatio: { w: 1, h: 1 } } },
  { name: 'combined',        params: { aspectRatio: { w: 11, h: 14 }, cropZoom: 130, panX: 280,
                                       brightness: 10, contrast: 15, saturation: 115,
                                       vignette: 40, vignetteWidth: 60, vignetteFade: 'black' } },
];

// Mirror of renderCanvas's geometry + colour stages, run in a real canvas.
const RENDER_JS = `(srcDataUrl, p) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const srcW = img.naturalWidth, srcH = img.naturalHeight;
    const rot = p.rotation || 0;
    const rotated = (rot % 180) !== 0;
    let refCW = rotated ? srcH : srcW, refCH = rotated ? srcW : srcH;
    let cw = refCW, ch = refCH;
    const ar = p.aspectRatio;
    if (ar && ar.w && ar.h) {
      const R = ar.w / ar.h;
      if (R >= refCW / refCH) { cw = refCW; ch = Math.max(1, Math.floor(refCW / R)); }
      else { ch = refCH; cw = Math.max(1, Math.floor(refCH * R)); }
    }
    const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const zoom = (p.cropZoom || 100) / 100;
    const panX = (p.panX != null ? p.panX : refCW / 2);
    const panY = (p.panY != null ? p.panY : refCH / 2);
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(zoom, zoom);
    ctx.translate(-panX, -panY);
    ctx.translate(refCW / 2, refCH / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(p.flipH ? -1 : 1, p.flipV ? -1 : 1);
    ctx.translate(-refCW / 2, -refCH / 2);
    const scaleImg = Math.max(refCW / srcW, refCH / srcH);
    const dW = srcW * scaleImg, dH = srcH * scaleImg;
    ctx.drawImage(img, 0, 0, srcW, srcH, (refCW - dW) / 2, (refCH - dH) / 2, dW, dH);
    ctx.restore();

    const isCirc = p.printShape === 'circle' || p.productId === 'wall_clock';
    const need = (p.brightness||0)!==0 || (p.contrast||0)!==0 || (p.saturation??100)!==100 ||
                 p.inverted || (p.vignette||0)>0 || (p.cropEdgeFeatherX||0)>0 ||
                 (p.cropEdgeFeatherY||0)>0 || (p.hue||0)!==0;
    if (need) {
      const id = ctx.getImageData(0, 0, cw, ch); const d = id.data;
      const br = p.brightness || 0, co = (p.contrast || 0) / 100;
      const factor = (259 * (co * 255 + 255)) / (255 * (259 - co * 255));
      const sat = (p.saturation ?? 100) / 100;
      const hueDeg = p.hue || 0, applyHue = (hueDeg % 360) !== 0;
      const hc = Math.cos(hueDeg * Math.PI/180), hs = Math.sin(hueDeg * Math.PI/180);
      const hrr=0.213+0.787*hc-0.213*hs, hrg=0.715-0.715*hc-0.715*hs, hrb=0.072-0.072*hc+0.928*hs;
      const hgr=0.213-0.213*hc+0.143*hs, hgg=0.715+0.285*hc+0.140*hs, hgb=0.072-0.072*hc-0.283*hs;
      const hbr=0.213-0.213*hc-0.787*hs, hbg=0.715-0.715*hc+0.715*hs, hbb=0.072+0.928*hc+0.072*hs;
      const applyVig = (p.vignette||0) > 0;
      const cx = cw/2, cy = ch/2;
      const maxR = isCirc ? Math.min(cw,ch)/2 : Math.sqrt(cx*cx+cy*cy);
      const vigR = maxR * (1 - (p.vignette||0)/100*0.9);
      const vwf = (p.vignetteWidth||0)/100;
      const afx = (p.cropEdgeFeatherX||0) > 0, afy = (p.cropEdgeFeatherY||0) > 0;
      const efwx = ((p.cropEdgeFeatherX||0)/100)*(cw*0.25), efwy = ((p.cropEdgeFeatherY||0)/100)*(ch*0.25);
      const fade = p.vignetteFade || 'transparent';
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i+1], b = d[i+2];
        if (p.inverted) { r = 255-r; g = 255-g; b = 255-b; }
        r += br; g += br; b += br;
        r = factor*(r-128)+128; g = factor*(g-128)+128; b = factor*(b-128)+128;
        const gray = 0.2989*r + 0.587*g + 0.114*b;
        r = gray + sat*(r-gray); g = gray + sat*(g-gray); b = gray + sat*(b-gray);
        if (applyHue) { const R2=hrr*r+hrg*g+hrb*b, G2=hgr*r+hgg*g+hgb*b, B2=hbr*r+hbg*g+hbb*b; r=R2; g=G2; b=B2; }
        const px = (i/4) % cw, py = Math.floor((i/4)/cw);
        const paint = (t) => {
          if (fade === 'transparent') d[i+3] = d[i+3]*(1-t);
          else if (fade === 'black') { r=r*(1-t); g=g*(1-t); b=b*(1-t); }
          else if (fade === 'white') { r=r*(1-t)+255*t; g=g*(1-t)+255*t; b=b*(1-t)+255*t; }
        };
        if (applyVig) {
          const dx = px-cx, dy = py-cy, dist = Math.sqrt(dx*dx+dy*dy);
          if (dist > vigR) {
            const fadeLen = (maxR-vigR)*vwf;
            let t = fadeLen > 0.5 ? Math.min((dist-vigR)/fadeLen, 1) : 1;
            t = t*t*(3-2*t); paint(t);
          }
        }
        if (afx || afy) {
          let etx = 0, ety = 0;
          if (afx) { const dEx = Math.min(px, (cw-1)-px); if (dEx < efwx) { const raw = 1-(dEx/efwx); etx = raw*raw*(3-2*raw); } }
          if (afy) { const dEy = Math.min(py, (ch-1)-py); if (dEy < efwy) { const raw = 1-(dEy/efwy); ety = raw*raw*(3-2*raw); } }
          const eT = etx > ety ? etx : ety; if (eT > 0) paint(eT);
        }
        d[i] = r; d[i+1] = g; d[i+2] = b;
      }
      ctx.putImageData(id, 0, 0);
    }
    if (isCirc) {
      const t = document.createElement('canvas'); t.width = cw; t.height = ch;
      const tc = t.getContext('2d');
      tc.beginPath(); tc.arc(cw/2, ch/2, Math.min(cw,ch)/2, 0, Math.PI*2); tc.clip();
      tc.drawImage(cv, 0, 0);
      ctx.clearRect(0,0,cw,ch); ctx.drawImage(t,0,0);
    }
    resolve(cv.toDataURL('image/png'));
  };
  img.src = srcDataUrl;
})`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
const srcDataUrl = await page.evaluate(new Function(mkSourceJs));
const srcPath = join(TMP, 'src.png');
writeFileSync(srcPath, Buffer.from(srcDataUrl.split(',')[1], 'base64'));

let worst = 0, failures = 0;
console.log('case                 mean|Δ|   p99|Δ|   maxΔ   verdict');
console.log('-------------------------------------------------------');
for (const c of CASES) {
  const outUrl = await page.evaluate(
    ([js, src, p]) => new Function('return ' + js)()(src, p),
    [RENDER_JS, srcDataUrl, c.params]
  );
  const browserPath = join(TMP, `${c.name}.browser.png`);
  writeFileSync(browserPath, Buffer.from(outUrl.split(',')[1], 'base64'));

  const serverPath = join(TMP, `${c.name}.server.png`);
  writeFileSync(join(TMP, `${c.name}.json`), JSON.stringify(c.params));
  execFileSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(REPO)})
from api.print_compose import compose
compose(${JSON.stringify(srcPath)}, json.load(open(${JSON.stringify(join(TMP, c.name + '.json'))})), ${JSON.stringify(serverPath)})
`], { stdio: 'pipe' });

  const stats = JSON.parse(execFileSync('python3', ['-c', `
import json, numpy as np
from PIL import Image
a = np.asarray(Image.open(${JSON.stringify(browserPath)}).convert('RGBA')).astype(float)
b = np.asarray(Image.open(${JSON.stringify(serverPath)}).convert('RGBA')).astype(float)
if a.shape != b.shape:
    print(json.dumps({"shape_mismatch": [list(a.shape), list(b.shape)]})); raise SystemExit
d = np.abs(a[...,:3] - b[...,:3])
print(json.dumps({"mean": float(d.mean()), "p99": float(np.percentile(d, 99)), "max": float(d.max())}))
`], { encoding: 'utf8' }));

  if (stats.shape_mismatch) {
    console.log(`${c.name.padEnd(20)} SHAPE MISMATCH ${JSON.stringify(stats.shape_mismatch)}`);
    failures++; continue;
  }
  // Tolerance: mean under 2/255 is imperceptible; p99 under 12 allows the
  // resampling seam at hard edges without hiding a real transform error.
  const ok = stats.mean < 2.0 && stats.p99 < 12;
  if (!ok) failures++;
  worst = Math.max(worst, stats.mean);
  console.log(`${c.name.padEnd(20)} ${stats.mean.toFixed(3).padStart(7)} ${stats.p99.toFixed(1).padStart(8)} ${stats.max.toFixed(0).padStart(6)}   ${ok ? 'ok' : 'FAIL'}`);
}
await browser.close();
console.log(`\nartifacts: ${TMP}`);
console.log(failures ? `${failures} case(s) FAILED` : `all ${CASES.length} cases within tolerance (worst mean ${worst.toFixed(3)}/255)`);
process.exit(failures ? 1 : 0);
