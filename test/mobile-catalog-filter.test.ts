import { test } from "node:test";
import assert from "node:assert/strict";
import { isMobileConversation, isMobileProject, isRemoteCatalogReference } from "../apps/mobile/src/session/catalog-filter.ts";

test("mobile catalog recognizes remote references", () => {
  assert.equal(isRemoteCatalogReference("remote:server-1:conversation-1"), true);
  assert.equal(isRemoteCatalogReference("/Users/me/project"), false);
  assert.equal(isRemoteCatalogReference(undefined), false);
});

test("mobile catalog hides bound remote projects", () => {
  assert.equal(isMobileProject({ cwd: "/Users/me/project", name: "local" }), true);
  assert.equal(isMobileProject({ cwd: "remote:server-1:workspace-1", name: "remote" }), false);
  assert.equal(isMobileProject({ cwd: "/Users/me/project", name: "remote", kind: "remote" }), false);
});

test("mobile catalog hides remote conversations by id or project", () => {
  assert.equal(isMobileConversation({ id: "conversation-1" }), true);
  assert.equal(isMobileConversation({ id: "remote:server-1:conversation-1" }), false);
  assert.equal(isMobileConversation({ id: "conversation-1", project: "remote:server-1:workspace-1" }), false);
});
