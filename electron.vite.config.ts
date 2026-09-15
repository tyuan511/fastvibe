import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const shared = resolve("src/shared");

export default defineConfig({
  main: {
    // Only production dependencies are externalized. Renderer packages live in
    // devDependencies so Vite bundles them and electron-builder does not pack
    // the 100 MB+ icon/UI trees into the asar.
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": shared,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": shared,
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
        "@shared": shared,
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
