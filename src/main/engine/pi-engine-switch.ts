import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PiEngineMode } from "../../shared/pi-engine.ts";
import { syncFastVibeConfigToPi } from "./sync-pi-config.ts";
import { importGlobalPiProviders } from "./global-pi-providers.ts";
import { readPiEngineState, writePrivateJson, writePiEngineMode } from "./pi-engine-mode.ts";
import type { FastVibePaths } from "./paths.ts";
import { readAppSettings, writeAppSettings } from "./app-settings.ts";
import { readMcpFile, writeMcpFile } from "./pi-engine-switch-mcp.ts";

const RESOURCE_DIRS = ["extensions", "skills", "prompts", "themes", "packages", "npm"] as const;

function copyMerge(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    cpSync(from, to, { recursive: true, dereference: false, force: true, verbatimSymlinks: true });
  }
}

function copyBackup(source: string, backup: string): void {
  if (!existsSync(source)) return;
  cpSync(source, backup, { recursive: true, dereference: false, verbatimSymlinks: true });
}

function readObject(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mergeSettingsFields(source: string, target: string): void {
  const from = readObject(source);
  const to = readObject(target);
  const next = { ...to };
  for (const key of ["packages", "extensions", "skills", "prompts", "themes", "defaultTools", "enableSkillCommands"] as const) {
    if (Object.hasOwn(from, key)) next[key] = from[key];
  }
  if (Object.keys(next).length > 0) writePrivateJson(target, next);
}

function targetPaths(paths: FastVibePaths, agentDir: string): FastVibePaths {
  return {
    ...paths,
    agentDir,
    skillsDir: join(agentDir, "skills"),
    modelsJson: join(agentDir, "models.json"),
    agentEnv: join(paths.isolatedAgentDir, ".env"),
    oauthFile: join(agentDir, "oauth.json"),
    providersFile: join(paths.userData, "providers.json"),
  };
}

/**
 * Move the configuration ownership between the two pi installations. The source is
 * retained, so switching back can always be performed without reconstructing it from
 * the current target. The target is backed up before any file changes.
 */
export async function switchPiEngine(paths: FastVibePaths, mode: PiEngineMode): Promise<{ mode: PiEngineMode; backupDir: string; globalAgentDir: string }> {
  const current = readPiEngineState(paths.userData);
  if (current.mode === mode) return { mode, backupDir: "", globalAgentDir: current.globalAgentDir };
  const source = current.agentDir;
  const target = mode === "global" ? current.globalAgentDir : current.isolatedAgentDir;
  const backupDir = join(paths.userData, "engine-backups", `${Date.now()}-${mode}`);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  copyBackup(target, join(backupDir, "target"));
  const appSettingsBefore = readAppSettings(paths);
  copyBackup(join(paths.userData, "mcp.json"), join(backupDir, "fastvibe-mcp.json"));

  try {
    if (mode === "global") {
      // Providers, auth, default model and MCP use pi's canonical file format.
      await syncFastVibeConfigToPi(paths, target, "merge");
      copyMerge(join(source, "extensions"), join(target, "extensions"));
      copyMerge(join(source, "skills"), join(target, "skills"));
      copyMerge(join(source, "prompts"), join(target, "prompts"));
      copyMerge(join(source, "themes"), join(target, "themes"));
      copyMerge(join(source, "npm"), join(target, "npm"));
      mergeSettingsFields(join(source, "settings.json"), join(target, "settings.json"));
    } else {
      const destination = targetPaths(paths, target);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      await importGlobalPiProviders(destination, source);
      const globalSettings = readObject(join(source, "settings.json"));
      const localSettings = readAppSettings(paths);
      const nextSettings = { ...localSettings };
      if (typeof globalSettings.defaultProvider === "string" && typeof globalSettings.defaultModel === "string") {
        nextSettings.defaultModel = { provider: globalSettings.defaultProvider, id: globalSettings.defaultModel };
      } else {
        delete nextSettings.defaultModel;
      }
      if (typeof globalSettings.defaultThinkingLevel === "string") nextSettings.thinkingLevel = globalSettings.defaultThinkingLevel;
      else delete nextSettings.thinkingLevel;
      writeAppSettings(paths, nextSettings);
      const mcp = readMcpFile(join(source, "mcp.json"));
      writeMcpFile(join(paths.userData, "mcp.json"), mcp);
      for (const name of RESOURCE_DIRS) copyMerge(join(source, name), join(target, name));
      mergeSettingsFields(join(source, "settings.json"), join(target, "settings.json"));
    }

    // The marker is the final operation. A failed migration leaves the old mode active;
    // the next launch therefore still uses the untouched source configuration.
    writePiEngineMode(paths.userData, mode, current.globalAgentDir);
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    copyBackup(join(backupDir, "target"), target);
    writeAppSettings(paths, appSettingsBefore);
    rmSync(join(paths.userData, "mcp.json"), { force: true });
    copyBackup(join(backupDir, "fastvibe-mcp.json"), join(paths.userData, "mcp.json"));
    throw error;
  }
  writePrivateJson(join(backupDir, "manifest.json"), { version: 1, mode, source, target });
  return { mode, backupDir, globalAgentDir: current.globalAgentDir };
}
