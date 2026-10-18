import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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

/**
 * The file tree's create / rename / delete operations.
 *
 * Every one of them is addressed by a project root (`cwd`) plus the path the row shows,
 * and the root is not decoration: it is what bounds the operation. The renderer can only
 * ever name a row it read out of that tree, so a path outside the project means a crafted
 * call, and refusing it costs nothing. Without the bound these three methods would be a
 * wider lever than `workspace:write-file` already is — that one edits a file the pane has
 * open, these remove a directory tree.
 *
 * Deleting is the irreversible one, so the desktop hands in a `trash` function (Electron's
 * `shell.trashItem`) and the file leaves for the system Trash rather than vanishing. A
 * headless Agent has no Trash, so it deletes for good and the client is expected to say so.
 */

/** Longest name the filesystems we care about agree on, in bytes (APFS/ext4 are 255). */
const MAX_NAME_BYTES = 255;

/**
 * One path segment, the way a name field typed it.
 *
 * A separator is refused rather than split: `a/b` in a rename box would move a file across
 * the tree while its row still says it sits where it did. Control characters and a bare
 * dot are refused for the same reason — they name nothing the reader can see.
 */
export function workspaceEntryName(name: unknown): string {
  if (typeof name !== "string") throw new Error(uiText("名称无效", "Invalid name"));
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error(uiText("请输入名称", "Enter a name"));
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || /[\u0000-\u001f]/.test(trimmed)) {
    throw new Error(uiText("名称不能包含路径分隔符", "A name cannot contain a path separator"));
  }
  if (Buffer.byteLength(trimmed, "utf8") > MAX_NAME_BYTES) {
    throw new Error(uiText("名称太长", "The name is too long"));
  }
  return trimmed;
}

/** The project root an operation is bounded by: at or below it, never elsewhere. */
function withinRoot(cwd: unknown, path: string): boolean {
  if (typeof cwd !== "string" || !cwd) return false;
  const root = resolve(cwd);
  const target = resolve(path);
  return target === root || target.startsWith(root + sep);
}

/** Strictly below the root — the project directory itself is never a row to rename or delete. */
function belowRoot(cwd: unknown, path: string): boolean {
  if (typeof cwd !== "string" || !cwd) return false;
  return resolve(path).startsWith(resolve(cwd) + sep);
}

/**
 * Refuse to operate on the repository itself.
 *
 * The tree never lists `.git`, so no honest click reaches this — which is exactly why it is
 * cheap to guard the one path where a crafted call would destroy history rather than a file.
 * Every segment below the project counts, not just the last one: `<cwd>/.git/objects` is as
 * much the repository as `<cwd>/.git`, and on the case-insensitive volumes macOS and Windows
 * default to, `.GIT` reaches the same directory.
 */
function assertNotRepository(cwd: string, path: string): void {
  const segments = relative(resolve(cwd), resolve(path)).split(sep);
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    throw new Error(uiText("不能操作 Git 仓库数据", "The Git repository cannot be changed here"));
  }
}

/**
 * The directory the operation happens in, checked after resolving symlinks.
 *
 * `withinRoot` is lexical, so a linked folder inside the project would let a crafted call
 * write through it to somewhere the tree never showed. The entry itself is deliberately not
 * resolved: a symlink row is deleted as the link, and resolving it would refuse exactly that.
 */
function assertParentInsideProject(cwd: string, parent: string): void {
  let rootReal: string;
  let parentReal: string;
  try {
    rootReal = realpathSync(resolve(cwd));
    parentReal = realpathSync(parent);
  } catch {
    throw new Error(uiText("路径不存在", "That path does not exist"));
  }
  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    throw new Error(uiText("只能操作项目目录内的文件", "Only files inside the project can be changed"));
  }
}

/** A real directory inside the project (the project directory itself counts) that rows can be created in. */
function directoryInside(cwd: unknown, path: unknown): string {
  if (typeof path !== "string" || !path) throw new Error(uiText("路径无效", "Invalid path"));
  if (typeof cwd !== "string" || !cwd) throw new Error(uiText("未绑定项目", "No project is bound"));
  if (!withinRoot(cwd, path)) throw new Error(uiText("只能操作项目目录内的文件", "Only files inside the project can be changed"));
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(uiText("路径不存在", "That path does not exist"));
  }
  if (!stat.isDirectory()) {
    throw new Error(uiText("只能在文件夹中新建", "Only a folder can hold a new item"));
  }
  assertNotRepository(cwd, path);
  assertParentInsideProject(cwd, path);
  return path;
}

/** The entry a rename or delete names: inside the project, existing, not the project itself. */
function entryInside(cwd: unknown, path: unknown): { path: string; kind: DirEntry["kind"]; symlink: boolean } {
  if (typeof path !== "string" || !path) throw new Error(uiText("路径无效", "Invalid path"));
  if (typeof cwd !== "string" || !cwd) throw new Error(uiText("未绑定项目", "No project is bound"));
  if (!belowRoot(cwd, path)) throw new Error(uiText("只能操作项目目录内的文件", "Only files inside the project can be changed"));
  assertNotRepository(cwd, path);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(uiText("文件不存在", "File does not exist"));
  }
  const symlink = stat.isSymbolicLink();
  // A symlink is the link itself, never what it points at: the row on screen is the link, and
  // following it would reach outside the project the call is bound to.
  const kind: DirEntry["kind"] = !symlink && stat.isDirectory() ? "directory" : "file";
  assertParentInsideProject(cwd, dirname(path));
  return { path, kind, symlink };
}

/** Create an empty file or a directory under `path` (a directory), returning what the tree should show. */
export function createWorkspaceEntry(input: { cwd?: unknown; path?: unknown; name?: unknown; kind?: unknown }): DirEntry {
  const parent = directoryInside(input.cwd, input.path);
  const name = workspaceEntryName(input.name);
  const kind = input.kind === "directory" ? "directory" : "file";
  const target = join(parent, name);
  if (existsSync(target)) throw new Error(uiText("已存在同名项", "An item with that name already exists"));
  if (kind === "directory") mkdirSync(target);
  else writeFileSync(target, "", { flag: "wx" });
  return { name, path: target, kind };
}

/**
 * Rename the entry at `path` to `name`, staying in its own directory.
 *
 * Only the last segment changes: a rename box that could move a file would need the tree to
 * show a destination, and the row it lands on is the one the reader meant to keep.
 */
export function renameWorkspaceEntry(input: { cwd?: unknown; path?: unknown; name?: unknown }): DirEntry {
  const entry = entryInside(input.cwd, input.path);
  const name = workspaceEntryName(input.name);
  const target = join(dirname(entry.path), name);
  if (target === entry.path) return { name, path: entry.path, kind: entry.kind };
  // APFS and NTFS are case-insensitive by default, so `README.md` → `readme.md` is a real
  // edit (fixing the case is the whole point) and `existsSync` would call it a collision.
  const sameFile = resolve(target).toLowerCase() === resolve(entry.path).toLowerCase();
  if (!sameFile && existsSync(target)) {
    throw new Error(uiText("已存在同名项", "An item with that name already exists"));
  }
  if (sameFile) {
    renameSync(entry.path, target);
    return { name, path: target, kind: entry.kind };
  }
  moveWithoutOverwrite(entry, target);
  return { name, path: target, kind: entry.kind };
}

/**
 * Move without replacing whatever stands at the destination.
 *
 * `renameSync` overwrites, so a destination created between the check above and the move — by
 * the agent, or by a second window on the same project — would be destroyed by a click that
 * meant only "change this file's name". A hard link and a new symlink are both refused with
 * `EEXIST` by the kernel, which makes the check and the move one operation. A directory can
 * be neither, and some volumes refuse links outright: those fall back to the checked rename,
 * which is the window left open rather than one hidden.
 */
function moveWithoutOverwrite(
  entry: { path: string; kind: DirEntry["kind"]; symlink: boolean },
  target: string,
): void {
  const exists = uiText("已存在同名项", "An item with that name already exists");
  if (entry.kind === "directory") {
    renameSync(entry.path, target);
    return;
  }
  if (entry.symlink) {
    try {
      // The link moves to the directory it already sat in, so a relative target still reads.
      symlinkSync(readlinkSync(entry.path), target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new Error(exists);
      renameSync(entry.path, target);
      return;
    }
    unlinkSync(entry.path);
    return;
  }
  try {
    linkSync(entry.path, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(exists);
    renameSync(entry.path, target);
    return;
  }
  try {
    unlinkSync(entry.path);
  } catch (error) {
    // Roll the link back: the file is still whole under its old name.
    unlinkQuiet(target);
    throw error;
  }
}

/**
 * Remove the entry at `path`, through the host's Trash when it has one.
 *
 * A `trash` that fails is reported, never followed by a silent permanent delete: the user
 * clicked delete expecting the file to be recoverable, and taking it anyway would be the
 * app destroying data the click did not ask for.
 */
export async function deleteWorkspaceEntry(input: {
  cwd?: unknown;
  path?: unknown;
  trash?: (path: string) => Promise<void>;
}): Promise<void> {
  const entry = entryInside(input.cwd, input.path);
  if (input.trash) {
    await input.trash(entry.path);
    return;
  }
  if (entry.kind === "directory") rmSync(entry.path, { recursive: true, maxRetries: 0 });
  else unlinkSync(entry.path);
}
