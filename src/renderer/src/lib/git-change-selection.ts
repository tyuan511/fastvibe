import type { GitDiffSource, GitStatus } from "../../../shared/ipc.ts";
import { resolvePath } from "./workspace-path.ts";

export type GitChangeSelection = { file: GitStatus["files"][number]; source: GitDiffSource; revision?: string };
type Group = { id: string; source: GitDiffSource; files: GitStatus["files"] };

/** Preserve an open file across refresh/staging; otherwise start with a conflict or working change. */
export function selectGitChange(groups: Group[], current: GitChangeSelection | undefined, cwd: string, revision?: string): GitChangeSelection | undefined {
  const priority = (group: Group): number => group.id === "conflicts" ? 0 : group.source === "unstaged" ? 1 : 2;
  const ordered = [...groups].sort((a, b) => priority(a) - priority(b));
  if (current && current.revision === revision) {
    const matches = (path: string): boolean => path === current.file.path || (/^(?:[A-Za-z]:)?\//.test(current.file.path) && resolvePath(path, cwd) === current.file.path);
    const sameGroup = groups.find((group) => group.source === current.source && group.files.some((file) => matches(file.path)));
    const group = sameGroup ?? ordered.find((group) => group.files.some((file) => matches(file.path)));
    const file = group?.files.find((item) => matches(item.path));
    if (group && file) return file === current.file && group.source === current.source ? current : { file, source: group.source, revision };
  }
  const group = ordered.find((group) => group.files.length);
  return group ? { file: group.files[0], source: group.source, revision } : undefined;
}
