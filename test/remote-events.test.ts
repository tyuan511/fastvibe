import assert from "node:assert/strict";
import test from "node:test";
import { Ipc } from "../src/shared/ipc.ts";
import {
  classifyRemotePush,
  isConversationPush,
  namespaceCatalogSnapshot,
  namespaceConversationSnapshot,
  namespaceIdList,
  namespaceIdMap,
  namespaceRemotePush,
  shouldRelayRemotePush,
} from "../src/shared/remote-events.ts";

const SERVER = "srv_alpha";

test("catalog and engine pushes are classified; settings and global status are dropped", () => {
  assert.equal(classifyRemotePush(Ipc.workspaceChanged), "catalog");
  assert.equal(classifyRemotePush(Ipc.conversationReady), "catalog");
  assert.equal(classifyRemotePush(Ipc.event), "engine");
  assert.equal(classifyRemotePush(Ipc.settingsChanged), "drop");
  assert.equal(classifyRemotePush(Ipc.status), "drop");
  assert.equal(classifyRemotePush(Ipc.sshState), "drop");
  assert.equal(classifyRemotePush(Ipc.remoteState), "drop");
  assert.equal(classifyRemotePush(Ipc.updateState), "drop");
  assert.equal(classifyRemotePush(Ipc.windowState), "drop");
  assert.equal(classifyRemotePush(Ipc.providersOAuthEvent), "drop");
  assert.equal(classifyRemotePush(Ipc.workspaceTerminalData), "terminal");
  assert.equal(classifyRemotePush("future:channel"), "unknown");
  assert.equal(shouldRelayRemotePush(Ipc.settingsChanged), false);
  assert.equal(shouldRelayRemotePush(Ipc.status), false);
  assert.equal(shouldRelayRemotePush(Ipc.event), true);
  assert.equal(shouldRelayRemotePush(Ipc.workspaceTerminalData), true);
  assert.equal(shouldRelayRemotePush("future:channel"), false);
  assert.equal(isConversationPush(Ipc.event), true);
  assert.equal(isConversationPush(Ipc.status), false);
  assert.equal(isConversationPush(Ipc.workspaceTerminalData), false);
});

test("settings and global navigation channels are not rewritten into a relay payload", () => {
  assert.equal(namespaceRemotePush(Ipc.settingsChanged, { themeMode: "dark" }, SERVER), undefined);
  assert.equal(namespaceRemotePush(Ipc.status, { state: "ready" }, SERVER), undefined);
});

test("workspace:changed namespaces conversations and workspaces and strips activeId", () => {
  const payload = {
    activeId: "conv-1",
    nextId: "conv-1",
    projects: [{ cwd: "/home/dev/app", name: "app" }],
    conversations: [
      { id: "conv-1", project: "/home/dev/app", cwd: "/home/dev/app", parentId: "conv-0", title: "x" },
    ],
  };
  const next = namespaceRemotePush(Ipc.workspaceChanged, payload, SERVER) as Record<string, unknown>;
  assert.equal("activeId" in next, false);
  assert.equal("nextId" in next, false);
  const conversations = next.conversations as Array<Record<string, unknown>>;
  assert.equal(conversations[0]!.id, "remote:srv_alpha:conv-1");
  assert.equal(conversations[0]!.parentId, "remote:srv_alpha:conv-0");
  assert.equal(conversations[0]!.project, "remote:srv_alpha:/home/dev/app");
  assert.equal(conversations[0]!.cwd, "remote:srv_alpha:/home/dev/app");
  const projects = next.projects as Array<Record<string, unknown>>;
  assert.equal(projects[0]!.cwd, "remote:srv_alpha:/home/dev/app");
  // The original is left alone — the remote catalog must not be mutated in place.
  assert.equal(payload.activeId, "conv-1");
  assert.equal(payload.conversations[0]!.id, "conv-1");
});

test("conversations:ready namespaces the conversation id, state, and leaves extension keys alone", () => {
  const payload = {
    id: "conv-1",
    messages: [{ id: "m1", text: "hi" }],
    extensionStatus: { goal: "armed" },
    state: { conversationId: "conv-1", cwd: "/home/dev/app", isStreaming: false },
  };
  const next = namespaceRemotePush(Ipc.conversationReady, payload, SERVER) as Record<string, unknown>;
  assert.equal(next.id, "remote:srv_alpha:conv-1");
  assert.deepEqual(next.messages, payload.messages);
  assert.deepEqual(next.extensionStatus, { goal: "armed" });
  const state = next.state as Record<string, unknown>;
  assert.equal(state.conversationId, "remote:srv_alpha:conv-1");
  assert.equal(state.cwd, "remote:srv_alpha:/home/dev/app");
  assert.equal(state.isStreaming, false);
});

test("engine:event namespaces conversationId and does not walk message/tool content", () => {
  const payload = {
    type: "message_update",
    conversationId: "conv-1",
    text: "see conv-2",
    event: { conversationId: "do-not-touch", tool: { path: "/tmp", toolCallId: "call-1", index: 0 } },
  };
  const next = namespaceRemotePush(Ipc.event, payload, SERVER) as Record<string, unknown>;
  assert.equal(next.conversationId, "remote:srv_alpha:conv-1");
  assert.equal(next.event, payload.event);
  assert.equal(next.text, "see conv-2");
  assert.equal((next.event as { tool: { toolCallId: string } }).tool.toolCallId, "call-1");
});

test("permission request ids are namespaced so respondPermission can route by id", () => {
  const next = namespaceRemotePush(
    Ipc.event,
    { type: "extension_ui_request", id: "prompt-1", conversationId: "conv-1", method: "confirm" },
    SERVER,
  ) as Record<string, unknown>;
  assert.equal(next.id, "remote:srv_alpha:prompt-1");
  assert.equal(next.conversationId, "remote:srv_alpha:conv-1");
});

test("conversation_opened is dropped so a remote create cannot navigate this window", () => {
  assert.equal(
    namespaceRemotePush(
      Ipc.event,
      { type: "conversation_opened", conversationId: "conv-1", result: { activeId: "conv-1" } },
      SERVER,
    ),
    undefined,
  );
});

test("conversation_running keeps its boolean and namespaces the id", () => {
  const next = namespaceRemotePush(
    Ipc.event,
    { type: "conversation_running", conversationId: "conv-1", running: true },
    SERVER,
  ) as Record<string, unknown>;
  assert.equal(next.conversationId, "remote:srv_alpha:conv-1");
  assert.equal(next.running, true);
});

test("a renamed snapshot is namespaced as a catalog and loses activeId", () => {
  const next = namespaceRemotePush(
    Ipc.event,
    {
      type: "conversation_renamed",
      conversationId: "conv-1",
      snapshot: { activeId: "conv-1", conversations: [{ id: "conv-1", cwd: "/app" }], projects: [] },
    },
    SERVER,
  ) as Record<string, unknown>;
  assert.equal(next.conversationId, "remote:srv_alpha:conv-1");
  const snapshot = next.snapshot as Record<string, unknown>;
  assert.equal("activeId" in snapshot, false);
  assert.equal((snapshot.conversations as Array<Record<string, string>>)[0]!.id, "remote:srv_alpha:conv-1");
});

test("an unknown channel is dropped, not passed through", () => {
  const payload = { conversationId: "conv-1", nested: { id: "x" } };
  assert.equal(classifyRemotePush("future:channel"), "unknown");
  assert.equal(namespaceRemotePush("future:channel", payload, SERVER), undefined);
});

test("terminal-data namespaces the session id and is relayed", () => {
  const next = namespaceRemotePush(
    Ipc.workspaceTerminalData,
    { id: "term-1", data: "hello" },
    SERVER,
  ) as Record<string, unknown>;
  assert.equal(next.id, "remote:srv_alpha:term-1");
  assert.equal(next.data, "hello");
});

test("integrator helpers namespace snapshots, running maps, and running lists", () => {
  const snapshot = namespaceConversationSnapshot({ conversationId: "c1", messages: [1], running: true }, SERVER);
  assert.deepEqual(snapshot, { conversationId: "remote:srv_alpha:c1", messages: [1], running: true });
  assert.deepEqual(namespaceIdMap({ c1: true, c2: false }, SERVER), {
    "remote:srv_alpha:c1": true,
    "remote:srv_alpha:c2": false,
  });
  assert.deepEqual(namespaceIdList(["c1", "c2"], SERVER), ["remote:srv_alpha:c1", "remote:srv_alpha:c2"]);
  const catalog = namespaceCatalogSnapshot({ activeId: "c1", conversations: [{ id: "c1" }] }, SERVER) as Record<
    string,
    unknown
  >;
  assert.equal("activeId" in catalog, false);
});
