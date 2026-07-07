import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import manifest from "./manifest.config.ts";

// Vite + CRXJS build for the MV3 extension (docs/planning/chrome-extension/04 §1).
// CRXJS reads the typed manifest, bundles the SW + content script + HTML surfaces, and emits dist/.
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      // Keep the injected content bundle small; the heavy UI lives on extension pages.
      output: { chunkFileNames: "assets/[name]-[hash].js" },
    },
  },
  server: { port: 5180, strictPort: true },
});
