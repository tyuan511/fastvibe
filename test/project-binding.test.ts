import assert from "node:assert/strict";
import test from "node:test";
import {
  bindingCapabilities,
  bindingProjectKey,
  canUseBinding,
  decodeRemoteConversationId,
  decodeRemoteProjectKey,
  encodeRemoteConversationId,
  isRemoteConversationId,
  remoteProjectKey,
  type ProjectBinding,
} from "../src/shared/project-binding.ts";

test("a remote conversation id round-trips through the codec", () => {
  const encoded = encodeRemoteConversationId("srv_remote1", "2f3a9b");
  assert.equal(encoded, "remote:srv_remote1:2f3a9b");
  assert.deepEqual(decodeRemoteConversationId(encoded), {
    serverInstanceId: "srv_remote1",
    remoteConversationId: "2f3a9b",
  });
  assert.equal(isRemoteConversationId(encoded), true);
});

test("two servers may mint the same local id, and the ids stay apart", () => {
  // This is the ambiguity the old design could not express at all: the branch replaced
  // the whole call table per connection, so it never had to tell two servers' identical
  // UUIDs apart. A namespaced id does, and that is why routing can be per request.
  const a = encodeRemoteConversationId("srv_alpha", "same-uuid");
  const b = encodeRemoteConversationId("srv_beta", "same-uuid");
  assert.notEqual(a, b);
  assert.notEqual(decodeRemoteConversationId(a)?.serverInstanceId, decodeRemoteConversationId(b)?.serverInstanceId);
});

test("a local id containing the separator survives the round trip", () => {
  // Only the server half ends at the first separator; a remote id is opaque and may
  // contain anything, including the character the key is split on.
  const encoded = encodeRemoteConversationId("srv_remote1", "weird:id:here");
  assert.deepEqual(decodeRemoteConversationId(encoded), {
    serverInstanceId: "srv_remote1",
    remoteConversationId: "weird:id:here",
  });
});

test("a plain local id is not mistaken for a remote one", () => {
  assert.equal(isRemoteConversationId("9e2b1f-local-uuid"), false);
  assert.equal(decodeRemoteConversationId("9e2b1f-local-uuid"), null);
  // A conversation whose id merely *starts* with `remote` is still local.
  assert.equal(isRemoteConversationId("remoteish"), false);
});

test("a malformed ref decodes to null rather than routing nowhere", () => {
  const malformed = [
    "remote:",
    "remote:srv_only",
    "remote::local",
    "remote:srv_remote1:",
    "remote: :local",
  ];
  for (const value of malformed) {
    assert.equal(decodeRemoteConversationId(value), null, value);
    assert.equal(isRemoteConversationId(value), false, value);
  }
});

test("encoding refuses an id that could not be addressed later", () => {
  assert.throws(() => encodeRemoteConversationId("", "local"), /远程标识不完整/);
  assert.throws(() => encodeRemoteConversationId("srv", ""), /远程标识不完整/);
  // A server half containing the separator would split in the wrong place — it can
  // never be produced, and it must not be accepted either.
  assert.throws(() => encodeRemoteConversationId("srv:bad", "local"), /远程服务器标识无效/);
});

test("the project key uses the same codec as a conversation id", () => {
  const key = remoteProjectKey("srv_remote1", "workspace-abc");
  assert.equal(key, "remote:srv_remote1:workspace-abc");
  assert.deepEqual(decodeRemoteProjectKey(key), {
    serverInstanceId: "srv_remote1",
    remoteWorkspaceId: "workspace-abc",
  });
});

test("a binding is grouped under the key its project is listed by", () => {
  const binding: ProjectBinding = {
    id: "binding-1",
    kind: "remote",
    name: "远程项目",
    connectionId: "profile-1",
    serverInstanceId: "srv_remote1",
    remoteWorkspaceId: "workspace-abc",
    remotePath: "/home/dev/project",
    createdAt: 1,
  };
  assert.equal(bindingProjectKey(binding), remoteProjectKey("srv_remote1", "workspace-abc"));
  // And the key it is grouped under decodes back to the same pair, which is what lets
  // a request that names only the project key find its server.
  assert.deepEqual(decodeRemoteProjectKey(bindingProjectKey(binding)), {
    serverInstanceId: binding.serverInstanceId,
    remoteWorkspaceId: binding.remoteWorkspaceId,
  });
});

test("effective capabilities are the intersection of both ends", () => {
  assert.deepEqual(bindingCapabilities(["engine", "browser", "native"], ["engine", "terminal"]), ["engine"]);
  // A client that declares nothing gets the server's full set.
  assert.deepEqual(bindingCapabilities(["engine", "browser"]), ["engine", "browser"]);
  assert.deepEqual(bindingCapabilities(["engine", "browser"], []), ["engine", "browser"]);
  assert.equal(canUseBinding(["engine"], "engine"), true);
  assert.equal(canUseBinding(["engine"], "browser"), false);
});
