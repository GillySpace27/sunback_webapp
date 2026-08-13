// Handoff to the original front end (product + editor + checkout) and the
// Helioviewer texture endpoint. The 3D site owns only the image identity
// (date + wavelength); the deep link carries it and the original hydrates the
// same path a real date submit uses (see PRODUCT_CREATION_CONTRACT.md).

// Where the original front end lives (its origin is also the API origin). The
// store is served at the site ROOT (the 3D experience is hosted under
// /experience/). NOTE: /store/ 404s in production — the store is at "/".
export const ORIGINAL_SITE =
  import.meta.env.VITE_ORIGINAL_SITE || "https://myheliograph.com";
export const STORE_PATH = import.meta.env.VITE_STORE_PATH || "/";

// Texture API base. "" = same-origin (prod when co-hosted; dev via Vite proxy).
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Which product CATEGORY each 3D gallery object represents, so clicking a piece
// deep-links to that section of the store's product grid (not a specific product).
// One object per PRODUCT_CATEGORY_ORDER category in api/products.js (values must match).
export const GALLERY_CATEGORY = {
  print: "wall",
  pillow: "home",
  mug: "drink",
  tee: "apparel",
  phone: "desk",
  ornament: "gifts",
} as const;
export type GalleryKind = keyof typeof GALLERY_CATEGORY;

// Deep link that lands the buyer at the store with identity preloaded. Optional
// `cat` scrolls the product grid to a category group (from a gallery piece).
export function buyUrl(
  date: string,
  time: string,
  angstrom: number,
  opts?: { cat?: string; tune?: boolean }
) {
  const q = new URLSearchParams({ d: date, t: time || "12:00", wl: String(angstrom) });
  if (opts?.cat) q.set("cat", opts.cat);
  // `tune` lands the visitor on the store's fine-tune panel with that day's HEK
  // events listed. The experience has already settled the date and wavelength,
  // so the one genuinely open question is WHICH MOMENT of the day — and that is
  // far easier to answer with the day's flares and CMEs in front of you than
  // from a bare time field.
  if (opts?.tune) q.set("tune", "1");
  return `${ORIGINAL_SITE}${STORE_PATH}?${q.toString()}`;
}

// Wake the scale-to-zero backend on buy-intent so the handoff isn't a cold
// start. Fire-and-forget; no-cors so it works cross-origin without a preflight.
let lastWarm = 0;
export function warmBackend() {
  const now = Date.now();
  if (now - lastWarm < 5000) return;
  lastWarm = now;
  try {
    fetch(`${ORIGINAL_SITE}/api/health`, { mode: "no-cors", cache: "no-store" }).catch(() => {});
  } catch {
    /* warm-up only */
  }
}

// Real full-disk SDO/AIA JPG for a date + wavelength. FOV is kept at ~3072"
// (disk ~62% of frame) by scaling image_scale with size.
export function thumbUrl(date: string, time: string, angstrom: number, size = 1024) {
  const hh = (time || "12:00").slice(0, 2);
  const iso = `${date}T${hh}:00:00Z`;
  const scale = Math.max(1, Math.round(3072 / size)); // arcsec/pixel
  const q = new URLSearchParams({
    date: iso,
    wavelength: String(angstrom),
    image_scale: String(scale),
    size: String(size),
  });
  return `${API_BASE}/api/helioviewer_thumb?${q.toString()}`;
}
