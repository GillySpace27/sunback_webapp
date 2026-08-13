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
};

// `sees` blurbs kept physically honest (dominant ion / temperature regime per
// the SDO/AIA channel documentation), trimmed to a few words for a tooltip.
export const CHANNELS: Channel[] = [
  { angstrom: 94, nm: 9.4, instrument: "AIA", label: "9.4 nm", tint: "#17a67b", hot: "#b8ffe4", sees: "Flaring, ultra-hot corona" },
  { angstrom: 131, nm: 13.1, instrument: "AIA", label: "13.1 nm", tint: "#2bd6d6", hot: "#d6ffff", sees: "Flares, hottest plasma" },
  { angstrom: 171, nm: 17.1, instrument: "AIA", label: "17.1 nm", tint: "#d4a017", hot: "#fff2c2", sees: "Coronal loops, quiet Sun" },
  { angstrom: 193, nm: 19.3, instrument: "AIA", label: "19.3 nm", tint: "#b5651d", hot: "#ffddad", sees: "Corona and coronal holes" },
  { angstrom: 211, nm: 21.1, instrument: "AIA", label: "21.1 nm", tint: "#8a5cc4", hot: "#e9d8ff", sees: "Active-region corona" },
  { angstrom: 304, nm: 30.4, instrument: "AIA", label: "30.4 nm", tint: "#e8481c", hot: "#ffd0b0", sees: "Chromosphere and prominences" },
  { angstrom: 335, nm: 33.5, instrument: "AIA", label: "33.5 nm", tint: "#2f6fd6", hot: "#cfe0ff", sees: "Hot active regions" },
  { angstrom: 1600, nm: 160.0, instrument: "AIA", label: "160.0 nm", tint: "#b6c14a", hot: "#f4ffd0", sees: "Transition region, photosphere" },
  { angstrom: 1700, nm: 170.0, instrument: "AIA", label: "170.0 nm", tint: "#d98a8a", hot: "#ffe1e1", sees: "Photosphere, the surface" },
];
// The 9 SDO/AIA channels the product pipeline supports (see PRODUCT_CREATION_
// CONTRACT.md). Each angstrom value is a valid `wl` deep-link + thumb param.

export const DEFAULT_CHANNEL = 5; // 30.4 nm — the warm, recognizable Sun
