/**
 * A project can own several folders. `cwd` stays the primary folder and the
 * project's identity; `folders` holds the rest, in order.
 *
 * This module is imported by the renderer, so it does not use `node:path`.
 */

export type FolderPromptInfo = {
  path: string;
  primary: boolean;
  repository: boolean;
  branch?: string;
};

export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed) || path;
}

/** Drop blanks, the primary path, and duplicates. Absent when nothing remains. */
export function extraFolders(cwd: string, folders: unknown): string[] | undefined {
  if (!Array.isArray(folders)) return undefined;
  const seen = new Set<string>([cwd]);
  const out: string[] = [];
  for (const item of folders) {
    if (typeof item !== "string") continue;
    const path = item.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out.length > 0 ? out : undefined;
}

/** Primary first, then the additional folders. */
export function projectFolderPaths(project: { cwd: string; folders?: string[] }): string[] {
  return [project.cwd, ...(extraFolders(project.cwd, project.folders) ?? [])];
}

function normalized(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * A path inside the working directory stays relative to it. A path inside another
 * project folder is prefixed with that folder's name, so two `README.md` files
 * from different repositories can be told apart.
 */
export function displayProjectPath(path: string, cwd: string | undefined, folders: string[]): string {
  const file = normalized(path);
  if (cwd) {
    const root = normalized(cwd);
    if (file === root) return folderName(cwd);
    if (file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  }
  const matches = folders
    .map((root) => ({ root, name: folderName(root), normalized: normalized(root) }))
    .filter((item) => file === item.normalized || file.startsWith(`${item.normalized}/`))
    .sort((a, b) => b.normalized.length - a.normalized.length);
  const hit = matches[0];
  if (!hit) return path;
  if (file === hit.normalized) return hit.name;
  return `${hit.name}/${file.slice(hit.normalized.length + 1)}`;
}

/**
 * Appended to the system prompt only when the project has more than one folder.
 * A single-folder project must read exactly as it does today.
 */
export function buildProjectFoldersPrompt(
  cwd: string,
  folders: FolderPromptInfo[],
  options?: { worktree?: boolean },
): string | undefined {
  if (folders.length < 2) return undefined;
  const lines = [
    "This project includes more than one folder. You may read and modify every folder listed below. Use absolute paths for anything outside the current working directory. Folders can belong to different git repositories; commit inside the repository that owns the files.",
    `Current working directory: ${cwd}`,
    "Folders:",
  ];
  for (const folder of folders) {
    const role = folder.path === cwd ? "working directory" : folder.primary ? "primary folder" : "additional folder";
    const git = folder.repository
      ? `git repository${folder.branch ? `, branch ${folder.branch}` : ""}`
      : "not a git repository";
    lines.push(`- ${folder.path} (${role}; ${git})`);
  }
  if (options?.worktree) {
    lines.push("This chat is isolated in a worktree of the working directory only. The other folders are the real directories.");
  }
  return lines.join("\n");
}

/** Move settings keyed by the project path when the primary folder changes. */
export function rekeyProjectSettings<T extends Record<string, unknown>>(settings: T, from: string, to: string): T {
  if (!from || !to || from === to) return settings;
  const next = { ...settings } as T;
  const defaults = next.projectDefaults;
  if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
    const map = { ...(defaults as Record<string, unknown>) };
    if (Object.prototype.hasOwnProperty.call(map, from) && !Object.prototype.hasOwnProperty.call(map, to)) {
      map[to] = map[from];
    }
    delete map[from];
    (next as Record<string, unknown>).projectDefaults = map;
  }
  for (const key of ["sidebarCollapsedProjects", "sidebarExpandedProjects"]) {
    const list = (next as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    (next as Record<string, unknown>)[key] = list.map((item) => (item === from ? to : item));
  }
  return next;
}
