import type { ToolCallBlock } from "@shared/types";

/** A file touched by one agent turn, with the lines it added and removed. */
export type ChangedFile = {
  path: string;
  added: number;
  removed: number;
  /**
   * The patch this turn actually wrote — `edit`'s structured diff, or a
   * synthesised add-only diff for `write`. Independent of the working tree, so a
   * later commit or a chip on an older turn still shows what *that* turn did.
   */
  diff?: string;
};

const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file", "target"];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolPath(tool: ToolCallBlock): string {
  const args = record(tool.args);
  if (!args) return "";
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isEditTool(name: string): boolean {
  return /^(edit|edit_file|editfile|apply_patch|applypatch|patch|str_replace|strreplace)$/i.test(name.trim());
}

function isWriteTool(name: string): boolean {
  return /^(write|write_file|writefile|create_file|createfile|create)$/i.test(name.trim());
}

/** Count `+` / `-` lines of a unified or pi-style patch, ignoring the file headers. */
export function countPatch(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function countContent(content: string): number {
  return content ? content.replace(/\n$/, "").split("\n").length : 0;
}

/** Prefer the engine's structured diff; `patch` is the same payload under another name. */
function toolDiff(tool: ToolCallBlock): string | undefined {
  const details = record(tool.details);
  if (typeof details?.diff === "string" && details.diff.trim()) return details.diff;
  if (typeof details?.patch === "string" && details.patch.trim()) return details.patch;
  return undefined;
}

/** A `write` with no patch is a new file: every line of the content is an addition. */
function addedDiff(content: string): string | undefined {
  if (!content) return undefined;
  return content
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
}

/**
 * Collect the files an assistant run wrote, from its `edit` patches and `write`
 * contents. The list is a fact about that turn's tools, not about `git diff HEAD`.
 */
export function collectChangedFiles(tools: ToolCallBlock[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  const add = (path: string, added: number, removed: number, diff?: string): void => {
    if (!path) return;
    const entry = files.get(path) ?? { path, added: 0, removed: 0 };
    entry.added += added;
    entry.removed += removed;
    if (diff) entry.diff = entry.diff ? `${entry.diff}\n${diff}` : diff;
    files.set(path, entry);
  };
  for (const tool of tools) {
    if (tool.status !== "done") continue;
    const path = toolPath(tool);
    const diff = toolDiff(tool);
    if (isEditTool(tool.name)) {
      if (!diff) continue;
      const { added, removed } = countPatch(diff);
      add(path, added, removed, diff);
    } else if (isWriteTool(tool.name)) {
      if (diff) {
        const { added, removed } = countPatch(diff);
        add(path, added, removed, diff);
      } else {
        const args = record(tool.args);
        const content = typeof args?.content === "string" ? args.content : "";
        add(path, countContent(content), 0, addedDiff(content));
      }
    }
  }
  return [...files.values()];
}
