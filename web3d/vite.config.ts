import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ponytail: default config + one manualChunks split so the heavy 3D stack
// lazy-loads separately from the shell. Add more splits only if a bundle warns.
export default defineConfig({
  plugins: [react()],
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
});
