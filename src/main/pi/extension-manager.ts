import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionPackage } from "@shared/types";

/**
 * FastVibe's own extensions. They are plain files shipped outside the asar
 * archive (`resources/extensions`, copied to `resourcesPath/extensions`) and
 * loaded through the SDK's jiti loader, so `/plan` and `/goal` work on a fresh
 * install with no network and no npm package.
 */
export const BUILTIN_EXTENSIONS: Array<{ source: string; file: string }> = [
  { source: "fastvibe:plan", file: "plan.ts" },
  { source: "fastvibe:goal", file: "goal.ts" },
  { source: "fastvibe:permission-sandbox", file: "permission-sandbox.ts" },
];

/** Absolute paths to the built-in extension entry points. */
export function builtinExtensionPaths(): string[] {
  const dir = app.isPackaged
    ? join(process.resourcesPath, "extensions")
    : join(__dirname, "../../resources/extensions");
  const paths = BUILTIN_EXTENSIONS.map((item) => join(dir, item.file));
  return paths.filter((path) => existsSync(path));
}

/**
 * Extra pi packages the user installed at runtime, backed by the SDK's own
 * `DefaultPackageManager`. Installs land in FastVibe's isolated agentDir (its
 * `settings.json` + `npm/`), never in the user's `~/.pi`.
 *
 * Bundled extensions are reported alongside them so Settings can show them, but
 * they are managed by `package.json` and cannot be removed from the UI.
 */
export class ExtensionManager {
  #manager: DefaultPackageManager;

  constructor(agentDir: string, cwd: string) {
    this.#manager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
    });
  }

  list(): ExtensionPackage[] {
    const bundled: ExtensionPackage[] = BUILTIN_EXTENSIONS.map((item) => ({
      source: item.source,
      scope: "user",
      builtin: true,
    }));
    const installed: ExtensionPackage[] = this.#manager.listConfiguredPackages().map((item) => ({
      source: item.source,
      scope: item.scope,
      installedPath: item.installedPath,
      builtin: false,
    }));
    return [...bundled, ...installed];
  }

  async install(source: string): Promise<ExtensionPackage[]> {
    const trimmed = source.trim();
    if (!trimmed) throw new Error("请输入包名，例如 npm:pi-web-access");
    await this.#manager.installAndPersist(trimmed);
    return this.list();
  }

  async remove(source: string): Promise<ExtensionPackage[]> {
    await this.#manager.removeAndPersist(source);
    return this.list();
  }
}
