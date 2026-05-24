/* ===============================================================
   Solar Archive — variant-colour palette + name→hex resolution

   Step 3b/N of the IIFE → ES-modules refactor. Pure helpers, no
   state or DOM. Printify's catalog API names variant colours but
   doesn't expose hex values — every product/provider names
   "navy blue" slightly differently. This is a curated palette
   covering Printify's most common apparel + accessory tokens,
   normalised to lowercase, plus two resolvers that downstream
   modules use:

   • drawProductMockup's apparel/accessory branches paint the
     mock-mockup silhouette in the variant's actual colour
     instead of a generic grey.
   • The variant-picker swatch row shows one clickable square
     per distinct colour so users can browse by colour before
     drilling into sizes.

   Public names dropped the leading-underscore convention from
   the IIFE era — the module boundary handles privacy, and
   imported names that aren't underscore-prefixed read better
   at the call sites.
   =============================================================== */

export const PRINTIFY_COLOR_HEX = {
  "white": "#ffffff", "natural": "#f4ecd8", "ash": "#cdd0d4", "cream": "#efe5cb",
  "light blue": "#a6c5e0", "carolina blue": "#7ba4d9", "sky blue": "#7fbcd9",
  "blue": "#3b6cb8", "royal": "#1c3aa3", "royal blue": "#1c3aa3", "navy": "#1a2240",
  "midnight navy": "#0f1a3c",
  "aqua": "#5fcfd6", "teal": "#1f8a8a", "turquoise": "#3bb7b7",
  "purple": "#5b3a9e", "violet": "#6a3aa8", "lavender": "#c4a6d6", "lilac": "#c8a8db",
  "red": "#c2202c", "true red": "#c2202c", "cardinal red": "#a8202b", "cherry": "#a8232f",
  "maroon": "#601822", "burgundy": "#5a1f29",
  "pink": "#f4a3c5", "soft pink": "#f7c4d2", "heather pink": "#dca0b1", "berry": "#a83a73",
  "orange": "#e25b27", "burnt orange": "#b85128", "rust": "#a3401f", "peach": "#f7c3a1",
  "yellow": "#f3c100", "gold": "#cd9c2b", "old gold": "#a8842c", "daisy": "#fadc6e",
  "mustard": "#c69a16",
  "green": "#2f7d3a", "kelly": "#2f7d3a", "irish green": "#1f7a37", "mint": "#a8d8b2",
  "forest green": "#1f4a2a", "forest": "#1f4a2a", "olive": "#5b5a30",
  "military green": "#4a4f2c", "army": "#4a4f2c", "sage": "#8fa68a",
  "heather grey": "#9aa1a8", "heather gray": "#9aa1a8", "athletic heather": "#b9bdc1",
  "dark heather": "#4a4d51", "sport grey": "#9aa1a8", "sport gray": "#9aa1a8",
  "heavy metal": "#6a6e72",
  "grey": "#7e8489", "gray": "#7e8489", "charcoal": "#3f4347", "graphite heather": "#525558",
  "graphite": "#36393d",
  "black": "#1a1a1a", "deep black": "#0d0d0d", "vintage black": "#2a2a2a", "jet black": "#0a0a0a",
  "silver": "#c8c8c8",
  "brown": "#5a3a23", "chocolate": "#3a2618", "tan": "#b09373", "camel": "#a98763",
  "khaki": "#a8956b", "sand": "#d4c39b",
  // Wall-clock base material. Printify names it "Wooden" / "Wooden Base"
  // on the wall-clock blueprint; the substring scan in hexForColorName
  // catches both because "wood" is a key here. Warm oak tone to read
  // clearly next to the Black + White base swatches.
  "wood": "#a07a4f", "wooden": "#a07a4f", "wooden base": "#a07a4f",
  "oak": "#a07a4f", "walnut": "#6b4a2b", "maple": "#c89a64"
};

export function hexForColorName(name) {
  if (!name) return null;
  var s = String(name).toLowerCase().trim();
  if (PRINTIFY_COLOR_HEX[s]) return PRINTIFY_COLOR_HEX[s];
  // Strip common provider-specific prefixes ("Solid Red" → "red",
  // "Heavy Metal" already in palette, etc.) so we resolve the long
  // tail of provider-coined names.
  var stripped = s.replace(/^(solid|vintage|deep|light|dark|true|cardinal|sport|athletic|graphite|heavy)\s+/, "");
  if (PRINTIFY_COLOR_HEX[stripped]) return PRINTIFY_COLOR_HEX[stripped];
  var stripped2 = s.replace(/^heather\s+/, "");
  if (PRINTIFY_COLOR_HEX[stripped2]) return PRINTIFY_COLOR_HEX[stripped2];
  // Last-ditch substring scan ("solid midnight navy" → "navy").
  for (var k in PRINTIFY_COLOR_HEX) {
    if (s.indexOf(k) !== -1) return PRINTIFY_COLOR_HEX[k];
  }
  return null;
}

// Returns { name, hex } for a variant's colour option, or null if
// the variant carries no colour or the colour can't be resolved.
// Walks every option key because some products use "Color" rather
// than "color", and a few use "Frame" or other domain-specific labels.
export function variantColorOption(v) {
  if (!v || !v.options) return null;
  var keys = Object.keys(v.options);
  // Prefer keys that LOOK like color labels first; otherwise scan all.
  var preferred = keys.filter(function(k) { return /col?or|colour/i.test(k); });
  var ordered = preferred.concat(keys.filter(function(k) { return preferred.indexOf(k) === -1; }));
  for (var i = 0; i < ordered.length; i++) {
    var v2 = v.options[ordered[i]];
    var hex = hexForColorName(v2);
    if (hex) return { name: v2, hex: hex };
  }
  return null;
}
