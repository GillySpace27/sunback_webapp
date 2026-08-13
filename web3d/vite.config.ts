import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ponytail: default config + one manualChunks split so the heavy 3D stack
// lazy-loads separately from the shell. Add more splits only if a bundle warns.
// Proxy /api to the original origin in dev so the Helioviewer texture loads
// same-origin (no CORS taint on the WebGL texture). Override with VITE_DEV_API.
const DEV_API = process.env.VITE_DEV_API || "https://myheliograph.com";

// Served same-origin under /experience/ by the Cloudflare Worker
// (public/experience/); the store is the site root. Dev stays at root.
// Override with VITE_BASE if the deploy path changes.
export default defineConfig(({ command }) => ({
  base: command === "build" ? process.env.VITE_BASE || "/experience/" : "/",
  plugins: [react()],
  server: {
    proxy: {
      // spoof an allow-listed Origin/Referer so the origin-enforced thumb
      // endpoint serves us in dev (prod is same-origin, so this is dev-only)
      "/api": {
        target: DEV_API,
        changeOrigin: true,
        secure: true,
        headers: { origin: DEV_API, referer: DEV_API + "/" },
      },
    },
  },
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          r3f: ["@react-three/fiber", "@react-three/drei", "@react-three/postprocessing"],
        },
      },
    },
  },
}));
