import { configureFastVibeUserData, getFastVibePaths, type FastVibePaths } from "../main/engine/paths";
import { PiProcessManager } from "../main/pi/process-manager";

export type AgentRuntimeOptions = {
  /** Isolated data directory for this headless instance. */
  userData: string;
  /** Directory containing resources/extensions and resources/skills. */
  resourcesPath?: string;
};

export type AgentRuntime = {
  paths: FastVibePaths;
  engine: PiProcessManager;
};

/**
 * Create the same engine used by Electron Main without importing Electron.
 *
 * The process should create one runtime during boot. Path configuration is process-wide
 * because SDK extensions and the existing engine helpers share one isolated data root.
 */
export function createAgentRuntime(options: AgentRuntimeOptions): AgentRuntime {
  configureFastVibeUserData(options.userData);
  if (options.resourcesPath?.trim()) process.env.FASTVIBE_RESOURCES_PATH = options.resourcesPath.trim();
  const paths = getFastVibePaths();
  return { paths, engine: new PiProcessManager(paths) };
}
