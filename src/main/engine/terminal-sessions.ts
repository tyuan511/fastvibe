import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import { uiText } from "./ui-text";

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

function loadPty(): { module: typeof import("node-pty"); entry: string } | null {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("node-pty");
    ensureSpawnHelper(entry);
    return { module: require("node-pty") as typeof import("node-pty"), entry };
  } catch {
    return null;
  }
}

const pty = loadPty();

/** Side-pane shells. Prefer node-pty; unix `script` is a last-resort PTY on Linux only. */
export class TerminalSessions {
  #sessions = new Map<string, Session>();
  #listeners = new Set<(event: { id: string; data?: string; exited?: boolean }) => void>();

  onData(listener: (event: { id: string; data?: string; exited?: boolean }) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(cwd: string, size?: { cols?: number; rows?: number }): { id: string; cwd: string } {
    const id = randomUUID();
    const cols = size?.cols && size.cols > 1 ? size.cols : 80;
    const rows = size?.rows && size.rows > 1 ? size.rows : 24;
    const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/zsh");
    if (pty) {
      try {
        ensureSpawnHelper(pty.entry);
        const session = this.#startPty(id, cwd, shell, cols, rows);
        this.#sessions.set(id, session);
        return { id, cwd };
      } catch {
        // fall through
      }
    }
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
  }

  #startPty(id: string, cwd: string, shell: string, cols: number, rows: number): Session {
    const term: IPty = pty!.module.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    });
    term.onData((data) => this.#emit({ id, data }));
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
    child.stdout.on("data", (chunk: Buffer) => this.#emit({ id, data: chunk.toString("utf8") }));
    child.stderr.on("data", (chunk: Buffer) => this.#emit({ id, data: chunk.toString("utf8") }));
    child.on("close", () => {
      this.#sessions.delete(id);
      this.#emit({ id, exited: true });
    });
    child.on("error", (error) => {
      this.#emit({ id, data: `\r\n${error.message}\r\n` });
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
      this.#emit({ id, data: `\r\n${message}\r\n` });
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

  #emit(event: { id: string; data?: string; exited?: boolean }): void {
    for (const listener of this.#listeners) listener(event);
  }
}
