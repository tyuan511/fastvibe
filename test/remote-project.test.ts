import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingStateKey,
  displayRemotePath,
  encodeRemoteReadPath,
  isRemoteProject,
  isRemoteRef,
  parentRemotePath,
  projectHasCapability,
  remoteProjectActivityKey,
} from "../src/renderer/src/lib/remote-project.ts";
import type { Project } from "../src/shared/types.ts";

function remoteProject(over: Partial<Project> = {}): Project {
  return {
    cwd: "remote:srv_preview:/home/dev/app",
    name: "app",
    createdAt: 1,
    updatedAt: 1,
    kind: "remote",
    bindingState: "available",
    serverInstanceId: "srv_preview",
    remotePath: "/home/dev/app",
    capabilities: ["conversations", "engine", "workspace"],
    ...over,
  };
}

test("a namespaced project key is a remote ref, a local path is not", () => {
  assert.equal(isRemoteRef("remote:srv_preview:/home/dev/app"), true);
  assert.equal(isRemoteRef("/home/dev/app"), false);
  assert.equal(isRemoteRef(""), false);
  assert.equal(isRemoteRef(undefined), false);
});

test("isRemoteProject follows kind or a namespaced cwd", () => {
  assert.equal(isRemoteProject(remoteProject()), true);
  assert.equal(isRemoteProject(remoteProject({ kind: undefined })), true);
  assert.equal(isRemoteProject({ cwd: "/repo", name: "repo", createdAt: 1, updatedAt: 1 }), false);
  assert.equal(isRemoteProject(undefined), false);
});

test("displayRemotePath strips the server half and leaves a local path alone", () => {
  assert.equal(displayRemotePath("remote:srv_preview:/home/dev/app"), "/home/dev/app");
  assert.equal(displayRemotePath("/home/dev/app"), "/home/dev/app");
});

test("encodeRemoteReadPath always produces a namespaced absolute path", () => {
  assert.equal(encodeRemoteReadPath("srv_preview", "/home/dev/app"), "remote:srv_preview:/home/dev/app");
  assert.equal(encodeRemoteReadPath("srv_preview", "home/dev/app"), "remote:srv_preview:/home/dev/app");
  assert.equal(encodeRemoteReadPath("srv_preview", ""), "remote:srv_preview:/");
  assert.equal(encodeRemoteReadPath("srv_preview", "/"), "remote:srv_preview:/");
});

test("parentRemotePath walks a remote filesystem path, never a namespaced key", () => {
  assert.equal(parentRemotePath("/home/dev/app"), "/home/dev");
  assert.equal(parentRemotePath("/home"), "/");
  assert.equal(parentRemotePath("/"), "/");
  assert.equal(parentRemotePath("/home/dev/app/"), "/home/dev");
});

test("a local project is capable of every pane; a remote one is gated", () => {
  const local: Project = { cwd: "/repo", name: "repo", createdAt: 1, updatedAt: 1 };
  assert.equal(projectHasCapability(local, "terminal"), true);
  assert.equal(projectHasCapability(remoteProject(), "workspace"), true);
  assert.equal(projectHasCapability(remoteProject(), "terminal"), false);
  assert.equal(projectHasCapability(remoteProject({ bindingState: "offline" }), "workspace"), false);
  assert.equal(projectHasCapability(remoteProject({ capabilities: undefined }), "git"), true);
});

test("remote project activity turns SSH deployment steps into readable sidebar states", () => {
  assert.equal(remoteProjectActivityKey({ hostId: "ssh:dev", status: "connecting", activity: "agent-download" }), "agentDownload");
  assert.equal(remoteProjectActivityKey({ hostId: "ssh:dev", status: "connecting", progress: { phase: "agent-upload", done: 10 } }), "agentUpload");
  assert.equal(remoteProjectActivityKey({ hostId: "ssh:dev", status: "connecting", activity: "starting-agent" }), "startingAgent");
  assert.equal(remoteProjectActivityKey({ hostId: "ssh:dev", status: "connecting" }), "preparing");
  assert.equal(remoteProjectActivityKey({ hostId: "ssh:dev", status: "connected" }), undefined);
});

test("bindingStateKey is the i18n suffix, not the wire spelling", () => {
  assert.equal(bindingStateKey("available"), "available");
  assert.equal(bindingStateKey("auth-required"), "authRequired");
  assert.equal(bindingStateKey("incompatible"), "incompatible");
  assert.equal(bindingStateKey(undefined), "offline");
});
