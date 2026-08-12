// Handoff to the original front end (product + editor + checkout) and the
// Helioviewer texture endpoint. The 3D site owns only the image identity
// (date + wavelength); the deep link carries it and the original hydrates the
// same path a real date submit uses (see PRODUCT_CREATION_CONTRACT.md).

// Where the original front end lives (its origin is also the API origin).
export const ORIGINAL_SITE =
  import.meta.env.VITE_ORIGINAL_SITE || "https://myheliograph.com";

// Texture API base. "" = same-origin (prod when co-hosted; dev via Vite proxy).
export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

// Deep link that lands the buyer at product/editor with identity preloaded.
export function buyUrl(date: string, time: string, angstrom: number, product?: string) {
  const q = new URLSearchParams({ d: date, t: time || "12:00", wl: String(angstrom) });
  if (product) q.set("p", product);
  return `${ORIGINAL_SITE}/?${q.toString()}`;
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
