import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PiEngineMode, PiEngineState } from "../../shared/pi-engine.ts";

// Capture before the host assigns PI_CODING_AGENT_DIR to its active runtime.
const inheritedAgentDir = process.env.PI_CODING_AGENT_DIR;

export function isolatedPiAgentDir(userData: string): string {
  return join(userData, "runtime", "engine", "agent");
}

export function engineModeFile(userData: string): string {
  return join(userData, "engine-mode.json");
}

export function resolveGlobalPiAgentDir(userData: string, configured = inheritedAgentDir): string {
  const expanded = configured?.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  const candidate = expanded?.trim() ? resolve(expanded) : join(homedir(), ".pi", "agent");
  // A child of FastVibe can inherit its parent's isolated runtime marker.
  return candidate === resolve(isolatedPiAgentDir(userData)) ? join(homedir(), ".pi", "agent") : candidate;
}

export function readPiEngineState(userData: string): PiEngineState {
  let mode: PiEngineMode = "isolated";
  let globalAgentDir = resolveGlobalPiAgentDir(userData);
  const file = engineModeFile(userData);
  if (existsSync(file)) {
    // A damaged mode file must not silently boot the other engine and later overwrite it.
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (saved.version !== 1 || (saved.mode !== "global" && saved.mode !== "isolated")) {
      throw new Error("Invalid pi engine configuration");
    }
    mode = saved.mode;
    if (typeof saved.globalAgentDir === "string" && isAbsolute(saved.globalAgentDir)) globalAgentDir = saved.globalAgentDir;
  }
  const isolatedAgentDir = isolatedPiAgentDir(userData);
  assertSeparateAgentDirs(isolatedAgentDir, globalAgentDir);
  return { mode, globalAgentDir, isolatedAgentDir, agentDir: mode === "global" ? globalAgentDir : isolatedAgentDir };
}

/** Resolve existing ancestors too, so a symlink cannot make the two modes share files. */
function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), relative(parent, absolute));
}

export function assertSeparateAgentDirs(isolated: string, global: string): void {
  const own = canonical(isolated);
  const shared = canonical(global);
  for (const [parent, child] of [[own, shared], [shared, own]]) {
    const suffix = relative(parent, child);
    if (!suffix || (!suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && suffix !== ".." && !isAbsolute(suffix))) {
      throw new Error("The global and isolated pi directories must be separate");
    }
  }
}

export function writePiEngineMode(userData: string, mode: PiEngineMode, globalAgentDir: string): void {
  writePrivateJson(engineModeFile(userData), { version: 1, mode, globalAgentDir });
}

export function writePrivateJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
