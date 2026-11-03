import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "../../shared/types.ts";
import { uiText } from "../engine/ui-text.ts";

/** Resolve both catalog project identity and actual cwd before creating the SDK session. */
export function resolveBotWorkspace(root: string, projects: Pick<Project, "cwd" | "kind">[], project?: string, workerKey?: string): { cwd: string; project?: string } {
  if (project !== undefined) {
    const selected = projects.find((item) => item.cwd === project && item.kind !== "remote");
    if (!selected) throw new Error(uiText("找不到指定的本地项目，请重新读取项目列表", "Local project not found; read the project list again"));
    try {
      if (statSync(selected.cwd).isDirectory()) return { cwd: realpathSync(selected.cwd), project: selected.cwd };
    } catch { /* Report the selected project instead of silently working elsewhere. */ }
    throw new Error(uiText("项目文件夹不存在或无法访问", "Project folder is missing or inaccessible"));
  }
  // Request IDs are arbitrary strings. Hash the stable creation key rather than
  // letting separators or traversal sequences become paths. Replays reuse the cwd.
  const cwd = workerKey === undefined
    ? join(root, "outputs")
    : join(root, "workspaces", createHash("sha256").update(workerKey).digest("hex"));
  mkdirSync(cwd, { recursive: true });
  return { cwd };
}
