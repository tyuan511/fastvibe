import assert from "node:assert/strict";
import test from "node:test";
import { MixedServerScopeError } from "../src/shared/remote-connection.ts";
import {
  collectServerInstanceIds,
  findServerInstanceId,
  resolveServerScope,
  scopeId,
  scopePayload,
  unscopeId,
  unscopePayload,
} from "../src/shared/server-scope.ts";

test("a local payload has no server scope", () => {
  assert.equal(resolveServerScope(undefined), null);
  assert.equal(resolveServerScope({ conversationId: "local-uuid" }), null);
  assert.equal(resolveServerScope({ message: "hello", images: [] }), null);
});

test("a namespaced conversation id is the destination", () => {
  assert.deepEqual(resolveServerScope({ conversationId: "remote:srv_alpha:abc" }), {
    serverInstanceId: "srv_alpha",
  });
  assert.deepEqual(resolveServerScope({ id: "remote:srv_alpha:abc" }), { serverInstanceId: "srv_alpha" });
  assert.deepEqual(resolveServerScope({ project: "remote:srv_alpha:/home/dev/app" }), {
    serverInstanceId: "srv_alpha",
  });
  assert.deepEqual(resolveServerScope({ cwd: "remote:srv_alpha:/home/dev/app" }), {
    serverInstanceId: "srv_alpha",
  });
});

test("two routing fields on the same server are one scope", () => {
  assert.deepEqual(
    resolveServerScope({
      conversationId: "remote:srv_alpha:c1",
      project: "remote:srv_alpha:/srv/app",
    }),
    { serverInstanceId: "srv_alpha" },
  );
});

test("mixed-server routing fields are refused", () => {
  assert.throws(
    () =>
      resolveServerScope({
        conversationId: "remote:srv_alpha:c1",
        project: "remote:srv_beta:/srv/app",
      }),
    MixedServerScopeError,
  );
});

test("prompt and tool content are not scanned for a destination", () => {
  // A quoted id inside the prompt, or a nested tool payload, must not become a route —
  // those graphs are large and routinely mention other conversations.
  const payload = {
    conversationId: "remote:srv_alpha:c1",
    message: "see remote:srv_beta:quoted and $HOME",
    images: [{ conversationId: "remote:srv_beta:nested" }],
    tool: { conversationId: "remote:srv_beta:tool", cwd: "remote:srv_beta:/tmp" },
    payload: { conversationId: "remote:srv_beta:wrapped" },
  };
  assert.deepEqual(resolveServerScope(payload), { serverInstanceId: "srv_alpha" });
  assert.deepEqual(collectServerInstanceIds(payload), ["srv_alpha"]);
  assert.equal(findServerInstanceId(payload), "srv_alpha");
});

test("unscope rewrites only the defined top-level routing fields", () => {
  const payload = {
    conversationId: "remote:srv_alpha:c1",
    project: "remote:srv_alpha:/srv/app",
    cwd: "remote:srv_alpha:/srv/app",
    parentId: "remote:srv_alpha:parent",
    id: "remote:srv_alpha:c1",
    cwds: ["remote:srv_alpha:/a", "remote:srv_alpha:/b"],
    message: "keep remote:srv_alpha:c1 in the prompt",
    tool: { conversationId: "remote:srv_alpha:c1" },
  };
  const next = unscopePayload(payload, "srv_alpha");
  assert.equal(next.conversationId, "c1");
  assert.equal(next.project, "/srv/app");
  assert.equal(next.cwd, "/srv/app");
  assert.equal(next.parentId, "parent");
  assert.equal(next.id, "c1");
  assert.deepEqual(next.cwds, ["/a", "/b"]);
  assert.equal(next.message, payload.message);
  assert.equal(next.tool, payload.tool);
});

test("unscope peels a project key that was encoded twice", () => {
  const next = unscopePayload({
    id: "remote:srv_alpha:c1",
    project: "remote:srv_alpha:remote:srv_alpha:/srv/app",
  }, "srv_alpha");
  assert.equal(next.id, "c1");
  assert.equal(next.project, "/srv/app");
});

test("unscope refuses a field that belongs to another server", () => {
  assert.throws(
    () => unscopePayload({ conversationId: "remote:srv_beta:c1" }, "srv_alpha"),
    MixedServerScopeError,
  );
});

test("scope prefixes local routing fields and will not double-prefix", () => {
  const scoped = scopePayload({ conversationId: "c1", project: "/srv/app" }, "srv_alpha");
  assert.equal(scoped.conversationId, "remote:srv_alpha:c1");
  assert.equal(scoped.project, "remote:srv_alpha:/srv/app");
  assert.equal(scopePayload(scoped, "srv_alpha").conversationId, "remote:srv_alpha:c1");
  assert.equal(scopeId("c1", "srv_alpha"), "remote:srv_alpha:c1");
  assert.equal(unscopeId("remote:srv_alpha:c1", "srv_alpha"), "c1");
});
