#!/usr/bin/env node
/**
 * Rebuild the README's hero image: one frame of the real client UI, split on a diagonal
 * between the light theme (left) and the dark theme (right).
 *
 * The two halves are ordinary captures of the desktop client's own fixture (`mock.html`,
 * the `workspace` scene over the `?desktop=1` wallpaper), so the seam is the only thing
 * drawn here — nothing about the UI is faked. The same fixture drives the marketing site's
 * screenshots (see fastvibe-services' `scripts/capture-website.mjs`); this script is the
 * README's copy of that path, because the hero lives in this repository.
 *
 *   node scripts/capture-readme-hero.mjs            # writes docs/images/workspace-{en,zh}.webp
 *
 * Needs a Chromium or Chrome binary (CHROME_PATH) and the playwright package
 * (PLAYWRIGHT_PATH, or the one installed in ../fastvibe-services/website). It reuses a
 * Vite server already listening on CAPTURE_PORT, otherwise it starts and stops its own.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.CAPTURE_PORT ?? 5175);
const origin = `http://127.0.0.1:${port}`;
const chrome =
  process.env.CHROME_PATH ??
  (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
/** Where the seam sits: light on the left of the line, dark on the right. */
const SEAM_TOP = 0.62;
const SEAM_BOTTOM = 0.38;
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;
const WEBP_QUALITY = 88;
const languages = ["zh", "en"];
const outputDir = path.join(root, "docs/images");

async function loadPlaywright() {
  try {
    return createRequire(path.join(root, "package.json"))("playwright");
  } catch {
    /* not a dependency of this repository — fall through to the sibling checkout */
  }
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    path.join(root, "..", "fastvibe-services", "website", "node_modules", "playwright"),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      return await import(pathToFileURL(path.join(dir, "index.mjs")).href);
    } catch {
      // Try the next place; the error below says what was looked for.
    }
  }
  throw new Error(
    `Playwright was not found. Set PLAYWRIGHT_PATH to a playwright package directory.\nLooked in: ${candidates.join(", ")}`,
  );
}

async function serverReady() {
  try {
    const response = await fetch(`${origin}/mock.html`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited with code ${child.exitCode}`);
    if (await serverReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not start at ${origin}`);
}

let vite = null;
let browser = null;
try {
  if (!(await serverReady())) {
    vite = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/vite/bin/vite.js"),
        "src/renderer",
        "--config",
        "vite.config.ts",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      { cwd: root, detached: process.platform !== "win32", stdio: "inherit", env: process.env },
    );
    await waitForServer(vite);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true, executablePath: chrome });

  /**
   * Both themes of one language, from a single page load. The two halves are cut along one
   * line, so they have to be the *same* frame: the scene is still unfolding while it settles,
   * and two loads of one URL are two different moments in that unfolding — the seam then
   * lands on a sidebar row in one half and on nothing in the other. So the theme is switched
   * in place, the way the marketing site switches its own iframe (`fastvibe-website-theme`).
   */
  async function capture({ language }) {
    const errors = [];
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    page.on("pageerror", (error) => errors.push(error.message));
    const url =
      `${origin}/mock.html?website=1&lang=${language}&scene=workspace` +
      "&platform=darwin&desktop=1&theme=light";
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction((lang) => document.documentElement.lang.startsWith(lang), language);
    await page.waitForFunction(() => document.body.dataset.websiteSceneReady === "workspace");
    // The pane's spring animation and syntax highlighting need to have landed.
    await page.waitForTimeout(1500);
    // 回到底部 is for a reader mid-thread; in a still it covers the sentence beneath it.
    await page.addStyleTag({ content: '[data-slot="message-scroller-button"] { visibility: hidden !important; }' });
    const bodyText = await page.locator("body").innerText();
    if (/界面出错|The interface hit an error|Getting ready…|正在准备/.test(bodyText)) {
      throw new Error(`${language}: an error or loading state is still visible`);
    }

    const light = await page.screenshot({ type: "png" });
    await page.evaluate(() => {
      window.postMessage({ type: "fastvibe-website-theme", theme: "dark" }, window.location.origin);
    });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    // The tokens cross-fade; shoot once the last of them has arrived.
    await page.waitForTimeout(1200);
    if (errors.length) throw new Error(`${language}: ${errors.join("; ")}`);
    const dark = await page.screenshot({ type: "png" });
    await page.close();
    // The seam only reads as a seam if the two halves are the same frame; keep the raw
    // captures around when looking at why they are not.
    if (process.env.HERO_DEBUG_DIR) {
      const dir = path.resolve(process.env.HERO_DEBUG_DIR);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${language}-light.png`), light);
      await writeFile(path.join(dir, `${language}-dark.png`), dark);
    }
    return { light, dark };
  }

  /**
   * Cut the two frames along one line and encode the result. The drawing is a canvas in
   * the page rather than an image tool, because Chromium is the only thing here that can
   * write WebP — and the seam has to be the browser's own antialiased clip anyway.
   */
  async function compose({ language, light, dark }) {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
    const frames = new Map([
      [`${origin}/__hero/light.png`, light],
      [`${origin}/__hero/dark.png`, dark],
    ]);
    await page.route(`${origin}/__hero/*`, (route) => {
      const body = frames.get(route.request().url());
      if (!body) return route.fulfill({ status: 404, body: "missing" });
      route.fulfill({ status: 200, contentType: "image/png", body });
    });
    await page.route(`${origin}/__hero`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><title>hero</title><body></body>`,
      }),
    );
    // Same-origin as the mock so the canvas is not tainted and can hand back WebP bytes.
    await page.goto(`${origin}/__hero`);
    const dataUrl = await page.evaluate(
      async ({ top, bottom, quality, width, height }) => {
        const [light, dark] = await Promise.all([
          loadImage("/__hero/light.png"),
          loadImage("/__hero/dark.png"),
        ]);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(light, 0, 0, width, height);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(top * width, 0);
        ctx.lineTo(width, 0);
        ctx.lineTo(width, height);
        ctx.lineTo(bottom * width, height);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(dark, 0, 0, width, height);
        ctx.restore();
        return canvas.toDataURL("image/webp", quality);

        function loadImage(src) {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`could not load ${src}`));
            img.src = src;
          });
        }
      },
      {
        top: SEAM_TOP,
        bottom: SEAM_BOTTOM,
        quality: WEBP_QUALITY / 100,
        width: VIEWPORT.width * SCALE,
        height: VIEWPORT.height * SCALE,
      },
    );
    await page.close();
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const file = path.join(outputDir, `workspace-${language}.webp`);
    await writeFile(file, Buffer.from(base64, "base64"));
    console.log(`workspace-${language}.webp`);
  }

  await mkdir(outputDir, { recursive: true });
  for (const language of languages) {
    await compose({ language, ...(await capture({ language })) });
  }
} finally {
  await browser?.close();
  if (vite?.pid) {
    try {
      if (process.platform === "win32") vite.kill("SIGTERM");
      else process.kill(-vite.pid, "SIGTERM");
    } catch {
      // The child may already have exited.
    }
  }
}
