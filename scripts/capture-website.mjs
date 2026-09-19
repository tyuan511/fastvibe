#!/usr/bin/env node
/**
 * Capture the six website product screenshots from the real renderer mock.
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
const scenes = ["workspace", "review", "models"];
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

  for (const language of languages) {
    const outputDir = path.join(root, "apps/website/public/screenshots", language);
    await mkdir(outputDir, { recursive: true });

    for (const scene of scenes) {
      const pageErrors = [];
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const url = `${origin}/mock.html?website=1&lang=${language}&scene=${scene}&platform=darwin`;
      await page.goto(url, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction((lang) => document.documentElement.lang.startsWith(lang), language);
      if (scene !== "models") {
        await page.waitForFunction((expected) => document.body.dataset.websiteSceneReady === expected, scene);
      } else {
        await page.getByText(language === "zh" ? "API 密钥" : "API key", { exact: true }).waitFor();
      }
      // Let the real pane's spring animation and syntax highlighting finish.
      await page.waitForTimeout(1000);

      const trafficLights = await page.locator('[data-website-traffic-lights="true"] > span').evaluateAll((lights) =>
        lights.map((light) => {
          const rect = light.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      );
      if (trafficLights.length !== 3 || trafficLights.some((light) => light.width !== 12 || light.height !== 12)) {
        throw new Error(`${language}/${scene}: macOS traffic lights are missing or incorrectly sized`);
      }
      if (pageErrors.length) throw new Error(`${language}/${scene}: ${pageErrors.join("; ")}`);

      const bodyText = await page.locator("body").innerText();
      if (/界面出错|The interface hit an error|Getting ready…|正在准备/.test(bodyText)) {
        throw new Error(`${language}/${scene}: an error or loading state is still visible`);
      }

      const output = path.join(outputDir, `${scene}.webp`);
      await page.screenshot({ path: output, type: "webp", quality: 88, animations: "disabled" });
      console.log(`${language}/${scene}: ${output}`);
      await page.close();
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
