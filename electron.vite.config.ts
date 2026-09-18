import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { Plugin } from "vite";

const shared = resolve("src/shared");

/**
 * Keep only the woff2 cut of KaTeX's fonts.
 *
 * `katex.min.css` names three formats per face — woff2, woff and ttf — so a browser
 * from 2015 has something to fall back to. The renderer is Chromium, which has
 * supported woff2 since long before any Electron this app can run on, so the other
 * two are never fetched; they were still emitted as assets and packed into the asar,
 * about 800 KB of files nothing can request. Rewriting the `src` before Vite
 * resolves the urls means they are never emitted in the first place.
 */
function katexWoff2Only(): Plugin {
  return {
    name: "fastvibe:katex-woff2-only",
    enforce: "pre",
    transform(code: string, id: string) {
      // Matched on content, not on the id: the stylesheet reaches the renderer's CSS
      // pipeline through an `@import` in `index.css`, so by the time a transform sees
      // the font faces they are part of that file rather than katex's own.
      if (!id.includes(".css") || !code.includes("KaTeX_")) return null;
      // The rule reaches here expanded and re-quoted by the CSS pipeline, so the
      // separator, the quoting and the whitespace are all optional in the pattern.
      const stripped = code.replace(
        /,\s*url\(\s*["']?[^)]*\.(?:woff|ttf)["']?\s*\)\s*format\(\s*["'](?:woff|truetype)["']\s*\)/g,
        "",
      );
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}

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
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          agent: resolve("src/agent/main.ts"),
        },
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
    plugins: [react(), tailwindcss(), katexWoff2Only()],
    optimizeDeps: {
      /**
       * Dev-only, and only about the dep pre-bundle.
       *
       * Vite scans from `index.html` to decide what to pre-bundle. A module reached
       * exclusively through `import()` is not on that path, so its own dependencies
       * are discovered late — the first time the feature is opened — and the
       * optimizer re-bundles, answering the in-flight request with a 504. Vite
       * recovers with a full reload, but the app's error boundary catches the
       * rejected `lazy()` first and shows its crash screen instead.
       *
       * Naming the lazy entry points here puts them in the initial scan. Any module
       * that becomes the target of a new `lazy(() => import(...))` belongs in this
       * list too.
       */
      entries: [
        "index.html",
        "remote.html",
        "src/components/settings/settings-dialog.tsx",
        "src/components/layout/side-pane-terminal.tsx",
      ],
    },
    build: {
      /**
       * electron-vite does not minify the renderer by default. The output was
       * shipping as ~33k lines of unminified source — every byte of which Chromium
       * parses and compiles before the window can paint, and the grammar chunks pay
       * it again on first use. Worth noting for anyone reading a stack trace from
       * `logs/renderer.log`: main and preload are deliberately left unminified, so
       * the traces that actually get exported stay readable.
       */
      minify: "esbuild",
      rollupOptions: {
        /**
         * Two pages out of one app.
         *
         * `index.html` is what the Electron window loads, reaching Main through the
         * preload. `remote.html` is what the remote server serves to a browser, reaching
         * the same Main over a WebSocket. They share every chunk below the entry — it is
         * the same React tree — and differ only in how `window.fastvibe` is installed.
         */
        input: {
          index: resolve("src/renderer/index.html"),
          remote: resolve("src/renderer/remote.html"),
        },
      },
    },
  },
});
