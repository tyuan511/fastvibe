// SPDX-License-Identifier: MIT
import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { assertShadowPath } from "./schema.ts";

export interface WorkspaceEntry { name: string; path: string; type: "file" | "directory" }
const READ_LIMIT = 512 * 1024;
const WRITE_LIMIT = 1024 * 1024;
const failure = (): Error => new Error("Workspace operation rejected");
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const regular = (s: Stats): void => { if (!s.isFile() || s.nlink !== 1) throw failure(); };
const validName = (s: string): boolean => !!s && s !== "." && s !== ".." && s.toLowerCase() !== ".git" && !/[\\/\x00-\x1f\x7f-\x9f]/u.test(s);

/**
 * Host-owned file port for one ExecutionDirectories.cwd, never its parent.
 * This module loads no instructions, extensions, credentials or external tools.
 * The tool collection is not an OS sandbox. O_NOFOLLOW and inode checks enforce
 * normal path boundaries; they do not promise safety against a malicious process
 * running as the same OS user concurrently replacing ancestor directories.
 * The caller supplies the dedicated workspace directory, not sessions/agent/base.
 */
export class WorkspaceFiles {
  private readonly root: string;
  private readonly rootStat: Stats;
  private readonly validate: () => void;

  constructor(root: string, validate: () => void) {
    this.validate = validate;
    try {
      validate();
      if (typeof root !== "string" || !root || /[\x00-\x1f\x7f-\x9f]/u.test(root)) throw failure();
      this.root = resolve(root);
      assertShadowPath(this.root);
      this.rootStat = this.checkRoot();
      validate();
    } catch { throw failure(); }
  }

  private run<T>(action: () => T): T {
    try { this.validate(); this.checkRoot(); const value = action(); this.checkRoot(); this.validate(); return value; }
    catch { throw failure(); }
  }

  private checkRoot(): Stats {
    let current = parse(this.root).root;
    for (const part of this.root.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
    }
    const stat = lstatSync(this.root);
    if (this.rootStat && !same(this.rootStat, stat)) throw failure();
    return stat;
  }

  private parts(path: string, allowRoot = false): string[] {
    if (allowRoot && path === ".") return [];
    if (typeof path !== "string" || isAbsolute(path) || /^[a-z]:/iu.test(path)) throw failure();
    const parts = path.split("/");
    if (!parts.every(validName)) throw failure();
    return parts;
  }

  private directory(parts: string[], create = false): string {
    this.checkRoot();
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let stat: Stats;
      try { stat = lstatSync(current); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw failure();
        // Recheck every ancestor before each individual mkdir; never recursive mkdir.
        this.directory(parts.slice(0, index));
        this.validate();
        mkdirSync(current, { mode: 0o700 });
        stat = lstatSync(current);
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure();
    }
    return current;
  }

  private target(path: string, createParents = false): string {
    const parts = this.parts(path);
    const parent = this.directory(parts.slice(0, -1), createParents);
    return join(parent, parts[parts.length - 1]!);
  }

  private checkFile(path: string, fd: number, expected?: Stats): Stats {
    const stat = fstatSync(fd); regular(stat);
    const named = lstatSync(path); regular(named);
    if (!same(named, stat) || (expected && !same(expected, stat))) throw failure();
    return stat;
  }

  read(path: string): string {
    return this.run(() => this.readContent(path));
  }

  private readContent(path: string): string {
    const target = this.target(path);
    const before = lstatSync(target); regular(before);
    if (before.size > READ_LIMIT) throw failure();
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = this.checkFile(target, fd, before);
      if (stat.size > READ_LIMIT) throw failure();
      const data = Buffer.alloc(READ_LIMIT + 1);
      let count = 0;
      while (count < data.length) {
        const n = readSync(fd, data, count, data.length - count, count);
        if (!n) break;
        count += n;
      }
      const after = this.checkFile(target, fd, before);
      if (count > READ_LIMIT || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw failure();
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data.subarray(0, count));
    } finally { closeSync(fd); }
  }

  write(path: string, text: string): void {
    this.run(() => this.writeContent(path, text));
  }

  private writeContent(path: string, text: string): void {
    if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > WRITE_LIMIT) throw failure();
    // Reject unpaired surrogates instead of silently replacing them on UTF-8 encoding.
    if (Buffer.from(text, "utf8").toString("utf8") !== text) throw failure();
    const target = this.target(path, true);
    let before: Stats | undefined;
    try { before = lstatSync(target); regular(before); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw failure(); }
    this.validate();
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (before ? 0 : constants.O_EXCL), 0o600);
    try {
      this.checkFile(target, fd, before);
      this.target(path); this.validate();
      // Do not truncate until the opened inode has passed all checks.
      ftruncateSync(fd, 0);
      writeFileSync(fd, text, { encoding: "utf8" });
      this.checkFile(target, fd, before);
    } finally { closeSync(fd); }
  }

  edit(path: string, oldText: string, newText: string): void {
    this.run(() => {
      if (typeof oldText !== "string" || !oldText || typeof newText !== "string") throw failure();
      const text = this.readContent(path), index = text.indexOf(oldText);
      // Count overlapping matches too: "aa" in "aaa" is ambiguous.
      if (index < 0 || text.indexOf(oldText, index + 1) >= 0) throw failure();
      this.validate();
      this.writeContent(path, text.slice(0, index) + newText + text.slice(index + oldText.length));
    });
  }

  list(path = "."): WorkspaceEntry[] {
    return this.run(() => {
      const parts = this.parts(path, true), target = this.directory(parts);
      const before = lstatSync(target);
      const entries: WorkspaceEntry[] = [];
      for (const name of readdirSync(target).sort()) {
        if (!validName(name)) continue;
        const stat = lstatSync(join(target, name));
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) continue;
        entries.push({ name, path: [...parts, name].join("/"), type: stat.isDirectory() ? "directory" : "file" });
      }
      const after = lstatSync(this.directory(parts));
      if (!same(before, after)) throw failure();
      return entries;
    });
  }

  extension(): ExtensionFactory {
    return pi => {
      const path = Type.String();
      const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
      pi.registerTool({ name: "read_file", label: "Read workspace file", description: "Read a UTF-8 file in the dedicated workspace (maximum 512 KiB).", parameters: Type.Object({ path }, { additionalProperties: false }),
        execute: async (_id, args) => result(this.read(args.path)) });
      pi.registerTool({ name: "write_file", label: "Write workspace file", description: "Write a UTF-8 file in the dedicated workspace (maximum 1 MiB).", parameters: Type.Object({ path, text: Type.String() }, { additionalProperties: false }),
        execute: async (_id, args) => { this.write(args.path, args.text); return result("Workspace file written"); } });
      pi.registerTool({ name: "edit_file", label: "Edit workspace file", description: "Replace one unique, nonempty literal string in a workspace file.", parameters: Type.Object({ path, oldText: Type.String({ minLength: 1 }), newText: Type.String() }, { additionalProperties: false }),
        execute: async (_id, args) => { this.edit(args.path, args.oldText, args.newText); return result("Workspace file edited"); } });
      pi.registerTool({ name: "list_files", label: "List workspace files", description: "List immediate safe files and directories in the dedicated workspace.", parameters: Type.Object({ path: Type.Optional(path) }, { additionalProperties: false }),
        execute: async (_id, args) => result(JSON.stringify(this.list(args.path))) });
    };
  }
}
