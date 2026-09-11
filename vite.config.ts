import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Used by the shadcn CLI for framework detection and aliases.
// The Electron app builds through electron.vite.config.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
});
