import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DirEntry } from "@shared/types";
import { uiText } from "./ui-text.ts";

/** Heavy directories the file tree never shows, even though the agent can touch them. */
const HIDDEN = new Set([".git", "node_modules"]);

/** Largest file the pane will load or write back. Past this it stays a size-only preview. */
export const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;

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

/**
 * Replace a text file the file pane has open.
 *
 * The bytes land in a temp file in the same directory and are renamed over the
 * original, so a crash cannot leave a half-written source. A symlink is refused:
 * the tree only lists real files, and following a link would write somewhere other
 * than the path on screen. The editor only holds `\n`, so a file that was CRLF
 * gets that ending back — otherwise one save would rewrite every line.
 */
export function writeWorkspaceTextFile(filePath: unknown, text: unknown): void {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    throw new Error(uiText("路径无效", "Invalid path"));
  }
  if (typeof text !== "string") throw new Error(uiText("内容无效", "Invalid content"));
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(uiText("文件不存在", "File does not exist"));
    }
    throw error;
  }
  if (!stat.isFile()) throw new Error(uiText("只能修改普通文件", "Only a regular file can be edited"));
  if (stat.size > MAX_TEXT_FILE_BYTES) {
    throw new Error(uiText("文件过大，无法编辑", "File is too large to edit"));
  }
  const original = readFileSync(filePath);
  if (original.includes(0)) throw new Error(uiText("不能覆盖二进制文件", "Cannot overwrite a binary file"));
  const crlf = original.toString("utf8").includes("\r\n");
  const output = crlf && !text.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
  if (Buffer.byteLength(output) > MAX_TEXT_FILE_BYTES) {
    throw new Error(uiText("文件过大，无法编辑", "File is too large to edit"));
  }
  const temporary = join(dirname(filePath), `.fastvibe-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, output, { mode: stat.mode & 0o777 });
    const fd = openSync(temporary, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, stat.mode & 0o777);
    renameSync(temporary, filePath);
  } catch (error) {
    unlinkQuiet(temporary);
    throw error;
  }
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The original is untouched; a leftover temp is the lesser failure.
  }
}
