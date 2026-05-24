/* ===============================================================
   Solar Archive — shared editor state

   Step 2/N of the IIFE → ES-modules refactor. Pulled out of
   solar-archive.js so every other extracted module can `import
   { state }` from one canonical location instead of receiving it
   as a parameter through deep call chains.

   Two exports:
   - `state` — the central mutable singleton. Module exports of an
     object are reference-equal across all importers, so this
     translates the old closure-captured `state` 1:1 with zero
     change to call sites: every consumer mutates fields on the
     same object that the IIFE used to own.
   - `defaultMockupManifest` / `setDefaultMockupManifest` —
     re-assignable Phase B manifest. ES-module live bindings let
     consumers read `defaultMockupManifest` and always see the
     current value, but `let` bindings are read-only from outside
     the declaring module, so reassignment goes through the
     setter. Keeps the original "module-local var that the fetch
     handler writes once" semantics intact.
   =============================================================== */

export const state = {
  wavelength: 171,
  isDefaultActive: true,
  originalImage: null,
  editedImageData: null,
  brightness: 0,
  contrast: 0,
  saturation: 100,
  hue: 0,            // degrees, -180..+180; 0 = no rotation
  rotation: 0,
  flipH: false,
  flipV: false,
  inverted: false,
  cropping: false,
  cropStart: null,
  cropEnd: null,
  cropRatio: "1:1",
  cropZoom: 100,
  panX: 0,
  panY: 0,
  selectedProduct: null,
  hqReady: false,
  lastImageUrl: "",
  backendOnline: false,
  vignette: 24,
  vignetteWidth: 0,
  vignetteFade: "black",         // "transparent" | "black" | "white" | "mode" | "custom"
  vignetteFadeColor: "#000000",
  // Crop-edge feather is now split per-axis so users can soften the
  // left/right edges independently of the top/bottom (e.g. a wide
  // mug strip wants strong horizontal feather but minimal vertical).
  // 0–100 each; the SVG mask's feGaussianBlur takes "X Y" as
  // stdDeviation, so two channels map cleanly into one filter.
  cropEdgeFeatherX: 0,
  cropEdgeFeatherY: 0,
  textMode: false,
  hqImageUrl: null,   // URL of completed HQ PNG (separate from originalImage)
  hqTaskId: null,     // running HQ background task ID
  textOverlay: null,  // { text, x, y, size, font, color, strokeColor, strokeWidth }
  // Caption stamp (Tools → Timestamp). Just an on/off flag; the
  // displayed text is composed at render time from the active date,
  // noon UTC (matches the FITS/JPG fetch time), and wavelength.
  timestampStamp: false,
  // 2×3 grid: "top|bottom" + "-" + "left|center|right". Default to
  // bottom-right so the original placement is preserved.
  timestampPos: "bottom-right",
  // Pixel-fraction offset from the chosen vertical anchor, 0..100 →
  // 0..30% of the canvas's shorter dimension. Lets users nudge the
  // caption inward when it gets clipped by a corona / mockup bezel.
  timestampVOffset: 0,
  clockNumbers: null, // wall_clock only: { font, color, strokeColor, strokeWidth, size, radiusPct }
  mockups: {},         // { productId: { images: [{src, position, is_default}], printifyProductId } }
  uploadedPrintifyId: null,  // reusable image ID from Printify upload
  editorFilter: "jpg",       // "jpg" | "raw" | "rhef" — preview only; HQ is separate button
  jpgImage: null,            // JPG = Helioviewer-derived from backend; distinct from raw and RHEF
  rhefImage: null,            // RHE-processed preview image
  rawBackendImage: null,     // backend raw preview (no RHEF) for toggling with rhefImage
  rhefFetching: false,       // true while background RHEF fetch is in-flight
  rhefFetchPromise: null,    // Promise for in-flight RHEF fetch (deduplication)
  hqFilterImage: null,       // loaded HQ full-res Image object
  hqFormat: null,            // "jpg" | "raw" | "rhef" — which format the current hqFilterImage is
  hqFetching: false,         // true while HQ generation is in progress
  mockupsRaw: {},            // cached mockups for raw version
  mockupsFiltered: {},       // cached mockups for filtered (RHEF/HQ) version
  uploadedPrintifyIdRaw: null,      // Printify upload ID for raw canvas
  uploadedPrintifyIdFiltered: null, // Printify upload ID for filtered canvas
  transitionInProgress: false,      // prevents toggle spam during wipe animation
  selectedVariantByProduct: {},    // productId -> variantId (user-confirmed)
  pendingVariantByProduct: {},     // productId -> variantId (first click, not yet confirmed)
  variantAspectRatioByProduct: {}, // productId -> { w, h } parsed from selected variant
  aspectFlippedByProduct: {},      // productId -> bool: user manually swapped w↔h
  // Layout mode for dual-panel products (throw_pillow, journal_hardcover).
  // "match" → editor canvas = single face, uploaded PNG is two copies
  //           concatenated horizontally (front = back).
  // "span"  → editor canvas = full panel aspect (front + back as one
  //           continuous design; sun-center can land on the seam).
  // Missing entry defaults to "match" so first-time users get the
  // safer "same on both sides" behaviour.
  dualPanelModeByProduct: {},      // productId -> "match" | "span"
  mockupSlideIndex: {},            // productId -> current slide index in mockup slideshow
  showOverlay: true,               // draw orange frame border on canvas
  showGuides: false                // draw centre-line / spine guide lines on canvas
};

// Pre-rendered REAL Printify mockups for the default landing image
// (Phase B). Manifest fetched once on init: { product_id: { url, ... } }.
// When state.isDefaultActive is true AND a manifest entry exists for a
// product, renderProducts uses the cached <img> instead of the JS canvas
// mockup approximation — landing tiles show photorealistic actual
// products. Invalidated to false the moment the user picks their own
// date or wavelength.
export let defaultMockupManifest = null;
export function setDefaultMockupManifest(manifest) {
  defaultMockupManifest = manifest;
}
