import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { IPty } from "node-pty";
import { uiText } from "./ui-text.ts";

type Session = {
  id: string;
  cwd: string;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
};

/**
 * Zip extract / asar unpack often drops +x on node-pty's spawn-helper. node-pty
 * already rewrites `app.asar` → `app.asar.unpacked` when it execs the helper;
 * chmod must target that same real path, not the asar virtual one.
 */
function unpackAsarPath(filePath: string): string {
  return filePath
    .replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked")
    .replace(/node_modules\.asar(?!\.unpacked)/, "node_modules.asar.unpacked");
}

function ensureSpawnHelper(ptyEntry: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(
      unpackAsarPath(join(dirname(ptyEntry), "../prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")),
      0o755,
    );
  } catch {
    // read-only install (a mounted DMG, etc.)
  }
}

/**
 * The native pty, resolved on the first shell rather than at import — for two reasons:
 * an install that never opens a terminal does not pay for loading it, and a load failure
 * can be reported from `start()`, the only place that knows a terminal was asked for.
 * This module cannot use the file logger (that imports Electron, and the headless Agent
 * runs this same file), so `console.warn` is the channel: Main hooks it into
 * `logs/main.log`.
 */
let pty: { module: typeof import("node-pty"); entry: string } | null | undefined;
let ptyError: unknown;
let warnedNoPty = false;

function loadPty(): { module: typeof import("node-pty"); entry: string } | null {
  if (pty !== undefined) return pty;
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("node-pty");
    ensureSpawnHelper(entry);
    pty = { module: require("node-pty") as typeof import("node-pty"), entry };
  } catch (error) {
    ptyError = error;
    pty = null;
  }
  return pty;
}

/**
 * Say why this shell got no pty, once. The fallback is not equivalent — it cannot resize
 * the pty, so output wraps at whatever size the shell started with — and without this
 * line a garbled (or absent) terminal has no explanation anywhere. `reason` is either the
 * module's load failure or, when it did load, the failed spawn.
 */
function warnNoPty(reason: unknown): void {
  if (warnedNoPty) return;
  warnedNoPty = true;
  const outcome =
    process.platform === "win32" || process.platform === "linux"
      ? "using a plain child process, which cannot resize the pty"
      : "no terminal can start";
  console.warn(`[terminal] no pty for this shell, ${outcome}: ${String(reason)}`);
}

/**
 * Decode a fallback shell's output as one UTF-8 stream.
 *
 * `chunk.toString("utf8")` per chunk turns a character split across two reads into two
 * U+FFFD, and a pty hands over whatever fits its buffer, so a 3-byte CJK character is
 * split routinely under load. `StringDecoder` holds the incomplete tail for the next
 * chunk. stdout and stderr share one decoder: in the `script` fallback they are two ends
 * of the same pty, so their bytes are already in a single order.
 */
export function createChunkDecoder(): (chunk: Buffer) => string {
  const decoder = new StringDecoder("utf8");
  return (chunk) => decoder.write(chunk);
}

/** One frame of coalescing for terminal output, and the burst size that skips it. */
const FLUSH_MS = 16;
const MAX_PENDING_CHARS = 256 * 1024;

/** Side-pane shells. Prefer node-pty; unix `script` is a last-resort PTY on Linux only. */
export class TerminalSessions {
  #sessions = new Map<string, Session>();
  #listeners = new Set<(event: { id: string; data?: string; exited?: boolean }) => void>();
  /** Output waiting to be pushed, per terminal, in arrival order. */
  #pending = new Map<string, string>();
  #flushTimer: NodeJS.Timeout | null = null;

  onData(listener: (event: { id: string; data?: string; exited?: boolean }) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(cwd: string, size?: { cols?: number; rows?: number }): { id: string; cwd: string } {
    const id = randomUUID();
    const cols = size?.cols && size.cols > 1 ? size.cols : 80;
    const rows = size?.rows && size.rows > 1 ? size.rows : 24;
    const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/zsh");
    if (loadPty()) {
      try {
        ensureSpawnHelper(pty!.entry);
        const session = this.#startPty(id, cwd, shell, cols, rows);
        this.#sessions.set(id, session);
        return { id, cwd };
      } catch (error) {
        // The module is there but the spawn is not (a spawn-helper with no +x, a cwd
        // that vanished). Say which, or the reason below reads "undefined".
        ptyError = error;
      }
    }
    warnNoPty(ptyError);
    if (process.platform === "win32" || process.platform === "linux") {
      this.#sessions.set(id, this.#startScript(id, cwd, shell));
      return { id, cwd };
    }
    this.#sessions.set(id, this.#startFailed(id, cwd));
    return { id, cwd };
  }

  write(id: string, data: string): void {
    this.#sessions.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 1) return;
    this.#sessions.get(id)?.resize(cols, rows);
  }

  kill(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    session.kill();
    this.#sessions.delete(id);
  }

  dispose(): void {
    for (const id of [...this.#sessions.keys()]) this.kill(id);
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    // Output of shells that are being torn down has nowhere left to go.
    this.#pending.clear();
  }

  #startPty(id: string, cwd: string, shell: string, cols: number, rows: number): Session {
    const term: IPty = pty!.module.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    term.onData((data) => this.#data(id, data));
    term.onExit(() => {
      this.#sessions.delete(id);
      this.#emit({ id, exited: true });
    });
    return {
      id,
      cwd,
      write: (data) => term.write(data),
      resize: (nextCols, nextRows) => term.resize(nextCols, nextRows),
      kill: () => term.kill(),
    };
  }

  #startScript(id: string, cwd: string, shell: string): Session {
    const child: ChildProcessWithoutNullStreams =
      process.platform === "win32"
        ? spawnProcess(shell, [], { cwd, env: process.env, windowsHide: true })
        : spawnProcess("script", ["-qfc", `${shell} -i`, "/dev/null"], {
            cwd,
            env: { ...process.env, TERM: "xterm-256color" },
          });
    const decode = createChunkDecoder();
    child.stdout.on("data", (chunk: Buffer) => {
      const text = decode(chunk);
      if (text) this.#data(id, text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = decode(chunk);
      if (text) this.#data(id, text);
    });
    child.on("close", () => {
      this.#sessions.delete(id);
      this.#emit({ id, exited: true });
    });
    child.on("error", (error) => {
      this.#data(id, `\r\n${error.message}\r\n`);
      this.#sessions.delete(id);
      this.#emit({ id, exited: true });
    });
    return {
      id,
      cwd,
      write: (data) => {
        if (!child.killed) child.stdin.write(data);
      },
      resize: () => undefined,
      kill: () => child.kill(),
    };
  }

  /**
   * macOS `script` calls tcgetattr on a pipe and dies with "Operation not
   * supported on socket". If node-pty cannot spawn, surface that instead of
   * pretending the fallback worked.
   */
  #startFailed(id: string, cwd: string): Session {
    const message = uiText("无法启动终端", "Failed to start terminal");
    setImmediate(() => {
      this.#data(id, `\r\n${message}\r\n`);
      this.#sessions.delete(id);
      this.#emit({ id, exited: true });
    });
    return {
      id,
      cwd,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
    };
  }

  /**
   * Take one chunk of output, to be pushed with the rest of this frame's.
   *
   * A shell emits output in whatever pieces the pty hands over — a build log is
   * thousands of them a second — and each one used to cross the IPC boundary on its
   * own, to every window and every remote client. Coalescing costs one frame of
   * latency (imperceptible next to a shell's own echo) and collapses that burst into
   * one push per terminal per frame.
   */
  #data(id: string, chunk: string): void {
    const buffered = `${this.#pending.get(id) ?? ""}${chunk}`;
    this.#pending.set(id, buffered);
    // A burst bigger than a frame's worth goes out immediately rather than growing a
    // string nobody has read yet.
    if (buffered.length >= MAX_PENDING_CHARS) {
      this.#flush(id);
      return;
    }
    if (this.#flushTimer !== null) return;
    const timer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flush();
    }, FLUSH_MS);
    timer.unref?.();
    this.#flushTimer = timer;
  }

  /** Push what one terminal — or every terminal — has buffered. */
  #flush(id?: string): void {
    if (id !== undefined) {
      const data = this.#pending.get(id);
      if (data === undefined) return;
      this.#pending.delete(id);
      this.#emit({ id, data });
      return;
    }
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const [key, data] of pending) this.#emit({ id: key, data });
  }

  #emit(event: { id: string; data?: string; exited?: boolean }): void {
    // A control event never overtakes output: whatever this terminal has buffered is
    // pushed first, so 「已结束」 cannot land ahead of the last lines the shell printed.
    if (event.data === undefined) this.#flush(event.id);
    for (const listener of this.#listeners) listener(event);
  }
}
