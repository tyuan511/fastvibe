import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repo = "/Users/yuantang/code/fastvibe";

// Serves the renderer's static pages (mock.html) without Electron or the engine.
export default defineConfig({
  root: resolve(repo, "src/renderer"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(repo, "src/renderer/src"),
      "@shared": resolve(repo, "src/shared"),
    },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
