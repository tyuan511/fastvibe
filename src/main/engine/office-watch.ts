import { execFile, spawn } from "node:child_process";
import { realpathSync, watch as watchFile, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { officeCliInstall, type OfficeCliInstall } from "./office-cli.ts";
import { uiText } from "./ui-text.ts";

/**
 * One `officecli watch` per open local Office file.
 *
 * The static snapshot is the preview everywhere else. This process exists only while a person
 * has the file open in the side pane: it is what makes the page follow the agent's edits, and
 * what `get selected` / `mark` / `goto` talk to. A phone cannot use the address — it is
 * `127.0.0.1` — so the call that starts it is refused remotely.
 *
 * Two windows opening one file share the process (a reference count). Closing the last one
 * waits a few seconds before killing it, so flipping between tabs does not pay the startup
 * again. Quitting the app kills them all; an idle watch also exits on its own, which is how a
 * crash here does not leave a server behind.
 *
 * OfficeCLI only refreshes when *it* writes the file. A save from Word, or from a script the
 * agent ran, is invisible to it — so a change on disk is followed by `POST /api/switch` with
 * the same path, which is the reload AionCore uses.
 *
 * The spawner, the probe and the switch are dependencies. `test/office-watch.test.ts` covers
 * reuse, the reference count, a taken port and a watch that never becomes ready, without a
 * binary.
 */

const READY_TIMEOUT_MS = 15_000;
const PROBE_INTERVAL_MS = 100;
const PORT_ATTEMPTS = 3;
const RELEASE_DELAY_MS = 3_000;
const SWITCH_DEBOUNCE_MS = 400;
const MAX_STDERR_CHARS = 2_000;

export type OfficeWatchPhase = "starting" | "ready" | "stopped" | "error";

export type OfficeWatchState = {
  path: string;
  phase: OfficeWatchPhase;
  url?: string;
  port?: number;
  message?: string;
};

export type OfficeWatchHandle = {
  path: string;
  url: string;
  port: number;
};

export type OfficeWatchChild = {
  kill: () => void;
  /** Resolves when the process has gone. `code` is null when it was killed. */
  exited: Promise<{ code: number | null; stderr: string }>;
};

export type OfficeWatchDeps = {
  install?: OfficeCliInstall;
  spawn?: (input: { binary: string; file: string; port: number }) => OfficeWatchChild;
  /** True once `http://127.0.0.1:<port>/` answers. */
  probe?: (port: number) => Promise<boolean>;
  pickPort?: () => Promise<number>;
  /** Tell a running watch to re-read the file. Failures are ignored by the caller. */
  switchFile?: (port: number, file: string) => Promise<void>;
  observeFile?: (file: string, onChange: () => void) => { close: () => void };
  readSelection?: (binary: string, file: string) => Promise<unknown>;
  releaseDelayMs?: number;
  readyTimeoutMs?: number;
  onState?: (state: OfficeWatchState) => void;
};

type Session = {
  path: string;
  port: number;
  url: string;
  refs: number;
  child: OfficeWatchChild;
  releaseTimer?: ReturnType<typeof setTimeout>;
  observer?: { close: () => void };
  switchTimer?: ReturnType<typeof setTimeout>;
};

export type OfficeWatchManager = {
  start: (file: string) => Promise<OfficeWatchHandle>;
  stop: (file: string) => void;
  stopAll: () => Promise<void>;
  /** Read what the open preview has selected. Throws when nothing is selected or no watch is up. */
  selection: (file: string) => Promise<OfficeSelection>;
};

export type OfficeSelectionItem = {
  path: string;
  type: string;
  text: string;
};

export type OfficeSelection = {
  items: OfficeSelectionItem[];
  /** What the composer attaches: the file, each element path, and a short quote. */
  text: string;
};

export function createOfficeWatchManager(deps: OfficeWatchDeps = {}): OfficeWatchManager {
  const sessions = new Map<string, Session>();
  const starting = new Map<string, Promise<OfficeWatchHandle>>();
  /** A stop that arrived before the process was up. The launch drops the ref it just took. */
  const releasedEarly = new Set<string>();
  const releaseDelayMs = deps.releaseDelayMs ?? RELEASE_DELAY_MS;
  const readyTimeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;

  function emit(state: OfficeWatchState): void {
    deps.onState?.(state);
  }

  function release(path: string, session: Session): void {
    if (sessions.get(path) !== session || session.refs > 0) return;
    sessions.delete(path);
    session.observer?.close();
    if (session.switchTimer) clearTimeout(session.switchTimer);
    session.child.kill();
    emit({ path, phase: "stopped" });
  }

  /**
   * Arm the delayed kill. The handle is cleared when the timer fires: a timer that fires while a
   * reference has come back returns early, and a stale handle left on the session would make
   * every later `stop` think a release is already pending — the watch would then never be killed.
   */
  function scheduleRelease(path: string, session: Session): void {
    if (session.releaseTimer) clearTimeout(session.releaseTimer);
    session.releaseTimer = setTimeout(() => {
      session.releaseTimer = undefined;
      release(path, session);
    }, releaseDelayMs);
  }

  function real(file: string): string {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  }

  async function launch(file: string): Promise<OfficeWatchHandle> {
    const install = deps.install ?? officeCliInstall();
    const binary = install.binary;
    if (!binary) {
      throw new Error(uiText(
        "这台机器上的 FastVibe 没有内置 OfficeCLI，无法打开实时预览",
        "This FastVibe install carries no OfficeCLI, so the live preview cannot start",
      ));
    }
    const spawnWatch = deps.spawn ?? spawnOfficeCliWatch;
    const probe = deps.probe ?? probeWatch;
    const pickPort = deps.pickPort ?? pickLoopbackPort;
    let last = uiText("实时预览没有起来", "The live preview did not start");
    for (let attempt = 1; attempt <= PORT_ATTEMPTS; attempt += 1) {
      const port = await pickPort();
      const child = spawnWatch({ binary, file, port });
      const ready = await waitUntilReady(port, probe, child, readyTimeoutMs);
      if (ready.ok) {
        const url = `http://127.0.0.1:${port}/`;
        const session: Session = { path: file, port, url, refs: 1, child };
        session.observer = armObserver(file, port, session);
        sessions.set(file, session);
        if (releasedEarly.has(file)) {
          releasedEarly.delete(file);
          session.refs = 0;
          scheduleRelease(file, session);
        }
        void child.exited.then(() => {
          if (sessions.get(file) !== session) return;
          sessions.delete(file);
          session.observer?.close();
          emit({ path: file, phase: "stopped", message: uiText("实时预览已退出", "The live preview exited") });
        });
        emit({ path: file, phase: "ready", url, port });
        return { path: file, url, port };
      }
      child.kill();
      await child.exited.catch(() => undefined);
      last = ready.message;
    }
    throw new Error(last);
  }

  function armObserver(file: string, port: number, session: Session): { close: () => void } {
    const observe = deps.observeFile ?? observeOfficeFile;
    const reload = deps.switchFile ?? switchWatchFile;
    return observe(file, () => {
      if (session.switchTimer) clearTimeout(session.switchTimer);
      session.switchTimer = setTimeout(() => {
        session.switchTimer = undefined;
        void reload(port, file).catch(() => undefined);
      }, SWITCH_DEBOUNCE_MS);
    });
  }

  return {
    async start(file: string): Promise<OfficeWatchHandle> {
      const path = real(file);
      const live = sessions.get(path);
      if (live) {
        if (live.releaseTimer) {
          clearTimeout(live.releaseTimer);
          live.releaseTimer = undefined;
        }
        live.refs += 1;
        return { path, url: live.url, port: live.port };
      }
      const pending = starting.get(path);
      if (pending) {
        const handle = await pending;
        const session = sessions.get(path);
        if (session) {
          // The launch may have armed a release for a stop that arrived while it was starting.
          if (session.releaseTimer) {
            clearTimeout(session.releaseTimer);
            session.releaseTimer = undefined;
          }
          session.refs += 1;
        }
        return handle;
      }
      emit({ path, phase: "starting" });
      const job = launch(path).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : uiText("实时预览没有起来", "The live preview did not start");
        emit({ path, phase: "error", message });
        throw error instanceof Error ? error : new Error(message);
      });
      starting.set(path, job);
      try {
        return await job;
      } finally {
        if (starting.get(path) === job) starting.delete(path);
      }
    },

    stop(file: string): void {
      const path = real(file);
      const session = sessions.get(path);
      if (!session) {
        if (starting.has(path)) releasedEarly.add(path);
        return;
      }
      session.refs = Math.max(0, session.refs - 1);
      if (session.refs > 0 || session.releaseTimer) return;
      scheduleRelease(path, session);
    },

    async stopAll(): Promise<void> {
      const running = [...sessions.values()];
      sessions.clear();
      starting.clear();
      releasedEarly.clear();
      await Promise.all(running.map(async (session) => {
        if (session.releaseTimer) clearTimeout(session.releaseTimer);
        if (session.switchTimer) clearTimeout(session.switchTimer);
        session.observer?.close();
        session.child.kill();
        await session.child.exited.catch(() => undefined);
      }));
    },

    async selection(file: string): Promise<OfficeSelection> {
      const path = real(file);
      if (!sessions.has(path)) {
        throw new Error(uiText("这个文件没有打开实时预览", "This file has no live preview open"));
      }
      const install = deps.install ?? officeCliInstall();
      if (!install.binary) {
        throw new Error(uiText("这台机器上的 FastVibe 没有内置 OfficeCLI", "This FastVibe install carries no OfficeCLI"));
      }
      const read = deps.readSelection ?? readOfficeSelection;
      const payload = await read(install.binary, path);
      const selection = formatOfficeSelection(path, payload);
      if (selection.items.length === 0) {
        throw new Error(uiText("预览里还没有选中内容", "Nothing is selected in the preview"));
      }
      return selection;
    },
  };
}

type Ready = { ok: true } | { ok: false; message: string };

async function waitUntilReady(
  port: number,
  probe: (port: number) => Promise<boolean>,
  child: OfficeWatchChild,
  timeoutMs: number,
): Promise<Ready> {
  const deadline = Date.now() + timeoutMs;
  const gone: { value: { code: number | null; stderr: string } | null } = { value: null };
  void child.exited.then((result) => {
    gone.value = result;
  });
  while (Date.now() < deadline) {
    const exited = gone.value;
    if (exited) return { ok: false, message: watchFailure(exited.code, exited.stderr) };
    try {
      if (await probe(port)) return { ok: true };
    } catch {
      // Not listening yet.
    }
    await delay(PROBE_INTERVAL_MS);
  }
  return { ok: false, message: uiText("实时预览启动超时", "The live preview took too long to start") };
}

function watchFailure(code: number | null, stderr: string): string {
  const reason = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
  if (reason) return reason;
  return `${uiText("实时预览没有起来", "The live preview did not start")}${code === null ? "" : ` (code ${code})`}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pickLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

export async function probeWatch(port: number): Promise<boolean> {
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
  return response.ok;
}

export async function switchWatchFile(port: number, file: string): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/api/switch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
    signal: AbortSignal.timeout(5_000),
  });
}

export function spawnOfficeCliWatch(input: { binary: string; file: string; port: number }): OfficeWatchChild {
  const child = spawn(input.binary, ["watch", input.file, "--port", String(input.port)], {
    stdio: ["ignore", "ignore", "pipe"],
    env: process.env,
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once("error", () => resolve({ code: null, stderr }));
    child.once("close", (code) => resolve({ code, stderr }));
  });
  return {
    exited,
    kill: () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      // `child.killed` only says a signal was sent, so it is already true here. The process is
      // still running until it reports an exit code or a signal, and that is what decides.
      const later = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      later.unref?.();
      child.once("close", () => clearTimeout(later));
    },
  };
}

/**
 * Notice a save to this one file.
 *
 * The directory is watched, not the file: Word and most editors save by writing a temporary
 * file and renaming it over the original, which replaces the inode a file watcher is attached
 * to — the watcher then goes silent after the first save. A directory watcher sees the rename,
 * and the name filter keeps unrelated files in the folder (and Office's `~$name` lock file)
 * from causing reloads.
 */
export function observeOfficeFile(file: string, onChange: () => void): { close: () => void } {
  const dir = dirname(file);
  const name = basename(file);
  let watcher: FSWatcher;
  try {
    watcher = watchFile(dir, { persistent: false }, (_event, changed) => {
      // `filename` can be null on some platforms; reloading then is cheap and correct.
      if (changed === null || changed === undefined || changed.toString() === name) onChange();
    });
  } catch {
    return { close: () => undefined };
  }
  watcher.on("error", () => undefined);
  return { close: () => watcher.close() };
}

export async function readOfficeSelection(binary: string, file: string): Promise<unknown> {
  const run = promisify(execFile);
  const { stdout } = await run(binary, ["get", file, "selected", "--json"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2_000_000,
    env: process.env,
    windowsHide: true,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(uiText("读不到预览里的选中内容", "Could not read the preview selection"));
  }
}

const QUOTE_CHARS = 80;

/**
 * Turn `officecli get <file> selected --json` into the citation the composer attaches.
 *
 * The path OfficeCLI returns is the stable `@id=` form, which still names the element after
 * the file is edited. The quote is only so the reader can see which paragraph they picked.
 */
export function formatOfficeSelection(file: string, payload: unknown): OfficeSelection {
  const items = selectionItems(payload);
  const name = file.split(/[\\/]/).pop() || file;
  const lines = items.map((item) => {
    const quote = item.text ? ` — ${item.text}` : "";
    return `- ${item.path}${item.type ? ` (${item.type})` : ""}${quote}`;
  });
  const text = [
    uiText(`引用自 ${name} 的选中内容：`, `Selection cited from ${name}:`),
    ...lines,
    "",
    uiText(
      `文件：${file}`,
      `File: ${file}`,
    ),
    uiText(
      "用 officecli set 按上面的路径修改。路径在文件改动后仍然有效。文件没在侧栏实时预览里打开时，不要用 watch 的 goto / mark。",
      "Edit with officecli set using the path above. The path stays valid after the file changes. Do not use watch goto / mark unless this file is open in the live sidebar preview.",
    ),
  ].join("\n");
  return { items, text };
}

function selectionItems(payload: unknown): OfficeSelectionItem[] {
  const record = asRecord(payload);
  const data = asRecord(record?.data) ?? record;
  const results = data?.results;
  if (!Array.isArray(results)) return [];
  const items: OfficeSelectionItem[] = [];
  for (const row of results) {
    const item = asRecord(row);
    if (!item) continue;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (!path) continue;
    const text = clip(typeof item.preview === "string" ? item.preview : typeof item.text === "string" ? item.text : "");
    items.push({ path, type: typeof item.type === "string" ? item.type : "", text });
  }
  return items;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  if (chars.length <= QUOTE_CHARS) return flat;
  return `${chars.slice(0, QUOTE_CHARS).join("")}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

let shared: OfficeWatchManager | null = null;

/** The process-wide manager. Created on first use so a test can build its own. */
export function officeWatches(deps?: OfficeWatchDeps): OfficeWatchManager {
  if (deps) return createOfficeWatchManager(deps);
  return shared ??= createOfficeWatchManager();
}

export async function stopOfficeWatches(): Promise<void> {
  if (!shared) return;
  await shared.stopAll();
  shared = null;
}
