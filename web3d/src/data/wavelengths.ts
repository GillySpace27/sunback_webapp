// The 10 SDO channels from the "sun-pizza" fan, in the order they radiate.
// tint  = glass/UI color (approx AIA standard colormap hue)
// hot   = the plasma core color at peak intensity for that channel
// label = human-facing wavelength
export type Channel = {
  angstrom: number;
  nm: number;
  instrument: "AIA" | "HMI";
  label: string;
  tint: string; // hex
  hot: string; // hex, bright core
  sees: string; // 3-4 words: what this channel reveals
  // How much genuine off-limb corona this channel actually carries, 0..1.
  //
  // RHEF equalises whatever is in each radial bin. Where a channel has real
  // off-limb structure it reveals plumes and streamer fans; where it has none,
  // the bin holds noise and RHEF faithfully equalises THAT — producing a smooth
  // uniform halo, which is exactly what reads as a non-diegetic "glow effect".
  // So the corona is weighted by what the channel can physically show:
  // coronal iron lines see the corona, chromospheric and flare channels do not.
  corona: number;
};

// `sees` blurbs kept physically honest (dominant ion / temperature regime per
// the SDO/AIA channel documentation), trimmed to a few words for a tooltip.
export const CHANNELS: Channel[] = [
  { angstrom: 94, nm: 9.4, instrument: "AIA", label: "94 Å", tint: "#17a67b", hot: "#b8ffe4", sees: "Flaring, ultra-hot corona" , corona: 0.15 },
  { angstrom: 131, nm: 13.1, instrument: "AIA", label: "131 Å", tint: "#2bd6d6", hot: "#d6ffff", sees: "Flares, hottest plasma" , corona: 0.15 },
  { angstrom: 171, nm: 17.1, instrument: "AIA", label: "171 Å", tint: "#d4a017", hot: "#fff2c2", sees: "Coronal loops, quiet Sun" , corona: 1.0 },
  { angstrom: 193, nm: 19.3, instrument: "AIA", label: "193 Å", tint: "#b5651d", hot: "#ffddad", sees: "Corona and coronal holes" , corona: 0.85 },
  { angstrom: 211, nm: 21.1, instrument: "AIA", label: "211 Å", tint: "#8a5cc4", hot: "#e9d8ff", sees: "Active-region corona" , corona: 0.75 },
  { angstrom: 304, nm: 30.4, instrument: "AIA", label: "304 Å", tint: "#e8481c", hot: "#ffd0b0", sees: "Chromosphere and prominences" , corona: 0.3 },
  { angstrom: 335, nm: 33.5, instrument: "AIA", label: "335 Å", tint: "#2f6fd6", hot: "#cfe0ff", sees: "Hot active regions" , corona: 0.5 },
  { angstrom: 1600, nm: 160.0, instrument: "AIA", label: "1600 Å", tint: "#b6c14a", hot: "#f4ffd0", sees: "Transition region, photosphere" , corona: 0.05 },
];
// 1700 Å removed 2026-08-18 (Gilly): the only channel without JSOC's fast
// synoptic-archive bypass on the store side, so it fell into NASA's VSO/DRMS
// export queue on every arbitrary-date pick and could hang for minutes — see
// api/main.py's SYNOPTIC_MISSING_WAVELENGTHS. Dropped from both wheels
// rather than left reachable here with a broken landing on the store side.
// The 8 SDO/AIA channels the product pipeline supports (see PRODUCT_CREATION_
// CONTRACT.md). Each angstrom value is a valid `wl` deep-link + thumb param.

// 2 = 171 A, not 5 = 304 A. 304 is chromosphere: it has essentially no
// off-limb corona, so opening on it meant the film's first frame was the one
// wavelength where the enhancement this whole product sells has nothing to
// reveal. 171 (Fe IX) carries the real off-limb plumes and streamer fans, so
// the opening frame now shows what is actually being sold.
export const DEFAULT_CHANNEL = 2;
