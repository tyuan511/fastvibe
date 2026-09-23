import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readAppSettings } from "./app-settings";
import { getFastVibePaths } from "./paths";
import { clickBody, pageProgram, pressBody, SNAPSHOT_BODY, typeBody } from "@shared/browser-page";
import type { BrowserRequest } from "@shared/types";
import { uiText } from "./ui-text";

/**
 * browser-use against the user's own browser, over the Chrome DevTools Protocol.
 *
 * The side pane's webview cannot be the system browser: a Chrome the user already
 * has open is not listening for anyone. So this launches one itself, on loopback,
 * with a profile FastVibe owns — the user's default profile is locked for as long
 * as their own Chrome is running, and a second process pointed at it exits. Login
 * state reaches that profile through the existing cookie import, not by borrowing
 * the live one.
 *
 * The tool surface is unchanged. `requestBrowser` decides which backend answers.
 */

const PORT = 9333;
const SEARCH = "https://www.google.com/search?q=";

/** The profile browser-use launches, so an import and a later run share one login state. */
export function browserProfileDir(): string {
  return join(getFastVibePaths().runtimeRoot, "browser-profile");
}

type Target = { id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string };
type CdpResult = { id: number; result?: Record<string, unknown>; error?: { message?: string } };

type Session = {
  id: string;
  targetId: string;
  socket: WebSocket;
  url: string;
  title: string;
  seq: number;
  pending: Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>;
};

let chrome: ChildProcess | null = null;
const sessions = new Map<string, Session>();

function fail(zh: string, en: string): Error {
  return new Error(uiText(zh, en));
}

type BrowserChoice = "auto" | "chrome" | "edge" | "brave" | "chromium" | "arc" | "opera";

/** One installable browser and the binary a platform would launch for it. */
type BrowserCandidate = { id: Exclude<BrowserChoice, "auto">; label: string; paths: string[] };

/** Where each browser lives on this machine, in the order a user would expect. */
function catalog(): BrowserCandidate[] {
  if (process.platform === "darwin") {
    const home = homedir();
    return [
      { id: "chrome", label: "Google Chrome", paths: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")] },
      { id: "edge", label: "Microsoft Edge", paths: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] },
      { id: "brave", label: "Brave", paths: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"] },
      { id: "chromium", label: "Chromium", paths: ["/Applications/Chromium.app/Contents/MacOS/Chromium"] },
      { id: "arc", label: "Arc", paths: ["/Applications/Arc.app/Contents/MacOS/Arc"] },
      { id: "opera", label: "Opera", paths: ["/Applications/Opera.app/Contents/MacOS/Opera"] },
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    const program = process.env.PROGRAMFILES ?? "C:\\Program Files";
    return [
      { id: "chrome", label: "Google Chrome", paths: [join(program, "Google", "Chrome", "Application", "chrome.exe"), join(local, "Google", "Chrome", "Application", "chrome.exe")] },
      { id: "edge", label: "Microsoft Edge", paths: [join(program, "Microsoft", "Edge", "Application", "msedge.exe"), join(local, "Microsoft", "Edge", "Application", "msedge.exe")] },
      { id: "brave", label: "Brave", paths: [join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")] },
      { id: "chromium", label: "Chromium", paths: [join(local, "Chromium", "Application", "chrome.exe")] },
    ];
  }
  return [
    { id: "chrome", label: "Google Chrome", paths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"] },
    { id: "edge", label: "Microsoft Edge", paths: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"] },
    { id: "brave", label: "Brave", paths: ["/usr/bin/brave-browser", "/usr/bin/brave"] },
    { id: "chromium", label: "Chromium", paths: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"] },
  ];
}

function installedPath(entry: BrowserCandidate): string | undefined {
  return entry.paths.find((path) => existsSync(path));
}

function browserChoice(): BrowserChoice {
  try {
    const value = readAppSettings(getFastVibePaths()).browserEngine;
    if (value === "chrome" || value === "edge" || value === "brave" || value === "chromium" || value === "arc" || value === "opera") return value;
  } catch { /* an unreadable settings file is the same as no preference */ }
  return "auto";
}

/**
 * The binary browser-use launches. A pinned choice is used only when that browser is
 * actually installed; otherwise the first one found is used, which is what 自动
 * means and what a missing pin must fall back to rather than failing the tool.
 */
function findBrowser(): string {
  const list = catalog();
  const choice = browserChoice();
  if (choice !== "auto") {
    const pinned = list.find((entry) => entry.id === choice);
    const path = pinned && installedPath(pinned);
    if (path) return path;
  }
  for (const entry of list) {
    const path = installedPath(entry);
    if (path) return path;
  }
  throw fail("没有找到 Chrome、Edge 或 Chromium，无法使用系统浏览器", "No Chrome, Edge or Chromium found for the system browser");
}

/** Browsers this machine can actually launch, for the settings picker. */
export function installedBrowsers(): Array<{ id: BrowserChoice; label: string }> {
  const found = catalog()
    .filter((entry) => installedPath(entry))
    .map((entry) => ({ id: entry.id as BrowserChoice, label: entry.label }));
  return [{ id: "auto", label: "" }, ...found];
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (/\s/u.test(trimmed) || /[^\x00-\x7f]/u.test(trimmed) || (!trimmed.includes(".") && !/^localhost(?::\d+)?$/i.test(trimmed))) {
    return `${SEARCH}${encodeURIComponent(trimmed)}`;
  }
  return `https://${trimmed}`;
}

async function endpointUp(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * A port already answering is a Chrome FastVibe started earlier and that outlived
 * the app (a crash, a quit that did not reach the child). Reuse it: launching a
 * second one against the same profile fails, and killing whatever answers would
 * close a browser the user may be looking at.
 */
async function ensureChrome(profileDir: string): Promise<void> {
  if (await endpointUp()) return;
  await mkdir(profileDir, { recursive: true });
  const binary = findBrowser();
  const child = spawn(binary, [
    `--remote-debugging-port=${PORT}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "about:blank",
  ], { stdio: "ignore", detached: false });
  chrome = child;
  child.once("exit", () => {
    if (chrome === child) chrome = null;
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await endpointUp()) return;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw fail("系统浏览器没有在限定时间内开放调试端口", "The system browser did not open its debugging port in time");
}

async function targets(): Promise<Target[]> {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3_000) });
  const list = (await response.json()) as Target[];
  return list.filter((item) => item.type === "page" && item.webSocketDebuggerUrl);
}

async function newTarget(url: string): Promise<Target> {
  // Chrome 111+ only accepts PUT here and reads the URL from the body; older builds
  // only accept the query form. Try the current one first.
  const put = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    body: url,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  if (put?.ok) return (await put.json()) as Target;
  const response = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10_000) });
  return (await response.json()) as Target;
}

function connect(target: Target): Promise<Session> {
  const session: Session = {
    id: `cdp:${target.id}`,
    targetId: target.id,
    socket: undefined as unknown as WebSocket,
    url: target.url,
    title: target.title,
    seq: 0,
    pending: new Map(),
  };
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(fail("连接系统浏览器超时", "Timed out connecting to the system browser"));
    }, 8_000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      session.socket = socket;
      sessions.set(session.id, session);
      resolve(session);
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResult;
      const waiter = session.pending.get(message.id);
      if (!waiter) return;
      session.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || "cdp error"));
      else waiter.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      sessions.delete(session.id);
      for (const waiter of session.pending.values()) waiter.reject(fail("系统浏览器连接已断开", "The system browser connection closed"));
      session.pending.clear();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(fail("无法连接系统浏览器", "Could not connect to the system browser"));
    });
  });
}

function send(session: Session, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const id = ++session.seq;
  return new Promise((resolve, reject) => {
    session.pending.set(id, { resolve, reject });
    session.socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(session: Session, body: string): Promise<unknown> {
  const result = await send(session, "Runtime.evaluate", {
    expression: pageProgram(body),
    awaitPromise: true,
    returnByValue: true,
  });
  const remote = result.result as { value?: { ok?: boolean; value?: unknown; error?: string } } | undefined;
  const value = remote?.value;
  if (!value || value.ok === false) throw new Error(value?.error || uiText("页面脚本执行失败", "Page script failed"));
  return value.value;
}

async function navigate(session: Session, url: string): Promise<{ loaded: boolean; url: string }> {
  await send(session, "Page.navigate", { url });
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = (await evaluate(session, "return document.readyState").catch(() => "")) as string;
    if (state === "complete" || state === "interactive") {
      session.url = (await evaluate(session, "return location.href").catch(() => url)) as string;
      return { loaded: true, url: session.url };
    }
  }
  return { loaded: false, url };
}

async function liveSession(id: string | undefined, profileDir: string, fresh: boolean): Promise<Session> {
  await ensureChrome(profileDir);
  if (!fresh && id) {
    const known = sessions.get(id);
    if (known && known.socket.readyState === WebSocket.OPEN) return known;
  }
  if (!fresh) {
    for (const session of sessions.values()) {
      if (session.socket.readyState === WebSocket.OPEN) return session;
    }
    const open = await targets();
    const page = open.find((item) => item.url !== "about:blank") ?? open[0];
    if (page) return connect(page);
  }
  return connect(await newTarget("about:blank"));
}

/** One browser-use request, answered by the system browser instead of the webview. */
export async function runBrowserCdp(request: BrowserRequest, profileDir: string): Promise<unknown> {
  if (request.action === "list") {
    if (!(await endpointUp())) return [];
    const open = await targets();
    return open.map((item) => ({ tabId: `cdp:${item.id}`, url: item.url, title: item.title, alive: true }));
  }
  const session = await liveSession(request.tabId, profileDir, request.action === "open" && request.newTab === true);
  await send(session, "Runtime.enable").catch(() => undefined);
  await send(session, "Page.enable").catch(() => undefined);
  switch (request.action) {
    case "open":
    case "navigate": {
      const href = normalizeUrl(request.url ?? "");
      if (!request.url) return { tabId: session.id, url: session.url || "about:blank" };
      const outcome = await navigate(session, href);
      return { tabId: session.id, ...outcome };
    }
    case "search": {
      if (!request.text && !request.url) throw fail("search 需要 text", "search requires text");
      const outcome = await navigate(session, normalizeUrl(request.text || request.url || ""));
      return { tabId: session.id, query: request.text, ...outcome };
    }
    case "back":
      await evaluate(session, "history.back(); return true");
      return { ok: true };
    case "forward":
      await evaluate(session, "history.forward(); return true");
      return { ok: true };
    case "reload":
      await send(session, "Page.reload", { ignoreCache: false });
      return { ok: true, url: session.url };
    case "snapshot":
      return { tabId: session.id, ...(await evaluate(session, SNAPSHOT_BODY) as Record<string, unknown>) };
    case "click":
      if (!request.selector && !request.ref && !request.text) throw fail("click 需要 selector、ref 或 text", "click requires selector, ref or text");
      return evaluate(session, clickBody(request));
    case "type":
      if (!request.selector && !request.ref) throw fail("type 需要 selector 或 ref", "type requires selector or ref");
      return evaluate(session, typeBody(request));
    case "press":
      return evaluate(session, pressBody(request.key ?? "Enter"));
    case "evaluate":
      if (!request.script) throw fail("evaluate 需要 script", "evaluate requires script");
      return evaluate(session, request.script);
    default:
      throw fail(`未知浏览器操作：${request.action}`, `Unknown browser action: ${request.action}`);
  }
}

/** The browser FastVibe launched, and nothing else. A reused one is left alone. */
export function stopBrowserCdp(): void {
  for (const session of sessions.values()) {
    try { session.socket.close(); } catch { /* already gone */ }
  }
  sessions.clear();
  if (chrome && !chrome.killed) chrome.kill();
  chrome = null;
}

/**
 * Wait until the debugging port stops answering.
 *
 * `kill()` returns before the process has released its profile, and a cookie write
 * that lands while it is still flushing is the one the browser then overwrites.
 */
async function waitUntilDown(deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!(await endpointUp())) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return !(await endpointUp());
}

/**
 * Close the browser FastVibe launched so its profile can be written.
 * A port that keeps answering is a browser this app did not start — killing it
 * would close a window the user may be looking at — so the caller is told to wait.
 */
export async function releaseBrowserProfile(): Promise<void> {
  const wasOurs = chrome !== null && !chrome.killed;
  stopBrowserCdp();
  if (!(await endpointUp())) return;
  if (wasOurs && await waitUntilDown(5_000)) return;
  throw fail("系统浏览器仍在运行，请先关闭它再导入", "The system browser is still open. Close it, then import again.");
}

/** A cookie the selected browser should store for itself. Unix seconds, or omitted for a session cookie. */
export type ProfileCookie = {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
};

/**
 * Hand the cookies to the selected browser and let it store them.
 *
 * Its cookie database is encrypted with a key only that browser holds, so writing
 * the rows from here produces a profile it cannot read. Instead it is launched
 * once, headless, with a tiny extension whose only job is `chrome.cookies.set`,
 * and then closed again. The profile is the same directory a later browser-use run
 * launches, which is what makes the import show up there.
 */
export async function importIntoBrowserProfile(profileDir: string, cookies: ProfileCookie[]): Promise<number> {
  await releaseBrowserProfile();
  await mkdir(profileDir, { recursive: true });
  const extension = await mkdtemp(join(tmpdir(), "fastvibe-cookie-import-"));
  const { server, port, done } = await importSignal();
  try {
    await writeFile(join(extension, "manifest.json"), JSON.stringify({
      manifest_version: 3,
      name: "FastVibe cookie import",
      version: "1.0.0",
      permissions: ["cookies"],
      host_permissions: ["http://127.0.0.1/*"],
      background: { service_worker: "import.js" },
    }));
    await writeFile(join(extension, "import.js"), cookieImportWorker(cookies, port));
    const child = spawn(findBrowser(), [
      "--headless=new",
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extension}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      `--disable-extensions-except=${extension}`,
      "about:blank",
    ], { stdio: "ignore" });
    const written = await Promise.race([
      done,
      new Promise<undefined>((resolve) => child.once("exit", () => resolve(undefined))),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 45_000)),
    ]);
    if (!child.killed) child.kill();
    await waitUntilDown(5_000);
    if (written === undefined) throw fail("系统浏览器没有完成 Cookie 导入", "The system browser did not finish importing cookies");
    return written;
  } finally {
    server.close();
    await rm(extension, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A loopback port the extension calls once it has stored the cookies. It binds to whatever port is free. */
function importSignal(): Promise<{ server: Server; port: number; done: Promise<number> }> {
  return new Promise((resolve, reject) => {
    let settle: (count: number) => void = () => undefined;
    const done = new Promise<number>((resolveCount) => { settle = resolveCount; });
    const server = createServer((request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      const count = Number(new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("count"));
      response.writeHead(204);
      response.end();
      settle(Number.isFinite(count) ? count : 0);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("no port")); return; }
      resolve({ server, port: address.port, done });
    });
  });
}

/**
 * The extension the browser runs. It reports how many cookies it stored by calling
 * back to the loopback port, which is the only way out: an extension cannot quit
 * the browser, and it cannot write a file.
 */
function cookieImportWorker(cookies: ProfileCookie[], port: number): string {
  const payload = JSON.stringify(cookies).replace(/</g, "\\u003c");
  return `const cookies = ${payload};
chrome.runtime.onInstalled.addListener(async () => {
  let written = 0;
  for (const cookie of cookies) {
    const details = { url: cookie.url, name: cookie.name, value: cookie.value, path: cookie.path || "/", secure: Boolean(cookie.secure), httpOnly: Boolean(cookie.httpOnly) };
    if (cookie.domain && !String(cookie.name).startsWith("__Host-")) details.domain = cookie.domain;
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    if (cookie.sameSite && cookie.sameSite !== "unspecified") details.sameSite = cookie.sameSite;
    try { await chrome.cookies.set(details); written += 1; } catch { /* one bad cookie must not stop the rest */ }
  }
  await fetch("http://127.0.0.1:${port}/done?count=" + written).catch(() => undefined);
});
`;
}


