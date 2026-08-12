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
};

export const CHANNELS: Channel[] = [
  { angstrom: 94, nm: 9.4, instrument: "AIA", label: "9.4 nm", tint: "#17a67b", hot: "#b8ffe4" },
  { angstrom: 131, nm: 13.1, instrument: "AIA", label: "13.1 nm", tint: "#2bd6d6", hot: "#d6ffff" },
  { angstrom: 171, nm: 17.1, instrument: "AIA", label: "17.1 nm", tint: "#d4a017", hot: "#fff2c2" },
  { angstrom: 193, nm: 19.3, instrument: "AIA", label: "19.3 nm", tint: "#b5651d", hot: "#ffddad" },
  { angstrom: 211, nm: 21.1, instrument: "AIA", label: "21.1 nm", tint: "#8a5cc4", hot: "#e9d8ff" },
  { angstrom: 304, nm: 30.4, instrument: "AIA", label: "30.4 nm", tint: "#e8481c", hot: "#ffd0b0" },
  { angstrom: 335, nm: 33.5, instrument: "AIA", label: "33.5 nm", tint: "#2f6fd6", hot: "#cfe0ff" },
  { angstrom: 1600, nm: 160.0, instrument: "AIA", label: "160.0 nm", tint: "#b6c14a", hot: "#f4ffd0" },
  { angstrom: 1700, nm: 170.0, instrument: "AIA", label: "170.0 nm", tint: "#d98a8a", hot: "#ffe1e1" },
];
// The 9 SDO/AIA channels the product pipeline supports (see PRODUCT_CREATION_
// CONTRACT.md). Each angstrom value is a valid `wl` deep-link + thumb param.

export const DEFAULT_CHANNEL = 5; // 30.4 nm — the warm, recognizable Sun
