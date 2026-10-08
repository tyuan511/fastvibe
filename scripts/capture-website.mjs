#!/usr/bin/env node
/**
 * Capture the six website product screenshots from the real renderer mock, plus the
 * laptop image beside 桌面端下载 (light and dark).
 *
 * Run `pnpm --filter @fastvibe/website screenshots` after `pnpm install`.
 * Uses Google Chrome on macOS, or Playwright Chromium elsewhere; CHROME_PATH
 * overrides the browser. PLAYWRIGHT_PATH can override the package directory.
 * The script reuses an existing Vite server on CAPTURE_PORT, otherwise it starts
 * and stops its own server.
 */
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.env.CAPTURE_PORT ?? 5175);
const origin = `http://127.0.0.1:${port}`;
const chrome = process.env.CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
// Every scene the mock harness can reach a stable state for. `capture-website` waits on
// `websiteSceneReady`, which the harness sets once the pane/tab/fold the scene is about
// has actually rendered — a scene with no way to reach that state would hang here rather
// than ship a blank frame.
const scenes = ["workspace", "files", "review", "tools", "models", "market"];
const languages = ["zh", "en"];

async function loadPlaywright() {
  try {
    const websiteRequire = createRequire(path.join(root, "apps/website/package.json"));
    return websiteRequire("playwright");
  } catch {
    const packageDir = process.env.PLAYWRIGHT_PATH;
    if (!packageDir) throw new Error("Run pnpm install first, or set PLAYWRIGHT_PATH to a playwright package directory.");
    const entry = path.join(packageDir, "index.mjs");
    try {
      await access(entry);
      return await import(pathToFileURL(entry).href);
    } catch {
      throw new Error(
        "Playwright is required. Install it or set PLAYWRIGHT_PATH to the playwright package directory.",
      );
    }
  }
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
      [path.join(root, "node_modules/vite/bin/vite.js"), "src/renderer", "--config", "vite.config.ts", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: "inherit",
        env: process.env,
      },
    );
    await waitForServer(vite);
  }

  const { chromium } = await loadPlaywright();
  browser = await chromium.launch({ headless: true, executablePath: chrome });

  /**
   * One capture: load the scene, wait until the harness says it is drawn, check it is the
   * finished frame (traffic lights, no error or loading copy), then shoot.
   */
  async function capture({ language, scene, query = "", viewport, scale, output, type, quality, label }) {
    const pageErrors = [];
    const page = await browser.newPage({ viewport, deviceScaleFactor: scale });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    // `desktop=1`: the window floats over a colourful wallpaper with 玻璃效果 on, the way
    // it looks on a Mac — the material is simulated, since a browser has no system blur.
    const url = `${origin}/mock.html?website=1&lang=${language}&scene=${scene}&platform=darwin&desktop=1${query}`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction((lang) => document.documentElement.lang.startsWith(lang), language);
    await page.waitForFunction((expected) => document.body.dataset.websiteSceneReady === expected, scene);
    // Let the real pane's spring animation and syntax highlighting finish.
    await page.waitForTimeout(1000);

    const trafficLights = await page.locator('[data-website-traffic-lights="true"] > span').evaluateAll((lights) =>
      lights.map((light) => {
        const rect = light.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    if (trafficLights.length !== 3 || trafficLights.some((light) => light.width !== 12 || light.height !== 12)) {
      throw new Error(`${label}: macOS traffic lights are missing or incorrectly sized`);
    }
    if (pageErrors.length) throw new Error(`${label}: ${pageErrors.join("; ")}`);

    const bodyText = await page.locator("body").innerText();
    if (/界面出错|The interface hit an error|Getting ready…|正在准备/.test(bodyText)) {
      throw new Error(`${label}: an error or loading state is still visible`);
    }

    // 回到底部 is a control for a reader mid-thread; in a still it is a button sitting on
    // top of the sentence it covers. The live hero keeps it.
    await page.addStyleTag({ content: '[data-slot="message-scroller-button"] { visibility: hidden !important; }' });

    await page.screenshot({ path: output, type, quality, animations: "disabled" });
    console.log(`${label}: ${output}`);
    await page.close();
  }

  for (const language of languages) {
    const outputDir = path.join(root, "apps/website/public/screenshots", language);
    await mkdir(outputDir, { recursive: true });
    for (const scene of scenes) {
      await capture({
        language,
        scene,
        viewport: { width: 1440, height: 900 },
        scale: 2,
        output: path.join(outputDir, `${scene}.webp`),
        type: "webp",
        quality: 88,
        label: `${language}/${scene}`,
      });
    }

    // The laptop beside 桌面端下载 (`access-module.tsx`): the chat on its own, once per
    // theme, since the site shows whichever one the visitor is in. 1600×1000 is the size
    // the page lays out, rendered from the same 1440×900 frame as the other shots.
    const desktopDir = path.join(root, "apps/website/public/desktop", language);
    await mkdir(desktopDir, { recursive: true });
    for (const theme of ["light", "dark"]) {
      await capture({
        language,
        scene: "workspace",
        query: `&pane=none&theme=${theme}`,
        viewport: { width: 1440, height: 900 },
        scale: 1600 / 1440,
        output: path.join(desktopDir, `workspace-${theme}.jpg`),
        type: "jpeg",
        quality: 86,
        label: `${language}/desktop-${theme}`,
      });
    }
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
