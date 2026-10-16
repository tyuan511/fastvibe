import type { GitStatus } from "../../../shared/ipc.ts";

export type GitDecoration = {
  badge: string;
  tone: string;
  label: `git.${string}`;
  priority: number;
};

const MODIFIED: GitDecoration = { badge: "M", tone: "text-warning", label: "git.modified", priority: 4 };
const DECORATIONS: Record<string, GitDecoration> = {
  M: MODIFIED,
  T: { ...MODIFIED, badge: "T", label: "git.typeChange" },
  A: { badge: "A", tone: "text-success", label: "git.added", priority: 1 },
  "?": { badge: "U", tone: "text-success", label: "git.untracked", priority: 1 },
  D: { badge: "D", tone: "text-destructive", label: "git.deleted", priority: 3 },
  U: { badge: "!", tone: "text-destructive", label: "git.conflict", priority: 5 },
  R: { badge: "R", tone: "text-info", label: "git.renamed", priority: 2 },
  C: { badge: "C", tone: "text-info", label: "git.copied", priority: 2 },
};

function decoration(file: GitStatus["files"][number]): GitDecoration | undefined {
  const xy = file.index + file.worktree;
  // DD and AA are conflicts too, despite having no U in either column.
  if (xy.includes("U") || xy === "AA" || xy === "DD") return DECORATIONS.U;
  if (xy === "??") return DECORATIONS["?"];
  return DECORATIONS[file.worktree.trim() || file.index.trim()];
}

/** Index once per status read; looking up each lazily expanded row is then O(1). */
export function fileTreeGit(status: GitStatus | null): {
  files: Map<string, GitDecoration>;
  directories: Map<string, GitDecoration>;
} {
  const files = new Map<string, GitDecoration>();
  const directories = new Map<string, GitDecoration>();
  if (!status?.isRepository) return { files, directories };
  for (const file of status.files) {
    const value = decoration(file);
    const path = file.path;
    // Short status also lists changes outside cwd when it is a repository subfolder.
    if (!value || path.startsWith("../") || path.startsWith("/")) continue;
    files.set(path, value);
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const dir = path.slice(0, slash);
      const previous = directories.get(dir);
      if (!previous || value.priority > previous.priority) directories.set(dir, value);
      slash = path.lastIndexOf("/", slash - 1);
    }
  }
  return { files, directories };
}
