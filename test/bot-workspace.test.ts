import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { resolveBotWorkspace } from "../src/main/bot/bot-workspace.ts";

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vivi-workspace-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, root: join(dir, "vivi") };
}

function assertInside(root: string, cwd: string): void {
  const path = relative(root, cwd);
  assert.ok(path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path), `${cwd} must stay inside ${root}`);
}

test("本地项目使用真实 cwd，并保留原始项目标识而不创建 Vivi 工作区", (t) => {
  const { dir, root } = fixture(t);
  const project = join(dir, "project");
  mkdirSync(project);

  assert.deepEqual(resolveBotWorkspace(root, [{ cwd: project }], project, "work:project"), {
    cwd: realpathSync(project),
    project,
  });
  assert.equal(existsSync(root), false);
});

test("符号链接项目保留目录表身份，cwd 解析到真实目录", (t) => {
  const { dir, root } = fixture(t);
  const target = join(dir, "actual-project");
  const project = join(dir, "project-link");
  mkdirSync(target);
  symlinkSync(target, project, process.platform === "win32" ? "junction" : "dir");

  assert.deepEqual(resolveBotWorkspace(root, [{ cwd: project }], project, "work:linked"), {
    cwd: realpathSync(target),
    project,
  });
  assert.equal(existsSync(root), false);
});

test("无项目的 Worker 各自拥有独立目录，同一稳定 key 重用目录及已有产物", (t) => {
  const { root } = fixture(t);
  const first = resolveBotWorkspace(root, [], undefined, "work:first");
  const second = resolveBotWorkspace(root, [], undefined, "work:second");
  assert.notEqual(first.cwd, second.cwd);
  assert.equal("project" in first, false);
  assert.equal("project" in second, false);
  for (const workspace of [first, second]) {
    assertInside(join(root, "workspaces"), workspace.cwd);
    assert.equal(statSync(workspace.cwd).isDirectory(), true);
  }
  writeFileSync(join(first.cwd, "report.txt"), "preserved output");

  assert.deepEqual(resolveBotWorkspace(root, [], undefined, "work:first"), first);
  assert.equal(readFileSync(join(first.cwd, "report.txt"), "utf8"), "preserved output");
  assert.equal(existsSync(join(second.cwd, "report.txt")), false);
  assert.equal(existsSync(join(root, "outputs")), false);
});

test("包含路径穿越、绝对路径与分隔符的 Worker key 无法逃出工作区根", (t) => {
  const { dir, root } = fixture(t);
  const escaped = join(dir, "escaped");
  const keys = ["../../escaped", "../../../escaped", "..\\..\\escaped", escaped, "/tmp/escaped", "C:\\escaped", "work:a/b\\c", "work:\u0000unsafe"];
  const paths = keys.map((key) => {
    const workspace = resolveBotWorkspace(root, [], undefined, key);
    assertInside(join(root, "workspaces"), workspace.cwd);
    assert.equal(statSync(workspace.cwd).isDirectory(), true);
    assert.deepEqual(resolveBotWorkspace(root, [], undefined, key), workspace);
    return workspace.cwd;
  });
  assert.equal(new Set(paths).size, keys.length);
  assert.equal(existsSync(escaped), false);
});

test("未提供 Worker key 时使用 Vivi 总 outputs，且与 Worker 私有目录隔离", (t) => {
  const { root } = fixture(t);
  const shared = resolveBotWorkspace(root, []);
  assert.deepEqual(shared, { cwd: join(root, "outputs") });
  assert.equal(statSync(shared.cwd).isDirectory(), true);
  writeFileSync(join(shared.cwd, "shared.txt"), "shared output");
  assert.deepEqual(resolveBotWorkspace(root, []), shared);
  assert.equal(readFileSync(join(shared.cwd, "shared.txt"), "utf8"), "shared output");
  assert.notEqual(resolveBotWorkspace(root, [], undefined, "work:first").cwd, shared.cwd);
});

test("未知项目、远程项目、失效目录与文件均明确拒绝且不回退或创建目录", (t) => {
  const { dir, root } = fixture(t);
  const unknown = join(dir, "unregistered-project");
  const remote = join(dir, "remote-project");
  const missing = join(dir, "missing-project");
  const file = join(dir, "project-file.txt");
  mkdirSync(unknown);
  mkdirSync(remote);
  writeFileSync(file, "not a directory");
  const projects = [{ cwd: remote, kind: "remote" as const }, { cwd: missing }, { cwd: file }];

  for (const project of [unknown, remote, missing, file]) {
    assert.throws(() => resolveBotWorkspace(root, projects, project, "work:invalid"), /项目|project/i);
    assert.throws(() => resolveBotWorkspace(root, projects, project), /项目|project/i);
    assert.equal(existsSync(root), false, "拒绝后不能悄悄回退到 outputs 或 Worker 私有目录");
  }
  assert.equal(existsSync(missing), false);
  assert.equal(readFileSync(file, "utf8"), "not a directory");
});
