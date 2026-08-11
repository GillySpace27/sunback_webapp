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
  editorFilter: "raw",       // "raw" | "rhef" — HQ is separate; "jpg" is raw's fast first-paint, not a tier
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

// Pre-rendered REAL Printify mockups (Phase B). Manifest fetched once on
// init: { product_id: { url, thumb_url, ... } }. Whenever an entry exists,
// renderProducts uses the cached <img> instead of the JS canvas
// approximation, so the grid is photorealistic product photography. Each
// product is warmed from a different archive moment (the `vibe` keys in
// main.py's _DEFAULT_MOCKUP_PRODUCTS), which is what makes the grid read as
// a varied gallery rather than one Sun repeated.
//
// NOT gated on state.isDefaultActive. It used to be, which broke when the
// funnel went image-first: the user always picks a Sun before reaching the
// grid, and that clears the latch, so every card fell to the canvas path.
// isDefaultActive now means only "the Sun on screen is still the untouched
// landing default" and survives as an honesty gate — see _hasRealMockup()
// and bundler.js, which must not claim a sample-Sun product photo depicts
// the user's own design.
export let defaultMockupManifest = null;
export function setDefaultMockupManifest(manifest) {
  defaultMockupManifest = manifest;
}
