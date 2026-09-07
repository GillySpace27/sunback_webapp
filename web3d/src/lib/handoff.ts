// Handoff to the original front end (product + editor + checkout) and the
// Helioviewer texture endpoint. The 3D site owns only the image identity
// (date + wavelength); the deep link carries it and the original hydrates the
// same path a real date submit uses (see PRODUCT_CREATION_CONTRACT.md).

// Where the original front end lives (its origin is also the API origin).
// As of 2026-08-23 the 3D experience IS the landing page, served at "/", and
// the flat store moved to "/store" — so every buy link and the Skip-to-store
// control point there. (This comment previously warned that /store/ 404s;
// that stopped being true when build-public.sh started writing it.)
// Empty = SAME ORIGIN, which is now the truth everywhere: the film and the
// store are one deployment (film at "/", store at "/store"). The hardcoded
// production origin dated from when they were separate hosts, and it meant
// every buy link and the Skip-to-store control jumped to
// https://myheliograph.com from WHEREVER it was running — so on the dev tier
// "skip to the store" silently left dev for production and the funnel could
// not be reviewed at all. Override with VITE_ORIGINAL_SITE if they are ever
// split across origins again.
export const ORIGINAL_SITE = import.meta.env.VITE_ORIGINAL_SITE ?? "";
export const STORE_PATH = import.meta.env.VITE_STORE_PATH || "/store";

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
export function skySettings(s: { showStars: boolean; showConstellations: boolean; showPlanets: boolean; showArt: boolean; showLabels: boolean; showGrid: boolean }) {
  return { stars: s.showStars, con: s.showConstellations, planets: s.showPlanets,
    art: s.showArt, labels: s.showLabels, grid: s.showGrid };
}

export function buyUrl(
  date: string,
  time: string,
  angstrom: number,
  opts?: { cat?: string; tune?: boolean; look?: "raw" | "rhef"; form?: "flat" | "dimensional"; sky?: ReturnType<typeof skySettings> }
) {
  // date arrives "" when the visitor has cleared the date field (see
  // store.ts's setDate) : SkipToStore leans on this to hand off a bare store
  // link rather than ever carry a missing/invalid date as d=. Omitting t
  // alongside it: a time with no date is meaningless.
  const q = date
    ? new URLSearchParams({ d: date, t: time || "12:00", wl: String(angstrom) })
    : new URLSearchParams({ wl: String(angstrom) });
  if (opts?.cat) q.set("cat", opts.cat);
  // `tune` lands the visitor on the store's fine-tune panel with that day's HEK
  // events listed. The experience has already settled the date and wavelength,
  // so the one genuinely open question is WHICH MOMENT of the day — and that is
  // far easier to answer with the day's flares and CMEs in front of you than
  // from a bare time field.
  if (opts?.tune) q.set("tune", "1");
  // The two axes of the store's handoff quad. Carried so the bridge opens
  // with the visitor's own choices already selected rather than asking the
  // same two questions the HUD just answered.
  if (opts?.look) q.set("look", opts.look);
  if (opts?.form) q.set("form", opts.form);
  if (opts?.sky) Object.entries(opts.sky).forEach(([key, value]) => q.set(key, value ? "1" : "0"));
  return `${ORIGINAL_SITE}${STORE_PATH}?${q.toString()}`;
}

// Wake the scale-to-zero backend on buy-intent so the handoff isn't a cold
// start. Fire-and-forget by most callers; no-cors so it works cross-origin
// without a preflight. Returns a promise that settles once the ping lands (or
// fails) so BuyLink can race it against a real "is the backend up" signal
// instead of holding a blind fixed delay before navigating.
let lastWarm = 0;
export function warmBackend(): Promise<void> {
  const now = Date.now();
  if (now - lastWarm < 5000) return Promise.resolve();
  lastWarm = now;
  return fetch(`${ORIGINAL_SITE}/api/health`, { mode: "no-cors", cache: "no-store" })
    .then(() => undefined)
    .catch(() => undefined);
}

// Real full-disk SDO/AIA JPG for a date + wavelength. FOV is kept at ~3072"
// (disk ~62% of frame) by scaling image_scale with size.
export function thumbUrl(date: string, time: string, angstrom: number, size = 1024) {
  const iso = `${date}T${time || "12:00"}:00Z`;
  const scale = Math.max(1, Math.round(3072 / size)); // arcsec/pixel
  const q = new URLSearchParams({
    date: iso,
    wavelength: String(angstrom),
    image_scale: String(scale),
    size: String(size),
  });
  return `${API_BASE}/api/helioviewer_thumb?${q.toString()}`;
}
