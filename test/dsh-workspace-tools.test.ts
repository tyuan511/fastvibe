import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WorkspaceFiles } from "../src/main/bot/shadow/pi-workspace.ts";

const rejected = /^Workspace operation rejected$/;
function harness(t: TestContext, validate = () => {}) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "dsh-workspace-"));
  const root = join(base, "workspace"); mkdirSync(root);
  mkdirSync(join(base, "sessions")); mkdirSync(join(base, "agent"));
  writeFileSync(join(base, "sessions", "secret.jsonl"), "private-session-token");
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, files: new WorkspaceFiles(root, validate) };
}
function denied(action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof Error && rejected.test(error.message));
}

test("真实临时工作区：UTF-8读写、重复目录名逐层创建、唯一字面编辑与排序列表", t => {
  const { files, root } = harness(t);
  files.write("a/a/file.txt", "你好\ufeff\n$& .* keep");
  assert.equal(files.read("a/a/file.txt"), "你好\ufeff\n$& .* keep");
  files.edit("a/a/file.txt", "$& .*", "$1 literal");
  assert.equal(readFileSync(join(root, "a/a/file.txt"), "utf8"), "你好\ufeff\n$1 literal keep");
  files.write("b.txt", "B");
  assert.deepEqual(files.list(), [{ name: "a", path: "a", type: "directory" }, { name: "b.txt", path: "b.txt", type: "file" }]);
  assert.deepEqual(files.list("a/a"), [{ name: "file.txt", path: "a/a/file.txt", type: "file" }]);
  assert.equal(lstatSync(join(root, "b.txt")).nlink, 1);
});

for (const path of ["", "..", "../sessions/secret.jsonl", "a/../b", "/etc/passwd", "C:/private", "a\\b", "a\0b", "a\nb", "a\u007fb", "a\u0085b", ".git", ".git/config", "a/.git/config", ".GIT/config", "a//b", "./b", "a/", "//host/path"]) {
  test(`拒绝不合法路径 ${JSON.stringify(path)}`, t => {
    const { files } = harness(t);
    denied(() => files.read(path)); denied(() => files.write(path, "x"));
    denied(() => files.edit(path, "a", "b")); denied(() => files.list(path));
  });
}

test(".只允许list，正常工作区不暴露兄弟Session或agent目录", t => {
  const { files, root } = harness(t);
  denied(() => files.read(".")); denied(() => files.write(".", "x"));
  assert.deepEqual(files.list(), []);
  denied(() => files.read("sessions/secret.jsonl"));
  assert.equal(readFileSync(join(root, "../sessions/secret.jsonl"), "utf8"), "private-session-token");
});

test("拒绝文件、目录、悬空symlink；不跟随链接也不覆盖外部文件", t => {
  const { files, base, root } = harness(t);
  writeFileSync(join(base, "outside"), "untouched");
  symlinkSync(join(base, "outside"), join(root, "linked"));
  symlinkSync(join(base, "sessions"), join(root, "linked-dir"));
  symlinkSync(join(base, "missing"), join(root, "dangling"));
  for (const path of ["linked", "dangling", "linked-dir/secret.jsonl"]) {
    denied(() => files.read(path)); denied(() => files.write(path, "changed")); denied(() => files.edit(path, "untouched", "changed"));
  }
  denied(() => files.list("linked-dir")); denied(() => files.write("linked-dir/new/deep.txt", "x"));
  assert.equal(readFileSync(join(base, "outside"), "utf8"), "untouched");
  assert.deepEqual(files.list(), []);
});

test("拒绝hardlink读写与编辑，列表隐藏hardlink；原inode内容保持", t => {
  const { files, base, root } = harness(t);
  writeFileSync(join(base, "outside"), "untouched"); linkSync(join(base, "outside"), join(root, "hard"));
  denied(() => files.read("hard")); denied(() => files.write("hard", "changed")); denied(() => files.edit("hard", "untouched", "changed"));
  assert.deepEqual(files.list(), []); assert.equal(readFileSync(join(base, "outside"), "utf8"), "untouched");
  files.write("local", "original"); linkSync(join(root, "local"), join(root, "other"));
  denied(() => files.read("local")); denied(() => files.write("other", "changed"));
});

test("拒绝非regular文件和把文件作为父目录，不截断现有数据", t => {
  const { files } = harness(t);
  files.write("a/file", "original");
  denied(() => files.read("a")); denied(() => files.write("a", "x")); denied(() => files.edit("a", "x", "y"));
  denied(() => files.write("a/file/child", "x")); denied(() => files.list("a/file"));
  assert.equal(files.read("a/file"), "original");
});

test("拒绝真实FIFO特殊文件，读写不阻塞，列表隐藏FIFO和.git", { timeout: 5000, skip: process.platform === "win32" }, t => {
  const { files, root } = harness(t);
  execFileSync("mkfifo", [join(root, "pipe")]);
  mkdirSync(join(root, ".git")); writeFileSync(join(root, ".git", "config"), "private config");
  denied(() => files.read("pipe")); denied(() => files.write("pipe", "x")); denied(() => files.edit("pipe", "x", "y"));
  denied(() => files.read(".git/config")); assert.deepEqual(files.list(), []);
});

test("读512KiB、写1MiB按UTF-8字节计数，超限拒绝且不截断", t => {
  const { files, root } = harness(t);
  const maxRead = "é".repeat(256 * 1024);
  files.write("read", maxRead); assert.equal(files.read("read"), maxRead);
  files.write("read", maxRead + "a"); denied(() => files.read("read"));
  const maxWrite = "é".repeat(512 * 1024);
  files.write("write", maxWrite); assert.equal(lstatSync(join(root, "write")).size, 1024 * 1024);
  denied(() => files.write("write", maxWrite + "a"));
  assert.equal(readFileSync(join(root, "write"), "utf8"), maxWrite);
  denied(() => files.write("new/oversize", maxWrite + "a"));
  assert.ok(!files.list().some(e => e.name === "new"));
  writeFileSync(join(root, "raw"), Buffer.alloc(512 * 1024 + 1)); denied(() => files.read("raw"));
});

test("拒绝非UTF-8输入及unpaired surrogate；保留有效BOM", t => {
  const { files, root } = harness(t);
  writeFileSync(join(root, "invalid"), Buffer.from([0xc3, 0x28])); denied(() => files.read("invalid"));
  denied(() => files.write("bad", "\ud800"));
  files.write("bom", "\ufeffcontent"); assert.equal(files.read("bom"), "\ufeffcontent");
});

test("edit要求非空唯一匹配，重叠匹配也拒绝；替换是字面文本", t => {
  const { files } = harness(t);
  files.write("f", "aaa");
  for (const old of ["", "missing", "a", "aa"]) denied(() => files.edit("f", old, "b"));
  assert.equal(files.read("f"), "aaa");
  files.edit("f", "aaa", "$&$1.*"); assert.equal(files.read("f"), "$&$1.*");
  denied(() => files.edit("f", "$&$1.*", "x".repeat(1024 * 1024 + 1)));
  assert.equal(files.read("f"), "$&$1.*");
});

test("validate覆盖构造、每次操作和返回前；撤权后全部拒绝并脱敏错误", t => {
  let calls = 0, current = true;
  const { files } = harness(t, () => { calls++; if (!current) throw new Error("/external/private-token"); });
  assert.equal(calls, 2);
  for (const action of [() => files.write("a", "hello"), () => files.read("a"), () => files.edit("a", "hello", "world"), () => files.list()]) {
    const before = calls; action(); assert.ok(calls >= before + 2);
  }
  current = false;
  for (const action of [() => files.read("a"), () => files.write("a", "x"), () => files.edit("a", "world", "x"), () => files.list()]) denied(action);
});

test("read/list返回前撤权不能交出结果，write截断前撤权保留原内容", t => {
  let armed = false, calls = 0, failAt = 2;
  const { files, root } = harness(t, () => { if (armed && ++calls === failAt) throw new Error("secret"); });
  files.write("a", "original");
  armed = true; denied(() => files.read("a"));
  calls = 0; denied(() => files.list());
  calls = 0; failAt = 3; denied(() => files.write("a", "changed"));
  assert.equal(readFileSync(join(root, "a"), "utf8"), "original");
});

test("root必须通过assertShadowPath；拒绝根和祖先symlink及替换后的根", t => {
  denied(() => new WorkspaceFiles(resolve("."), () => {}));
  const { files, base, root } = harness(t);
  symlinkSync(root, join(base, "link")); denied(() => new WorkspaceFiles(join(base, "link"), () => {}));
  mkdirSync(join(root, "nested")); denied(() => new WorkspaceFiles(join(base, "link/nested"), () => {}));
  renameSync(root, join(base, "old")); mkdirSync(root);
  denied(() => files.list()); denied(() => files.write("x", "x"));
});

test("固定扩展仅注册四个工具，调用走真实文件端口，错误不会携带宿主路径", async t => {
  const { files } = harness(t);
  const tools = new Map<string, ToolDefinition>();
  await files.extension()({ registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI);
  assert.deepEqual([...tools.keys()].sort(), ["edit_file", "list_files", "read_file", "write_file"]);
  const invoke = (name: string, args: Record<string, unknown>) => tools.get(name)!.execute("call-1", args, undefined, undefined, {} as never);
  await invoke("write_file", { path: "f", text: "before" });
  await invoke("edit_file", { path: "f", oldText: "before", newText: "after" });
  const read = await invoke("read_file", { path: "f" });
  assert.deepEqual(read.content, [{ type: "text", text: "after" }]);
  const list = await invoke("list_files", {});
  assert.deepEqual(list.content, [{ type: "text", text: JSON.stringify([{ name: "f", path: "f", type: "file" }]) }]);
  await assert.rejects(invoke("read_file", { path: "/private/token" }), error => error instanceof Error && rejected.test(error.message));
});
