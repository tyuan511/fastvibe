import { test } from "node:test";
import assert from "node:assert/strict";
import { isMobileConversation, isMobileProject, isRemoteCatalogReference } from "../apps/mobile/src/session/catalog-filter.ts";
import { orderProjectsByRecentUse } from "../apps/mobile/src/session/project-order.ts";

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

test("new-chat projects are ordered by their most recent conversation", () => {
  const projects = [
    { cwd: "/older", name: "older" },
    { cwd: "/unused", name: "unused" },
    { cwd: "/newer", name: "newer" },
  ];
  const conversations = [
    { project: "/older", createdAt: 10, updatedAt: 20 },
    { project: "/newer", createdAt: 5, updatedAt: 30 },
    { project: "/older", createdAt: 40, updatedAt: 50 },
  ];

  assert.deepEqual(orderProjectsByRecentUse(projects, conversations).map((item) => item.cwd), ["/older", "/newer", "/unused"]);
});

test("side chats do not make a project look recently used", () => {
  const projects = [
    { cwd: "/main", name: "main" },
    { cwd: "/side", name: "side" },
  ];

  assert.deepEqual(
    orderProjectsByRecentUse(projects, [
      { project: "/side", createdAt: 1, updatedAt: 100, kind: "side-chat" },
      { project: "/main", createdAt: 1, updatedAt: 10 },
    ]).map((item) => item.cwd),
    ["/main", "/side"],
  );
});
