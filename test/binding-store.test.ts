import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectBinding } from "../src/shared/project-binding.ts";
import {
  readBindings,
  readProjectOrder,
  removeBinding,
  removeBindingsForConnection,
  renameBinding,
  reorderProjectOrder,
  saveBinding,
} from "../src/main/remote/binding-store.ts";

function file(): string {
  return join(mkdtempSync(join(tmpdir(), "fastvibe-bindings-")), "bindings.json");
}

function binding(over: Partial<ProjectBinding> = {}): ProjectBinding {
  return {
    id: "bind_1",
    kind: "remote",
    name: "远程项目",
    connectionId: "host-a",
    serverInstanceId: "srv_alpha",
    remoteWorkspaceId: "/home/dev/app",
    remotePath: "/home/dev/app",
    createdAt: 1,
    ...over,
  };
}

test("a workspace id that was stored as a remote key is the path", () => {
  const path = file();
  saveBinding(path, binding({
    remoteWorkspaceId: "remote:srv_alpha:remote:srv_alpha:/home/dev/app",
    remotePath: "remote:srv_alpha:/home/dev/app",
  }));
  const saved = readBindings(path)[0]!;
  assert.equal(saved.remoteWorkspaceId, "/home/dev/app");
  assert.equal(saved.remotePath, "/home/dev/app");
});

test("a binding round-trips through the store", () => {
  const path = file();
  const saved = saveBinding(path, binding());
  assert.equal(saved.length, 1);
  assert.deepEqual(readBindings(path), saved);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { version: number };
  assert.equal(parsed.version, 1);
});

test("saving the same workspace twice updates the row instead of duplicating it", () => {
  const path = file();
  saveBinding(path, binding({ name: "旧名" }));
  saveBinding(path, binding({ id: "bind_2", name: "新名", connectionId: "host-b" }));
  const rows = readBindings(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "新名");
  assert.equal(rows[0]!.connectionId, "host-b");
  assert.equal(rows[0]!.id, "bind_2");
});

test("two servers may bind a workspace with the same path", () => {
  const path = file();
  saveBinding(path, binding());
  saveBinding(path, binding({ id: "bind_2", serverInstanceId: "srv_beta" }));
  assert.equal(readBindings(path).length, 2);
});

test("an invalid server instance id is refused at the boundary", () => {
  const path = file();
  assert.throws(() => saveBinding(path, binding({ serverInstanceId: "srv:bad" })), /远程项目绑定无效/);
  assert.deepEqual(readBindings(path), []);
});

test("a corrupt or version-mismatched file reads as empty rather than throwing", () => {
  const path = file();
  assert.deepEqual(readBindings(path), []);
  const other = file();
  saveBinding(other, binding());
  // A row whose server id could not appear in a composite key is dropped on read.
  const bad = file();
  writeFileSync(bad, JSON.stringify({ version: 1, bindings: [{ ...binding(), serverInstanceId: "has space" }] }));
  assert.deepEqual(readBindings(bad), []);
});

test("the mixed project order is local state and survives binding edits", () => {
  const path = file();
  saveBinding(path, binding());
  saveBinding(path, binding({ id: "bind_2", serverInstanceId: "srv_beta", remoteWorkspaceId: "/other" }));
  reorderProjectOrder(path, ["/local", "remote:srv_beta:/other", "remote:srv_alpha:/home/dev/app"]);
  renameBinding(path, "bind_1", "新名字");
  assert.deepEqual(readProjectOrder(path), ["/local", "remote:srv_beta:/other", "remote:srv_alpha:/home/dev/app"]);
  removeBinding(path, "bind_2");
  assert.deepEqual(readProjectOrder(path), ["/local", "remote:srv_alpha:/home/dev/app"]);
});

test("remove and rename operate on the local id", () => {
  const path = file();
  saveBinding(path, binding());
  saveBinding(path, binding({ id: "bind_2", serverInstanceId: "srv_beta", remoteWorkspaceId: "/other" }));
  renameBinding(path, "bind_1", "  新名字  ");
  assert.equal(readBindings(path).find((item) => item.id === "bind_1")?.name, "新名字");
  removeBinding(path, "bind_1");
  assert.deepEqual(readBindings(path).map((item) => item.id), ["bind_2"]);
  removeBindingsForConnection(path, "host-a");
  assert.deepEqual(readBindings(path), []);
});
