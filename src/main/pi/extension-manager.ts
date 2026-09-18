import { existsSync } from "node:fs";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionPackage } from "@shared/types";
import { uiText } from "../engine/ui-text";

/**
 * FastVibe's own extensions. They are plain files shipped outside the asar
 * archive (`resources/extensions`, copied to `resourcesPath/extensions`) and
 * loaded through the SDK's jiti loader, so `/plan`, `/goal`, the todo tool,
 * web search and auto session titles work on a fresh install with no network and no npm package.
 */
export const BUILTIN_EXTENSIONS: Array<{ source: string; file: string }> = [
  { source: "fastvibe:plan", file: "plan.ts" },
  { source: "fastvibe:goal", file: "goal.ts" },
  { source: "fastvibe:todo", file: "todo.ts" },
  { source: "fastvibe:output-language", file: "output-language.ts" },
  { source: "fastvibe:permission-sandbox", file: "permission-sandbox.ts" },
  { source: "fastvibe:session-title", file: "session-title.ts" },
  { source: "fastvibe:browser-use", file: "browser-use.ts" },
  { source: "fastvibe:web-search", file: "web-search.ts" },
  { source: "fastvibe:subagent-team", file: "subagent/index.ts" },
];

/** Roles available to the built-in team orchestrator. Kept data-only so the
 * renderer and future schedulers can advertise capabilities without loading an
 * extension or starting a process. */
export const BUILTIN_AGENTS = [
  { id: "scout", name: "Scout", description: "Quickly locate files, entry points and dependencies; hand off structured context.", tools: ["read", "grep", "find", "ls"] },
  { id: "planner", name: "Planner", description: "Break a request into executable steps, risks and verification.", tools: ["read", "grep", "find", "ls"] },
  { id: "worker", name: "Worker", description: "Make the code changes in an isolated context and run verification.", tools: ["read", "grep", "find", "ls", "edit", "write", "bash"] },
  { id: "reviewer", name: "Reviewer", description: "Check the implementation, regression risk and test coverage; give actionable feedback.", tools: ["read", "grep", "find", "ls", "bash"] },
] as const;

function resourcesRoot(): string {
  return process.env.FASTVIBE_RESOURCES_PATH?.trim() || join(__dirname, "../../resources");
}

export function builtinSkillPaths(): string[] {
  const dir = join(resourcesRoot(), "skills");
  const path = join(dir, "browser-use", "SKILL.md");
  return existsSync(path) ? [path] : [];
}

/** Directory holding FastVibe's built-in extension entry points (outside the asar). */
function extensionsDir(): string {
  return join(resourcesRoot(), "extensions");
}

/** Absolute path to one built-in extension entry point, or null when absent. */
export function builtinExtensionFile(file: string): string | null {
  const path = join(extensionsDir(), file);
  return existsSync(path) ? path : null;
}

/** Absolute paths to the built-in extension entry points. */
export function builtinExtensionPaths(): string[] {
  const paths = BUILTIN_EXTENSIONS.map((item) => join(extensionsDir(), item.file));
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
    if (!trimmed) throw new Error(uiText("请输入包名，例如 npm:pi-web-access", "Enter a package name, e.g. npm:pi-web-access"));
    await this.#manager.installAndPersist(trimmed);
    return this.list();
  }

  async remove(source: string): Promise<ExtensionPackage[]> {
    await this.#manager.removeAndPersist(source);
    return this.list();
  }
}
