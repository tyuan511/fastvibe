import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { projectFolderPaths, type FolderResourceHints } from "../../shared/project-folders.ts";

/**
 * What the SDK finds by itself for a session's working directory — AGENTS.md / CLAUDE.md
 * up its ancestors, `.agents/skills` up to the repository root, `.pi/skills` — it does not
 * find for the *other* folders of a multi-folder project, because it only knows one cwd.
 *
 * Those are deliberately not loaded: every loaded file goes into every request, and most
 * turns never touch the other repositories. These helpers only find them, by the SDK's own
 * rules, so the folder snapshot can name the paths and the agent reads one when its work
 * reaches that folder.
 */

/** The SDK's own candidates, in its order: the first that exists in a directory wins. */
const CONTEXT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
/** A skill is listed by name; its description is only there to say when it applies. */
const DESCRIPTION_MAX = 160;

/**
 * The project's folders that are not where the session runs. A worktree chat runs in a
 * copy of the primary folder, so the primary is never "another" folder — its files are read
 * from the worktree by the SDK.
 */
export function additionalResourceFolders(
  project: { cwd: string; folders?: string[]; kind?: string } | undefined,
  sessionCwd: string,
): string[] {
  if (!project || project.kind === "remote") return [];
  const cwd = canonical(sessionCwd);
  return projectFolderPaths(project)
    .slice(1)
    .filter((folder) => canonical(folder) !== cwd);
}

/**
 * The instruction files and skills of `folder` that the session in `sessionCwd` does not load.
 * A directory on the session's own ancestor chain is skipped: the SDK has already loaded what
 * is there (a monorepo's root AGENTS.md seen from two packages).
 */
export function folderResourceHints(folder: string, sessionCwd: string): FolderResourceHints {
  const own = canonical(sessionCwd);
  const loaded = (dir: string): boolean => {
    const key = canonical(dir);
    return own === key || own.startsWith(key.endsWith(sep) ? key : key + sep);
  };
  const dirs = scopeDirs(folder).filter((dir) => !loaded(dir));
  const instructions = dirs.map(contextFileIn).filter((path): path is string => Boolean(path));
  const skills: FolderResourceHints["skills"] = [];
  const seen = new Set<string>();
  for (const dir of skillDirs(folder, dirs)) {
    for (const skill of loadSkillsFromDir({ dir, source: "project" }).skills) {
      const key = canonical(skill.filePath);
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push({ name: skill.name, description: oneLine(skill.description), path: skill.filePath });
    }
  }
  return { instructions, skills };
}

/**
 * A folder and its ancestors up to the repository that holds it, outermost first. A folder
 * outside any repository is only itself: walking to `/` from an additional folder would pull
 * in whatever a parent directory happens to carry, which the user never pointed us at.
 */
function scopeDirs(folder: string): string[] {
  const start = resolve(folder);
  const dirs: string[] = [];
  let dir = start;
  while (true) {
    dirs.unshift(dir);
    if (existsSync(join(dir, ".git"))) return dirs;
    const parent = dirname(dir);
    if (parent === dir) return [start];
    dir = parent;
  }
}

function contextFileIn(dir: string): string | undefined {
  for (const name of CONTEXT_FILE_NAMES) {
    const path = join(dir, name);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Missing: the next candidate, as the SDK does.
    }
  }
  return undefined;
}

/** `.agents/skills` in each directory of the scope, then the folder's `.pi/skills`. */
function skillDirs(folder: string, scope: readonly string[]): string[] {
  const user = canonical(join(homedir(), ".agents", "skills"));
  const candidates = [...scope.map((dir) => join(dir, ".agents", "skills")), join(folder, ".pi", "skills")];
  return candidates.filter((dir) => {
    if (canonical(dir) === user) return false;
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_MAX ? `${flat.slice(0, DESCRIPTION_MAX - 1)}…` : flat;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
