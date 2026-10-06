import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The file / folder icons the fixture's tree and chips draw (see `mock/preview.ts`). */
const ICONS = [
  "file", "folder", "folder-open", "folder-src", "folder-src-open", "folder-components", "folder-components-open",
  "folder-public", "folder-public-open", "typescript", "react_ts", "test-ts", "nodejs", "readme", "vite", "json",
];

function copyIcons(): Plugin {
  return {
    name: "website-preview-icons",
    closeBundle() {
      const from = resolve(__dirname, "node_modules/material-icon-theme/icons");
      const to = resolve(__dirname, "apps/website/public/app-preview/icons");
      mkdirSync(to, { recursive: true });
      for (const name of ICONS) if (existsSync(`${from}/${name}.svg`)) copyFileSync(`${from}/${name}.svg`, `${to}/${name}.svg`);
    },
  };
}

/**
 * Pre-compiles the renderer's fixture page (`mock.html`) for the marketing site, which
 * embeds it in an iframe so the hero shows the real client UI instead of a drawing of it.
 * Run `pnpm --filter @fastvibe/website preview:build`; the output is committed under
 * `apps/website/public/app-preview/`, like the screenshots.
 */
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "/app-preview/",
  plugins: [react(), tailwindcss(), copyIcons()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer/src"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
  build: {
    outDir: resolve(__dirname, "apps/website/public/app-preview"),
    emptyOutDir: true,
    minify: "esbuild",
    rollupOptions: { input: { mock: resolve(__dirname, "src/renderer/mock.html") } },
  },
});
