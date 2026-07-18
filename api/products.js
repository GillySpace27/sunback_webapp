/* ===============================================================
   Solar Archive — product catalog

   Step 3a/N of the IIFE → ES-modules refactor. Pure static data:
   the Printify blueprint/provider/variant lookup table that every
   product-aware module reads. Lives in its own module because:

   1. It's the largest single block of literal data in the app
      (~100 lines), and pulling it out makes the rest of
      solar-archive.js dramatically easier to navigate.
   2. The next slice (mockups.js) consumes PRODUCTS heavily —
      drawProductMockup branches keyed off product.id, look-ups
      via PRODUCTS.find — so it needs to import from somewhere
      shared.

   IDs are pre-resolved from the live Printify catalog.
   blueprintId = product type, printProviderId = fulfiller,
   variantId = default size/color (customer picks final variant
   on Shopify).

   Aspect ratios are taken from each blueprint's actual print-panel
   dimensions (queried from the Printify catalog), not arbitrary
   declared aspects. parseVariantAspectRatio overrides per-variant
   when a variant title encodes WxH (e.g. canvas 12"×16"); the
   product default below is the panel aspect for the variantId
   shown here, so canvas + upload + Printify panel all agree even
   before variants finish loading.
   =============================================================== */

export const PRODUCTS = [
  // ── Wall Art & Home Decor ──
  { id: "canvas_stretched",     name: "Stretched Canvas",    desc: "Gallery-wrapped canvas, 1.25\" bars",       icon: "fa-palette",      price: "From $29.99", checkoutPrice: 2999, blueprintId: 555,  printProviderId: 69,  variantId: 70880, position: "front", aspectRatio: { w: 2400, h: 3000 } },
  { id: "metal_sign",           name: "Metal Art Sign",      desc: "Vibrant aluminum print, ready to hang",     icon: "fa-shield-alt",   price: "From $24.99", checkoutPrice: 2499, blueprintId: 1206, printProviderId: 228, variantId: 91993, position: "front", aspectRatio: { w: 2250, h: 1650 } },
  { id: "acrylic_print",        name: "Acrylic Wall Art",    desc: "High-gloss acrylic panel with standoffs",   icon: "fa-gem",          price: "From $34.99", checkoutPrice: 3499, blueprintId: 1098, printProviderId: 228, variantId: 82057, position: "front", aspectRatio: { w: 2250, h: 1650 } },
  { id: "poster_matte",         name: "Matte Poster",        desc: "Museum-quality matte paper, multiple sizes", icon: "fa-image",       price: "From $9.99",  checkoutPrice: 999,  blueprintId: 282,  printProviderId: 99,  variantId: 43135, position: "front", aspectRatio: { w: 11, h: 14 } },
  { id: "framed_poster",        name: "Framed Poster",       desc: "Ready-to-hang framed museum print",         icon: "fa-square",       price: "From $51.99", checkoutPrice: 5199, blueprintId: 492,  printProviderId: 36,  variantId: 65400, position: "front", aspectRatio: { w: 11, h: 14 } },
  { id: "wall_clock",           name: "Wall Clock",          desc: "Round acrylic clock — the Sun tells time",  icon: "fa-clock",        price: "From $48.99", checkoutPrice: 4899, blueprintId: 277,  printProviderId: 1,   variantId: 43008, position: "front", aspectRatio: { w: 1, h: 1 },
    // Two color axes: base (auto-detected via variantColorOption,
    // shown in the primary swatch row) + hands (declared here as an
    // extra axis). The modal renders one swatch row per axis and
    // composes the selection so 3 bases × 2 hands = 6 variants
    // become two compact selectors instead of a 6-tile list.
    colorAxes: [ { key: "hands", label: "Hand color", keyPattern: "^hands?$" } ] },
  { id: "tapestry",             name: "Wall Tapestry",       desc: "Large-format indoor wall hanging",          icon: "fa-scroll",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 241,  printProviderId: 10,  variantId: 41686, position: "front", aspectRatio: { w: 4350, h: 5850 } },
  // ── Drinkware ──
  // NOTE: Printify splits mug color across separate blueprints rather than
  // exposing color as a variant. White lives at BP 425; black lives at BP 1152.
  // Both are listed so the gallery carries both options.
  { id: "mug_15oz",             name: "Ceramic Mug — 15oz", desc: "Large ceramic mug, full-wrap print — white or black", icon: "fa-mug-hot", price: "From $14.99", checkoutPrice: 1499, blueprintId: 425,  printProviderId: 1,   variantId: 62014, position: "front", aspectRatio: { w: 2790, h: 1219 },
    // Merged mug: this visible card is the White mug; Black is a hidden
    // sibling (different Printify blueprint + print geometry) reached via
    // the color chooser. Selecting a colour commits the real child
    // product, so the editor/checkout run unchanged. Stats for both
    // colours canonicalize onto this id (see _canonicalStatId).
    colorOptions: [
      { label: "White", productId: "mug_15oz",       hex: "#f2f2f2" },
      { label: "Black", productId: "mug_15oz_black", hex: "#1c1c1c" }
    ] },
  { id: "mug_15oz_black",       name: "Ceramic Mug — 15oz (Black)", desc: "Large black ceramic mug, full-wrap print", icon: "fa-mug-hot", price: "From $14.99", checkoutPrice: 1499, blueprintId: 1152, printProviderId: 28,  variantId: 88132, position: "front", aspectRatio: { w: 2448, h: 1266 }, _hiddenFromGrid: true },
  // Tumbler print panel is 2795×2100 (~4:3 landscape), not the rolled-out
  // 2:1 we used to advertise. The mug-15oz-white panel is closer to 2:1
  // (genuine full-wrap) but the tumbler's panel reflects a single-side
  // print area shaped like the cup face.
  { id: "tumbler_20oz",         name: "Tumbler — 20oz",      desc: "Insulated stainless steel with lid",        icon: "fa-glass-whiskey", price: "From $40.99", checkoutPrice: 4099, blueprintId: 353,  printProviderId: 1,   variantId: 44519, position: "front", aspectRatio: { w: 2795, h: 2100 } },
  // ── Apparel ──
  // T-shirt/hoodie/crewneck DTG print area is 3319×3761 (slightly
  // taller than wide). All three share the same panel because
  // they use provider 29 (Monster Digital) with a single DTG
  // press; only the garment template differs.
  { id: "tshirt_unisex",        name: "Unisex T-Shirt",      desc: "Bella+Canvas 3001 jersey tee, DTG print",   icon: "fa-tshirt",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 12,   printProviderId: 29,  variantId: 18052, position: "front", aspectRatio: { w: 3319, h: 3761 },
    variantFilter: { sizes: ["XS","S","M","L","XL","2XL","3XL"], colors: ["Black","White","Navy","Forest Green","Dark Heather","Athletic Heather","True Royal","Maroon","Red","Military Green"] } },
  { id: "hoodie_pullover",      name: "Pullover Hoodie",     desc: "Unisex heavy blend hooded sweatshirt",      icon: "fa-mitten",       price: "From $39.99", checkoutPrice: 3999, blueprintId: 77,   printProviderId: 29,  variantId: 32878, position: "front", aspectRatio: { w: 3319, h: 3761 },
    variantFilter: { sizes: ["S","M","L","XL","2XL","3XL"], colors: ["Black","White","Navy","Dark Heather","Sport Grey","Maroon","Forest Green","Military Green"] } },
  { id: "crewneck_sweatshirt",  name: "Crewneck Sweatshirt", desc: "Unisex heavy blend crewneck",               icon: "fa-vest",         price: "From $34.99", checkoutPrice: 3499, blueprintId: 49,   printProviderId: 29,  variantId: 25377, position: "front", aspectRatio: { w: 3319, h: 3761 },
    variantFilter: { sizes: ["S","M","L","XL","2XL","3XL"], colors: ["Black","White","Navy","Dark Heather","Sport Grey","Maroon","Forest Green"] } },
  // Crew socks blueprint requires four 1358×3839 leg-panel placeholders
  // (front_left_leg, front_right_leg, back_left_leg, back_right_leg).
  // The editor canvas mirrors the panel aspect — the same image is
  // sent to all four panels, so the design has to look right within
  // the tall narrow rectangle. initialCropZoom of 136 zooms in to the
  // largest sock-aspect rectangle that fits inside the solar disk
  // (formula in selectProductCard): the full disk doesn't fit in a
  // 1:2.83 panel, but a slice through it does, and looks like an
  // intentional close-up rather than letterboxed white space.
  { id: "crew_socks",           name: "Crew Socks",          desc: "All-over sublimation print socks",          icon: "fa-socks",        price: "From $14.99", checkoutPrice: 1499, blueprintId: 365,  printProviderId: 14,  variantId: 44904, position: "front", aspectRatio: { w: 1358, h: 3839 }, initialCropZoom: 136,
    variantFilter: { sizes: ["S","M","L","XS","XL","2XL"] } },
  // ── Tech & Desk ──
  // Blueprint 269 / provider 1 (SPOKE) covers iPhone 11–17 and Samsung Galaxy S21–S25.
  { id: "phone_case",           name: "Phone Case",          desc: "Tough snap case — iPhone & Samsung",        icon: "fa-mobile-alt",   price: "From $19.99", checkoutPrice: 1999, blueprintId: 269,  printProviderId: 1,   variantId: 62582, position: "front", aspectRatio: { w: 1290, h: 2160 } },
  // Pixel Phone Case — blueprint 421, provider 23 (WOYC). This blueprint's
  // catalog is shared across iPhone/Samsung/Pixel; variantFilter narrows the
  // 128 raw variants down to the 16 Pixel ones (Pixel 6/6 Pro/7/8/8 Pro/9/9 Pro/
  // 9 Pro XL × Glossy/Matte) so it doesn't duplicate the phone_case product
  // above. Verified live 2026-07-18 against the WOYC catalog — no "8a" model
  // exists there (an earlier note assumed one). Default variant is Pixel 9 /
  // Glossy; aspectRatio is that variant's real print-area placeholder (1329×2126).
  { id: "phone_case_pixel",     name: "Phone Case (Pixel)",  desc: "Tough snap case — Google Pixel",            icon: "fa-mobile-alt",   price: "From $24.99", checkoutPrice: 2499, blueprintId: 421,  printProviderId: 23,  variantId: 116386, position: "front", aspectRatio: { w: 1329, h: 2126 },
    variantFilter: { sizes: ["Google Pixel 6 Pro","Google Pixel 6","Google Pixel 7","Google Pixel 8 Pro","Google Pixel 8","Google Pixel 9 Pro XL","Google Pixel 9 Pro","Google Pixel 9"] } },
  { id: "laptop_sleeve",        name: "Laptop Sleeve",       desc: "Padded neoprene sleeve, snug fit",          icon: "fa-laptop",       price: "From $24.99", checkoutPrice: 2499, blueprintId: 429,  printProviderId: 1,   variantId: 62037, position: "front", aspectRatio: { w: 4, h: 3 } },
  // Mouse pad's physical print area is a circle, not a square. Same treatment
  // as wall_clock — round frame border in the editor, circular clip on the
  // canvas, and a circular preview in the mockup pane.
  { id: "mouse_pad",            name: "Mouse Pad",           desc: "Non-slip rubber base, smooth fabric top",   icon: "fa-mouse",        price: "From $20.99", checkoutPrice: 2099, blueprintId: 582,  printProviderId: 99,  variantId: 71665, position: "front", aspectRatio: { w: 1, h: 1 }, printShape: "circle" },
  { id: "desk_mat",             name: "Desk Mat",            desc: "Large-format mat for your workspace",       icon: "fa-desktop",      price: "From $24.99", checkoutPrice: 2499, blueprintId: 488,  printProviderId: 1,   variantId: 65240, position: "front", aspectRatio: { w: 5610, h: 3839 }, forceOrientation: "landscape" },
  // ── Home & Living ──
  // throw_pillow + journal_hardcover are "dual-panel" products: the
  // Printify print area is a two-face wraparound (front + back on
  // the pillow; back-cover + spine + front-cover on the journal),
  // but the user designs against one face. The editor canvas uses
  // aspectRatio (the single-face shape). At upload, layoutMode
  // controls how the canvas maps onto the panel:
  //   • "match"  → render canvas, duplicate horizontally, upload
  //                a panelAspectRatio PNG — same design on both
  //                sides (default; safest for a glance-test)
  //   • "span"   → editor canvas becomes the full panel aspect so
  //                the design can intentionally bridge front+back
  //                (sun-center on the spine, etc.)
  // dualPanelToggle UI sits in the preview pane.
  { id: "throw_pillow",         name: "Throw Pillow",        desc: "Spun polyester square pillow with insert",  icon: "fa-couch",        price: "From $22.99", checkoutPrice: 2299, blueprintId: 220,  printProviderId: 10,  variantId: 41521, position: "front", aspectRatio: { w: 1, h: 1 }, dualPanel: true, panelAspectRatio: { w: 4650, h: 2325 } },
  { id: "sherpa_blanket",       name: "Sherpa Blanket",      desc: "Ultra-soft fleece with sherpa backing",     icon: "fa-cloud",        price: "From $44.99", checkoutPrice: 4499, blueprintId: 238,  printProviderId: 99,  variantId: 41656, position: "front", aspectRatio: { w: 7875, h: 9375 } },
  { id: "shower_curtain",       name: "Shower Curtain",      desc: "Polyester shower curtain, vibrant print",   icon: "fa-shower",       price: "From $66.99", checkoutPrice: 6699, blueprintId: 235,  printProviderId: 10,  variantId: 41653, position: "front", aspectRatio: { w: 7104, h: 7392 } },
  { id: "puzzle_1000",          name: "Jigsaw Puzzle",       desc: "252-piece puzzle in a tin box",             icon: "fa-puzzle-piece",  price: "From $24.99", checkoutPrice: 2499, blueprintId: 532,  printProviderId: 59,  variantId: 68984, position: "front", aspectRatio: { w: 4200, h: 3300 } },
  { id: "coaster_set",          name: "Coaster Set",         desc: "4-pack corkwood coasters, glossy top",      icon: "fa-circle",       price: "From $23.99", checkoutPrice: 2399, blueprintId: 510,  printProviderId: 48,  variantId: 72872, position: "front", aspectRatio: { w: 1, h: 1 } },
  // ── Accessories & Stationery ──
  { id: "sticker_kiss",         name: "Kiss-Cut Stickers",   desc: "Die-cut vinyl stickers, multiple sizes",    icon: "fa-sticky-note",  price: "From $2.99",  checkoutPrice: 299,  blueprintId: 400,  printProviderId: 99,  variantId: 45748, position: "front", aspectRatio: { w: 1, h: 1 },
    sizePricing: { 45748: "$2.99", 45750: "$3.99", 45752: "$4.99", 45754: "$7.99" } },
  // Hardcover journal panel is 4065×2850 — back cover + spine +
  // front cover laid flat. Editor canvas uses the single front-cover
  // aspect 2032×2850 (panel halved); dualPanel concatenation paints
  // the same design on both faces at upload. Spine is treated as
  // part of one face for simplicity (a slim slice of the design
  // shows on the spine).
  { id: "journal_hardcover",    name: "Hardcover Journal",   desc: "Matte hardcover, ruled pages",              icon: "fa-book",         price: "From $17.99", checkoutPrice: 1799, blueprintId: 485,  printProviderId: 28,  variantId: 65223, position: "front", aspectRatio: { w: 2032, h: 2850 }, dualPanel: true, panelAspectRatio: { w: 4065, h: 2850 } },
  // Backpack disabled — it's an all-over print with seven separate
  // placeholders (front, back, left/right side, top-to-front, top-to-
  // back, front pocket, pocket flap). Each panel needs its own design
  // crop, so one editor canvas can't represent the product faithfully.
  // Re-enable once we have a panel-picker UI to drive multi-placeholder
  // products.
  // { id: "backpack",             name: "Backpack",            desc: "All-over print, padded straps",             icon: "fa-bag-shopping", price: "From $44.99", checkoutPrice: 4499, blueprintId: 347,  printProviderId: 14,  variantId: 44419, position: "front", aspectRatio: null }
];
