import assert from "node:assert/strict";
import test from "node:test";
import { shouldFollowCatalogActive } from "../src/renderer/src/lib/remote-project.ts";

const local = "conv_local";
const remote = "remote:srv_alpha:conv_remote";
const otherLocal = "conv_other";

test("a local catalog id does not pull the window off a remote conversation", () => {
  assert.equal(shouldFollowCatalogActive({ next: local, current: remote, intended: remote }), false);
  assert.equal(shouldFollowCatalogActive({ next: otherLocal, current: remote, intended: remote }), false);
  // The open has been claimed but the transcript has not arrived yet.
  assert.equal(shouldFollowCatalogActive({ next: local, current: local, intended: remote }), false);
});

test("another local window's navigation is still followed", () => {
  assert.equal(shouldFollowCatalogActive({ next: otherLocal, current: local, intended: local }), true);
});

test("the conversation already on screen or already claimed is not opened again", () => {
  assert.equal(shouldFollowCatalogActive({ next: local, current: local, intended: null }), false);
  assert.equal(shouldFollowCatalogActive({ next: remote, current: local, intended: remote }), false);
  assert.equal(shouldFollowCatalogActive({ next: null, current: remote, intended: remote }), false);
});
