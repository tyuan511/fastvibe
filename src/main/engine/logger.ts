import { app, dialog, shell, type BrowserWindow } from "electron";
import { appendFileSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { getFastVibePaths } from "./paths";
import { uiText } from "./ui-text";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ROTATED_FILES = 4;
const MAX_MESSAGE_CHARS = 16_384;

type Stream = "main" | "renderer";

let logsDir = "";
let initialized = false;
let writing = false;
const bytes: Record<Stream, number> = { main: 0, renderer: 0 };

const consoleOriginals = {
  debug: console.debug.bind(console),
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/**
 * File logger for both processes.
 *
 * Main writes `logs/main.log` (console + crashes + explicit `log.*` calls).
 * The renderer cannot touch disk, so it ships lines over `app:log` and they land
 * in `logs/renderer.log`. Both files rotate at 5 MB, keeping four backups, and
 * 设置 → 关于 zips the directory through `exportLogs`.
 */
export function initLogger(): void {
  if (initialized) return;
  initialized = true;
  logsDir = getFastVibePaths().logs;
  seedSize("main");
  seedSize("renderer");
  hookConsole();
  hookProcess();
  write("main", "info", startLine());
}

export const log = {
  debug: (message: string, extra?: unknown) => write("main", "debug", joinMessage(message, extra)),
  info: (message: string, extra?: unknown) => write("main", "info", joinMessage(message, extra)),
  warn: (message: string, extra?: unknown) => write("main", "warn", joinMessage(message, extra)),
  error: (message: string, extra?: unknown) => write("main", "error", joinMessage(message, extra)),
};

/** Renderer lines arriving over IPC. Invalid payloads are dropped, never thrown. */
export function writeRendererLog(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const { level, message } = payload as { level?: unknown; message?: unknown };
  if (typeof message !== "string") return;
  const text = message.slice(0, MAX_MESSAGE_CHARS);
  if (!text) return;
  const resolved: LogLevel = typeof level === "string" && LEVELS.has(level as LogLevel) ? (level as LogLevel) : "info";
  write("renderer", resolved, text);
}

/**
 * Settings → 关于: pick a zip path, pack every file in `logs/`, reveal it.
 * Returns the destination, or `undefined` when the user cancels.
 */
export async function exportLogs(parent?: BrowserWindow | null): Promise<string | undefined> {
  if (!initialized) initLogger();
  const stamp = localStamp(new Date());
  const options = {
    title: uiText("导出日志", "Export logs"),
    defaultPath: join(app.getPath("downloads"), `fastvibe-logs-${stamp}.zip`),
    filters: [{ name: uiText("日志归档", "Log archive"), extensions: ["zip"] }],
  };
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return undefined;
  const dest = result.filePath.toLowerCase().endsWith(".zip") ? result.filePath : `${result.filePath}.zip`;
  const files = listLogFiles();
  if (files.length === 0) {
    throw new Error(uiText("没有可导出的日志", "No logs to export"));
  }
  writeZip(
    files.map((file) => ({
      name: file.name,
      data: readFileSync(file.path),
      mtime: file.mtime,
    })),
    dest,
  );
  log.info(`exported logs to ${dest}`);
  try {
    shell.showItemInFolder(dest);
  } catch {
    // Revealing is a convenience; the save itself already succeeded.
  }
  return dest;
}

function write(stream: Stream, level: LogLevel, message: string): void {
  if (!initialized || writing) return;
  const line = `${new Date().toISOString()} [${level}] ${redact(message).replace(/\r?\n/g, "\\n")}\n`;
  writing = true;
  try {
    const file = join(logsDir, `${stream}.log`);
    appendFileSync(file, line);
    bytes[stream] += Buffer.byteLength(line);
    if (bytes[stream] >= MAX_FILE_BYTES) rotate(stream);
  } catch {
    // A full disk must not take the app down with it.
  } finally {
    writing = false;
  }
}

function rotate(stream: Stream): void {
  const newest = join(logsDir, `${stream}.${ROTATED_FILES}.log`);
  try {
    unlinkSync(newest);
  } catch {
    // No oldest backup yet.
  }
  for (let index = ROTATED_FILES - 1; index >= 1; index -= 1) {
    try {
      renameSync(join(logsDir, `${stream}.${index}.log`), join(logsDir, `${stream}.${index + 1}.log`));
    } catch {
      // Gap in the chain; skip.
    }
  }
  try {
    renameSync(join(logsDir, `${stream}.log`), join(logsDir, `${stream}.1.log`));
  } catch {
    // Current file vanished between the append and the rotate.
  }
  bytes[stream] = 0;
}

function seedSize(stream: Stream): void {
  try {
    bytes[stream] = statSync(join(logsDir, `${stream}.log`)).size;
  } catch {
    bytes[stream] = 0;
  }
}

function hookConsole(): void {
  console.debug = (...args: unknown[]) => {
    consoleOriginals.debug(...args);
    write("main", "debug", formatArgs(args));
  };
  console.log = (...args: unknown[]) => {
    consoleOriginals.log(...args);
    write("main", "info", formatArgs(args));
  };
  console.info = (...args: unknown[]) => {
    consoleOriginals.info(...args);
    write("main", "info", formatArgs(args));
  };
  console.warn = (...args: unknown[]) => {
    consoleOriginals.warn(...args);
    write("main", "warn", formatArgs(args));
  };
  console.error = (...args: unknown[]) => {
    consoleOriginals.error(...args);
    write("main", "error", formatArgs(args));
  };
}

function hookProcess(): void {
  process.on("uncaughtException", (error) => {
    write("main", "error", joinMessage("uncaughtException", error));
  });
  process.on("unhandledRejection", (reason) => {
    write("main", "error", joinMessage("unhandledRejection", reason));
  });
  app.on("render-process-gone", (_event, contents, details) => {
    write(
      "main",
      "error",
      `render-process-gone reason=${details.reason} exitCode=${details.exitCode} url=${contents.getURL()}`,
    );
  });
  app.on("child-process-gone", (_event, details) => {
    write(
      "main",
      "error",
      `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name ?? details.serviceName ?? ""}`,
    );
  });
}

function startLine(): string {
  return [
    `FastVibe ${app.getVersion()} starting`,
    `platform=${process.platform}`,
    `arch=${process.arch}`,
    `electron=${process.versions.electron}`,
    `chrome=${process.versions.chrome}`,
    `node=${process.versions.node}`,
    `packaged=${app.isPackaged}`,
  ].join(" ");
}

function joinMessage(message: string, extra?: unknown): string {
  if (extra === undefined) return message;
  return `${message} ${formatArg(extra)}`;
}

function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(" ");
}

function formatArg(value: unknown): string {
  if (value instanceof Error) return value.stack?.trim() || `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Strip the obvious secret shapes so an exported zip is safe to share. */
function redact(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "sk-***")
    .replace(/\bBearer\s+[A-Za-z0-9._\-+=/]+/gi, "Bearer ***")
    .replace(/((?:api[_-]?key|secret|token|authorization)\s*[:=]\s*["']?)([^\s"',]+)/gi, "$1***");
}

function listLogFiles(): Array<{ name: string; path: string; mtime: Date }> {
  try {
    return readdirSync(logsDir).flatMap((name) => {
      const path = join(logsDir, name);
      try {
        const info = statSync(path);
        if (!info.isFile()) return [];
        return [{ name, path, mtime: info.mtime }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function localStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
  };
}

function writeZip(files: Array<{ name: string; data: Buffer; mtime: Date }>, dest: string): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.data);
    const crc = crc32(file.data) >>> 0;
    const { date, time } = dosDateTime(file.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(dest, Buffer.concat([...locals, centralDir, end]));
}
