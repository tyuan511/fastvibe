import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { DirEntry } from "@shared/types";

/** Heavy directories the file tree never shows, even though the agent can touch them. */
const HIDDEN = new Set([".git", "node_modules"]);

/** One directory listing, directories first then files, alphabetical. */
export function readWorkspaceDir(dirPath: string): DirEntry[] {
  const entries: DirEntry[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (HIDDEN.has(entry.name)) continue;
    const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : null;
    // Symlinks, sockets and the like are skipped: the tree only previews real files.
    if (!kind) continue;
    entries.push({ name: entry.name, path: join(dirPath, entry.name), kind });
  }
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
  );
  return entries;
}
