import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PiEngineMode } from "../../shared/pi-engine.ts";
import { engineModeFile, writePrivateJson } from "./pi-engine-mode.ts";

const OMIT = new Set(["sessions", "backups", ".env", "oauth.json", "models-store.json", ".DS_Store"]);
const CONFIG = new Set(["models.json", "auth.json", "settings.json", "mcp.json"]);
const RESOURCES = new Set(["packages", "extensions", "skills", "prompts", "themes"]);

type Change = { target: string; staged: string; previous: string; existed: boolean };
type Journal = { version: 1; id: string; backupDir: string; changes: Change[]; mode: PiEngineMode };

export function readConfigObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid pi configuration: ${basename(file)}`);
  return parsed as Record<string, unknown>;
}

/** Source wins conflicts; target-only keys and package declarations survive. */
export function mergePiConfig(target: unknown, source: unknown, key = ""): unknown {
  if (Array.isArray(source) && Array.isArray(target) && RESOURCES.has(key)) {
    const identity = (item: unknown): string => {
      const value = item && typeof item === "object" && "source" in item ? (item as { source: unknown }).source : item;
      return JSON.stringify(value);
    };
    const claimed = new Set(source.map(identity));
    return [...source, ...target.filter((item) => !claimed.has(identity(item)))];
  }
  if (source && target && typeof source === "object" && typeof target === "object" && !Array.isArray(source) && !Array.isArray(target)) {
    const before = target as Record<string, unknown>;
    const next = source as Record<string, unknown>;
    return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(next)])].map((name) => [
      name, Object.hasOwn(next, name) ? mergePiConfig(before[name], next[name], name) : before[name],
    ]));
  }
  return source;
}

function relocated(path: string, from: string, to: string): string {
  const suffix = relative(from, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(suffix))
    ? join(to, suffix) : path;
}

function resourcePath(value: string, from: string, to: string): string {
  if (/^(?:npm:|git:|https?:|builtin:|~\/)/.test(value)) return value;
  const prefix = /^[!+-]/.test(value) ? value[0] : "";
  const path = prefix ? value.slice(1) : value;
  if (path.startsWith("builtin:")) return value;
  // Resolve local references against the original settings file, including ../ paths.
  return `${prefix}${relocated(resolve(from, path), from, to)}`;
}

export function relocatePiSettings(settings: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => {
    if (!RESOURCES.has(key) || !Array.isArray(value)) return [key, value];
    return [key, value.map((item: unknown) => {
      if (typeof item === "string") return resourcePath(item, from, to);
      if (key === "packages" && item && typeof item === "object" && "source" in item && typeof item.source === "string") {
        return { ...item, source: resourcePath(item.source, from, to) };
      }
      return item;
    })];
  }));
}

/** Never traverse destination links while merging. Package links inside the source move with it. */
function copyEntry(source: string, target: string, from: string, to: string): void {
  const stat = lstatSync(source);
  const existing = existsSync(target) || (() => { try { lstatSync(target); return true; } catch { return false; } })();
  if (stat.isDirectory()) {
    if (existing && !lstatSync(target).isDirectory()) rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true, mode: stat.mode & 0o777 });
    for (const name of readdirSync(source)) copyEntry(join(source, name), join(target, name), from, to);
    return;
  }
  if (existing) rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(source);
    const destination = relocated(resolve(dirname(source), link), from, to);
    const finalPath = relocated(target, from, to);
    // Absolute links are explicit; relative links remain relative after the directory moves.
    symlinkSync(isAbsolute(link) ? destination : relative(dirname(finalPath), destination), target, process.platform === "win32" ? "junction" : undefined);
  } else if (stat.isFile()) {
    cpSync(source, target);
  } else {
    throw new Error(`Unsupported pi resource: ${basename(source)}`);
  }
}

/** Prepare a complete merged copy without touching either live configuration. */
export function stagePiAgent(sourceDir: string, targetDir: string, stagedDir: string): string[] {
  mkdirSync(stagedDir, { recursive: true, mode: 0o700 });
  const names = new Set<string>();
  for (const [root, source] of [[targetDir, false], [sourceDir, true]] as const) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (OMIT.has(name) || name.startsWith(".fastvibe-")) continue;
      const entry = join(root, name);
      names.add(name);
      if (CONFIG.has(name)) {
        let value = readConfigObject(entry);
        if (name === "settings.json") value = relocatePiSettings(value, root, targetDir);
        const previous = readConfigObject(join(stagedDir, name));
        writePrivateJson(join(stagedDir, name), source ? mergePiConfig(previous, value) : value);
      } else {
        copyEntry(entry, join(stagedDir, name), root, targetDir);
      }
    }
  }
  return [...names];
}

const journalFile = (userData: string): string => join(userData, "engine-migration.json");

/**
 * Each replacement is a rename on the target volume. The mode marker is last. A crash
 * before that marker rolls the transaction back at the next startup, before any SDK opens.
 */
export function commitPiEngineMigration(options: {
  userData: string;
  mode: PiEngineMode;
  globalAgentDir: string;
  entries: Array<{ target: string; staged: string }>;
  beforeReplace?: (index: number) => void;
}): string {
  const id = randomUUID();
  const backupDir = join(options.userData, "engine-backups", id);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const markerStage = join(backupDir, "next-mode.json");
  writePrivateJson(markerStage, { version: 1, mode: options.mode, globalAgentDir: options.globalAgentDir, migrationId: id });
  const entries = [...options.entries, { target: engineModeFile(options.userData), staged: markerStage }];
  const changes: Change[] = [];
  try {
    for (const [index, entry] of entries.entries()) {
      mkdirSync(dirname(entry.target), { recursive: true, mode: 0o700 });
      const staged = join(dirname(entry.target), `.fastvibe-stage-${id}-${index}`);
      cpSync(entry.staged, staged, { recursive: true, dereference: false, verbatimSymlinks: true });
      const existed = (() => { try { lstatSync(entry.target); return true; } catch { return false; } })();
      if (existed) cpSync(entry.target, join(backupDir, String(index)), { recursive: true, dereference: false, verbatimSymlinks: true });
      changes.push({ target: entry.target, staged, previous: join(dirname(entry.target), `.fastvibe-before-${id}-${index}`), existed });
    }
    const journal: Journal = { version: 1, id, backupDir, changes, mode: options.mode };
    writePrivateJson(join(backupDir, "manifest.json"), journal);
    writePrivateJson(journalFile(options.userData), journal);
    for (const [index, change] of changes.entries()) {
      options.beforeReplace?.(index);
      if (change.existed) renameSync(change.target, change.previous);
      renameSync(change.staged, change.target);
    }
  } catch (error) {
    // Recovery knows whether a particular entry had already moved, even if its next rename failed.
    if (existsSync(journalFile(options.userData))) recoverPiEngineMigration(options.userData);
    else for (const change of changes) rmSync(change.staged, { recursive: true, force: true });
    throw error;
  }
  recoverPiEngineMigration(options.userData);
  return backupDir;
}

export function recoverPiEngineMigration(userData: string): void {
  const file = journalFile(userData);
  if (!existsSync(file)) return;
  const journal = JSON.parse(readFileSync(file, "utf8")) as Journal;
  if (journal.version !== 1 || !Array.isArray(journal.changes) || typeof journal.id !== "string") throw new Error("Invalid pi migration journal");
  const marker = readConfigObject(engineModeFile(userData));
  const committed = marker.migrationId === journal.id;
  for (const change of [...journal.changes].reverse()) {
    if (!committed && existsSync(change.previous)) {
      rmSync(change.target, { recursive: true, force: true });
      renameSync(change.previous, change.target);
    } else if (!committed && !change.existed && !existsSync(change.staged)) {
      rmSync(change.target, { recursive: true, force: true });
    }
    rmSync(change.staged, { recursive: true, force: true });
    if (committed) rmSync(change.previous, { recursive: true, force: true });
  }
  rmSync(file);
}
