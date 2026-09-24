import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBindings, readProjectOrder, reorderProjectOrder, saveBinding } from "../src/main/remote/binding-store.ts";
import {
  RemoteGateway,
  type ConnectedServerRef,
  type GatewayConnections,
} from "../src/main/remote/gateway.ts";
import type { ProjectBinding } from "../src/shared/project-binding.ts";
import { bindingProjectKey, encodeRemoteConversationId } from "../src/shared/project-binding.ts";
import type { RemoteConnectionStatus } from "../src/shared/remote-connection.ts";
import type { RemoteHostProfile } from "../src/shared/remote-host.ts";
import { Ipc } from "../src/shared/ipc.ts";
import type { Conversation, Project, WorkspaceSnapshot } from "../src/shared/types.ts";

function bindingsFile(): string {
  return join(mkdtempSync(join(tmpdir(), "fastvibe-gateway-")), "bindings.json");
}

function profile(id: string): RemoteHostProfile {
  return { id, label: id, host: `${id}.example` };
}

function localProject(): Project {
  return { cwd: "/Users/me/local", name: "local", createdAt: 1, updatedAt: 1 };
}

function localConversation(): Conversation {
  return {
    id: "local-c1",
    title: "本地会话",
    cwd: "/Users/me/local",
    project: "/Users/me/local",
    createdAt: 1,
    updatedAt: 1,
  };
}

function localSnap(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    projects: [localProject()],
    conversations: [localConversation()],
    activeId: "local-c1",
    ...over,
  };
}

function binding(over: Partial<ProjectBinding> = {}): ProjectBinding {
  return {
    id: "bind_alpha",
    kind: "remote",
    name: "远程 A",
    connectionId: "host-a",
    serverInstanceId: "srv_alpha",
    remoteWorkspaceId: "/home/dev/app",
    remotePath: "/home/dev/app",
    createdAt: 2,
    ...over,
  };
}

type CallRecord = { server: string; method: string; payload: unknown };

function fakeConnections(options?: {
  servers?: ConnectedServerRef[];
  statuses?: RemoteConnectionStatus[];
  connectResult?: (profile: RemoteHostProfile) => ConnectedServerRef | Promise<ConnectedServerRef>;
  results?: Record<string, unknown>;
  errors?: Record<string, Error | string>;
}): GatewayConnections & { calls: CallRecord[]; connectCalls: string[] } {
  const servers = new Map((options?.servers ?? []).map((item) => [item.serverInstanceId, item]));
  const calls: CallRecord[] = [];
  const connectCalls: string[] = [];
  return {
    calls,
    connectCalls,
    async connect(item) {
      connectCalls.push(item.id);
      if (options?.connectResult) {
        const server = await options.connectResult(item);
        servers.set(server.serverInstanceId, server);
        return server;
      }
      const existing = [...servers.values()].find((server) => server.connectionId === item.id);
      if (existing) return existing;
      throw new Error(`no server for ${item.id}`);
    },
    statuses() {
      return options?.statuses ?? [...servers.values()].map((server) => ({
        connectionId: server.connectionId,
        serverInstanceId: server.serverInstanceId,
        state: "ready" as const,
        capabilities: server.capabilities,
      }));
    },
    async call(server, method, payload) {
      calls.push({ server: server.serverInstanceId, method, payload });
      if (options?.errors && method in options.errors) {
        const error = options.errors[method]!;
        throw error instanceof Error ? error : new Error(error);
      }
      if (options?.results && method in options.results) return options.results[method];
      return undefined;
    },
    serverForInstance(id) {
      return servers.get(id);
    },
    async listWorkspaces(server) {
      return [
        {
          serverInstanceId: server.serverInstanceId,
          workspaceId: "/home/dev/app",
          path: "/home/dev/app",
          name: "app",
        },
      ];
    },
  };
}

function gateway(over: {
  file?: string;
  local?: WorkspaceSnapshot;
  connections?: ReturnType<typeof fakeConnections>;
  profiles?: RemoteHostProfile[];
  localDispatch?: (method: string, payload: unknown, ctx: unknown) => Promise<unknown>;
} = {}) {
  const file = over.file ?? bindingsFile();
  const localCalls: Array<{ method: string; payload: unknown }> = [];
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  const connections = over.connections ?? fakeConnections();
  const instance = new RemoteGateway({
    localDispatch: over.localDispatch
      ?? (async (method, payload) => {
        localCalls.push({ method, payload });
        return over.local ?? localSnap();
      }),
    localSnapshot: () => over.local ?? localSnap(),
    localAgentConfig: () => ({}),
    connections,
    bindingsFile: file,
    profiles: () => over.profiles ?? [profile("host-a"), profile("host-b")],
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
  });
  return { instance, file, localCalls, broadcasts, connections };
}

test("startup connects bound servers in parallel once each and publishes their catalogs without navigating", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  saveBinding(file, binding({ id: "bind_alpha_2", remoteWorkspaceId: "/other" }));
  saveBinding(file, binding({ id: "bind_beta", connectionId: "host-b", serverInstanceId: "srv_beta" }));
  const pending = new Map<string, (server: ConnectedServerRef) => void>();
  const connections = fakeConnections({
    connectResult: (profile) => new Promise((resolve) => { pending.set(profile.id, resolve); }),
    results: {
      [Ipc.conversationsList]: {
        projects: [{ cwd: "/home/dev/app" }],
        conversations: [{ ...localConversation(), id: "remote-chat", project: "/home/dev/app", cwd: "/home/dev/app" }],
        activeId: "remote-chat",
      },
    },
  });
  const { instance, broadcasts, localCalls } = gateway({ file, connections });
  const restore = instance.restoreBoundServers();
  // Both attempts start before either handshake completes; two projects on A share it.
  assert.deepEqual(connections.connectCalls, ["host-a", "host-b"]);
  pending.get("host-a")!({ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["conversations"] });
  pending.get("host-b")!({ connectionId: "host-b", serverInstanceId: "srv_beta", capabilities: ["conversations"] });
  assert.deepEqual(await restore, []);
  assert.deepEqual(localCalls, []);
  assert.ok(connections.calls.every((call) => call.method === Ipc.conversationsList));
  assert.equal(broadcasts.length, 2);
  for (const push of broadcasts) {
    assert.equal(push.channel, Ipc.workspaceChanged);
    assert.equal((push.payload as WorkspaceSnapshot).activeId, "local-c1");
  }
  assert.deepEqual(instance.aggregate(localSnap()).conversations.map((item) => item.id), [
    "local-c1", "remote:srv_alpha:remote-chat", "remote:srv_beta:remote-chat",
  ]);
});

test("startup failure on one host does not prevent another bound server from connecting", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  saveBinding(file, binding({ id: "bind_beta", connectionId: "host-b", serverInstanceId: "srv_beta" }));
  const connections = fakeConnections({
    connectResult: (profile) => {
      if (profile.id === "host-a") throw new Error("offline");
      return { connectionId: profile.id, serverInstanceId: "srv_beta", capabilities: [] };
    },
  });
  const { instance, broadcasts } = gateway({ file, connections });
  assert.deepEqual(await instance.restoreBoundServers(), [{ serverInstanceId: "srv_alpha", error: "offline" }]);
  assert.deepEqual(connections.connectCalls, ["host-a", "host-b"]);
  assert.equal(broadcasts.length, 1);
  assert.equal(readBindings(file).length, 2);
});

test("startup never connects saved hosts without bound projects", async () => {
  const { instance, connections } = gateway({ profiles: [profile("host-a"), profile("host-b")] });
  assert.deepEqual(await instance.restoreBoundServers(), []);
  assert.deepEqual(connections.connectCalls, []);
});

test("startup retains server identity checks before fetching a catalog", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    connectResult: () => ({ connectionId: "host-a", serverInstanceId: "srv_wrong", capabilities: [] }),
  });
  const { instance } = gateway({ file, connections });
  const failures = await instance.restoreBoundServers();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].serverInstanceId, "srv_alpha");
  assert.deepEqual(connections.calls, []);
});

test("remote turn refreshes never read the host's local active conversation", async () => {
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
    results: {
      [Ipc.engineGetMessages]: [{ id: "remote-message", role: "assistant", text: "remote reply" }],
      [Ipc.engineGetState]: { conversationId: "chat-1", isStreaming: false },
      [Ipc.engineGetStats]: { cost: 0.12 },
    },
  });
  const { instance, localCalls } = gateway({ connections });
  const conversationId = encodeRemoteConversationId("srv_alpha", "chat-1");
  const messages = await instance.dispatch(Ipc.engineGetMessages, { conversationId }, {});
  const state = await instance.dispatch(Ipc.engineGetState, { conversationId }, {});
  const stats = await instance.dispatch(Ipc.engineGetStats, { conversationId }, {});
  assert.deepEqual(localCalls, []);
  assert.deepEqual(connections.calls.map((call) => call.payload), Array(3).fill({ conversationId: "chat-1" }));
  assert.deepEqual(messages, [{ id: "remote-message", role: "assistant", text: "remote reply" }]);
  assert.deepEqual(state, { conversationId, isStreaming: false });
  assert.deepEqual(stats, { cost: 0.12 });
});

test("all session-state replies restore the remote namespace, while branch messages stay intact", async () => {
  const methods = [Ipc.engineGetState, Ipc.engineSetModel, Ipc.engineSetThinking,
    Ipc.engineSetInterrupt, Ipc.engineSetAutoCompact, Ipc.engineSetSteering,
    Ipc.engineSetFollowUp, Ipc.engineCompact];
  const messages = [{ id: "entry-1", role: "assistant", text: "unchanged" }];
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
    results: {
      ...Object.fromEntries(methods.map((method) => [method, { conversationId: "chat-1", cwd: "/srv/app", isStreaming: false }])),
      [Ipc.engineBranch]: messages,
    },
  });
  const { instance } = gateway({ connections });
  const conversationId = "remote:srv_alpha:chat-1";
  for (const method of methods) {
    assert.deepEqual(await instance.dispatch(method, { conversationId }, {}), {
      conversationId, cwd: "remote:srv_alpha:/srv/app", isStreaming: false,
    }, method);
  }
  assert.deepEqual(await instance.dispatch(Ipc.engineBranch, { conversationId }, {}), messages);
});

test("local rename events retain remote catalog rows and their keyed UI state", () => {
  const { instance, file, broadcasts } = gateway();
  saveBinding(file, binding());
  instance.acceptRemotePush(Ipc.workspaceChanged, {
    projects: [{ cwd: "/home/dev/app" }],
    conversations: [{ ...localConversation(), id: "chat-1", project: "/home/dev/app", cwd: "/home/dev/app" }],
  }, "srv_alpha");
  broadcasts.length = 0;
  instance.publishLocalEvent({ type: "conversation_renamed", conversationId: "local-c1", snapshot: localSnap() });
  const event = broadcasts[0].payload as { snapshot: WorkspaceSnapshot };
  assert.equal(broadcasts[0].channel, Ipc.event);
  assert.deepEqual(event.snapshot.conversations.map((item) => item.id), ["local-c1", "remote:srv_alpha:chat-1"]);
  assert.equal(event.snapshot.projects.length, 2);
});

test("subagent snapshots keep their owner conversation namespaced", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
    results: {
      [Ipc.engineGetSubagents]: [
        { id: "tool:0", conversationId: "chat-1", status: "completed" },
        { id: "tool:1", status: "running" },
      ],
    },
  });
  const { instance } = gateway({ file, connections });
  const remoteId = encodeRemoteConversationId("srv_alpha", "chat-1");
  const result = await instance.dispatch(Ipc.engineGetSubagents, { conversationId: remoteId }, {});
  assert.deepEqual(result, [
    { id: "tool:0", conversationId: remoteId, status: "completed" },
    { id: "tool:1", status: "running" },
  ]);
  assert.deepEqual(connections.calls[0], {
    server: "srv_alpha",
    method: Ipc.engineGetSubagents,
    payload: { conversationId: "chat-1" },
  });
});

test("two servers plus local: aggregate lists every bound row and keeps the local catalog", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  saveBinding(file, binding({
    id: "bind_beta",
    name: "远程 B",
    connectionId: "host-b",
    serverInstanceId: "srv_beta",
    remoteWorkspaceId: "/srv/other",
    remotePath: "/srv/other",
  }));
  const connections = fakeConnections({
    servers: [
      { connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine", "workspace"] },
      { connectionId: "host-b", serverInstanceId: "srv_beta", capabilities: ["engine"] },
    ],
  });
  const { instance } = gateway({ file, connections });

  instance.acceptRemotePush(Ipc.workspaceChanged, {
    conversations: [
      { id: "remote:srv_alpha:ca", title: "A", cwd: "remote:srv_alpha:/home/dev/app", project: "remote:srv_alpha:/home/dev/app", createdAt: 1, updatedAt: 1 },
      { id: "remote:srv_alpha:unbound", title: "其他项目", cwd: "remote:srv_alpha:/tmp/other", project: "remote:srv_alpha:/tmp/other", createdAt: 1, updatedAt: 1 },
    ],
    projects: [{ cwd: "remote:srv_alpha:/home/dev/app", name: "app" }],
  });
  instance.acceptRemotePush(Ipc.workspaceChanged, {
    conversations: [
      { id: "remote:srv_beta:cb", title: "B", cwd: "remote:srv_beta:/srv/other", project: "remote:srv_beta:/srv/other", createdAt: 1, updatedAt: 1 },
    ],
    projects: [{ cwd: "remote:srv_beta:/srv/other", name: "other" }],
  });

  const snapshot = await instance.dispatch(Ipc.conversationsList, undefined, { kind: "window" }) as WorkspaceSnapshot;
  assert.equal(snapshot.activeId, "local-c1");
  assert.deepEqual(
    snapshot.projects.map((item) => item.cwd),
    ["/Users/me/local", "remote:srv_alpha:/home/dev/app", "remote:srv_beta:/srv/other"],
  );
  assert.deepEqual(
    snapshot.conversations.map((item) => item.id),
    ["local-c1", "remote:srv_alpha:ca", "remote:srv_beta:cb"],
  );
  const remoteA = snapshot.projects.find((item) => item.cwd === "remote:srv_alpha:/home/dev/app") as {
    bindingState?: string;
    capabilities?: string[];
    kind?: string;
  };
  assert.equal(remoteA?.kind, "remote");
  assert.equal(remoteA?.bindingState, "available");
  assert.deepEqual(remoteA?.capabilities, ["engine", "workspace"]);
});

test("an offline binding stays in the list, marked, and does not replace local projects", () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({ servers: [], statuses: [] });
  const { instance } = gateway({ file, connections });
  const snapshot = instance.aggregate(localSnap());
  assert.equal(snapshot.activeId, "local-c1");
  assert.equal(snapshot.conversations.length, 1);
  assert.equal(snapshot.conversations[0]!.id, "local-c1");
  const remote = snapshot.projects.find((item) => item.cwd === bindingProjectKey(binding()));
  assert.ok(remote);
  assert.equal((remote as { bindingState?: string }).bindingState, "offline");
  assert.equal("capabilities" in (remote as object) ? (remote as { capabilities?: unknown }).capabilities : undefined, undefined);
  assert.equal(snapshot.projects[0]!.cwd, "/Users/me/local");
});

test("lazy reconnect refuses a profile whose handshake identity does not match the binding", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [],
    connectResult: () => ({ connectionId: "host-a", serverInstanceId: "srv_other", capabilities: ["engine"] }),
  });
  const { instance } = gateway({ file, connections, profiles: [profile("host-a")] });
  await assert.rejects(
    () => instance.dispatch(Ipc.conversationsOpen, { id: encodeRemoteConversationId("srv_alpha", "c1") }, {}),
    /远程服务器身份不匹配/,
  );
  assert.deepEqual(connections.connectCalls, ["host-a"]);
  assert.equal(connections.calls.length, 0);
});

test("remote rename and unbind stay local — the remote workspace is not deleted", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
  });
  const localDispatch = async () => {
    throw new Error("local catalog must not see a remote binding path");
  };
  const { instance } = gateway({ file, connections, localDispatch });
  const key = bindingProjectKey(binding());

  const renamed = await instance.dispatch(Ipc.projectsRename, { cwd: key, name: "本地别名" }, {}) as WorkspaceSnapshot;
  assert.equal(renamed.projects.find((item) => item.cwd === key)?.name, "本地别名");
  assert.equal(connections.calls.some((item) => item.method === Ipc.projectsRename), false);

  instance.acceptRemotePush(Ipc.workspaceChanged, {
    conversations: [
      { id: "remote:srv_alpha:ca", title: "A", cwd: key, project: key, createdAt: 1, updatedAt: 1 },
    ],
    projects: [{ cwd: key, name: "app" }],
  });
  const removed = await instance.dispatch(Ipc.projectsRemove, { cwd: key }, {}) as WorkspaceSnapshot;
  assert.equal(removed.projects.some((item) => item.cwd === key), false);
  assert.equal(removed.conversations.some((item) => item.id === "remote:srv_alpha:ca"), false);
  assert.equal(removed.projects[0]!.cwd, "/Users/me/local");
  assert.equal(connections.calls.some((item) => item.method === Ipc.projectsRemove), false);
  assert.equal(connections.calls.some((item) => item.method === Ipc.projectsAddRemote), false);
});

test("projects:add-remote persists a binding and does not add the remote path to the local catalog", async () => {
  const file = bindingsFile();
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
    results: {
      [Ipc.projectsAddRemote]: { project: { cwd: "/home/dev/app", name: "app" }, projects: [], conversations: [] },
      [Ipc.conversationsList]: { projects: [{ cwd: "/home/dev/app", name: "app" }], conversations: [] },
    },
  });
  const localCalls: string[] = [];
  const { instance } = gateway({
    file,
    connections,
    localDispatch: async (method) => {
      localCalls.push(method);
      throw new Error(`local ${method} should not run for a remote bind`);
    },
  });
  const result = await instance.dispatch(
    Ipc.projectsAddRemote,
    { cwd: "/home/dev/app", hostId: "host-a", serverInstanceId: "srv_alpha", name: "远程 A" },
    {},
  ) as { project?: Project; projects: Project[] };
  assert.equal(result.project?.cwd, "remote:srv_alpha:/home/dev/app");
  assert.equal(result.project?.name, "远程 A");
  assert.equal(localCalls.length, 0);
  assert.ok(connections.calls.some((item) => item.method === Ipc.projectsAddRemote && (item.payload as { cwd?: string }).cwd === "/home/dev/app"));
  assert.equal(result.projects.some((item) => item.cwd === "/home/dev/app"), false);
});

test("nested snapshot ids are namespaced; message ids are left alone", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
    results: {
      [Ipc.engineGetSnapshot]: {
        conversationId: "c1",
        messages: [{ id: "msg-keep", role: "assistant", text: "hi" }],
        running: true,
        pendingUi: [{ type: "extension_ui_request", id: "prompt-1", conversationId: "c1", method: "confirm" }],
        turnEvents: [{ type: "notice", conversationId: "c1", text: "wait" }],
        overflowed: false,
        seq: 9,
      },
      [Ipc.conversationsOpen]: {
        projects: [{ cwd: "/home/dev/app", name: "app", createdAt: 1, updatedAt: 1 }],
        conversations: [{ id: "c1", title: "远程", cwd: "/home/dev/app", project: "/home/dev/app", createdAt: 1, updatedAt: 1 }],
        activeId: "c1",
        conversation: { id: "c1", title: "远程", cwd: "/home/dev/app", project: "/home/dev/app", createdAt: 1, updatedAt: 1 },
        messages: [{ id: "msg-keep", role: "user", text: "go" }],
        state: { conversationId: "c1", cwd: "/home/dev/app", isStreaming: false },
        status: { state: "ready" },
      },
      [Ipc.engineGetState]: { conversationId: "c1", cwd: "/home/dev/app", isStreaming: false },
      [Ipc.workspaceTerminalStart]: { id: "term-1", cwd: "/home/dev/app" },
      [Ipc.workspacePreview]: { kind: "code", path: "/home/dev/app/a.ts", name: "a.ts", language: "ts", text: "x" },
      [Ipc.workspaceReadDir]: [{ name: "a.ts", path: "/home/dev/app/a.ts", kind: "file" }],
      [Ipc.engineGetRunning]: ["c1", "c2"],
      "engine:prompt": { id: "tool-should-not-walk", messages: [{ id: "msg-keep" }] },
    },
  });
  const { instance } = gateway({ file, connections });
  const id = encodeRemoteConversationId("srv_alpha", "c1");

  const snapshot = await instance.dispatch(Ipc.engineGetSnapshot, { conversationId: id }, {}) as Record<string, unknown>;
  assert.equal(snapshot.conversationId, id);
  assert.equal((snapshot.messages as Array<{ id: string }>)[0]!.id, "msg-keep");
  assert.equal((snapshot.pendingUi as Array<{ conversationId: string; id: string }>)[0]!.conversationId, id);
  assert.equal((snapshot.pendingUi as Array<{ id: string }>)[0]!.id, "remote:srv_alpha:prompt-1");
  assert.equal((snapshot.turnEvents as Array<{ conversationId: string }>)[0]!.conversationId, id);

  const opened = await instance.dispatch(Ipc.conversationsOpen, { id }, {}) as {
    conversation: Conversation;
    messages: Array<{ id: string }>;
    state: { conversationId?: string; cwd?: string };
    projects: Project[];
    conversations: Conversation[];
    activeId?: string;
  };
  assert.equal(opened.conversation.id, id);
  assert.equal(opened.conversation.project, "remote:srv_alpha:/home/dev/app");
  assert.equal(opened.messages[0]!.id, "msg-keep");
  assert.equal(opened.state.conversationId, id);
  assert.equal(opened.state.cwd, "remote:srv_alpha:/home/dev/app");
  assert.equal(opened.projects.some((item) => item.cwd === "/Users/me/local"), true);
  assert.equal(opened.projects.some((item) => item.cwd === "/home/dev/app"), false);
  assert.equal(opened.conversations.some((item) => item.id === id), true);
  assert.equal(opened.conversations.some((item) => item.id === "local-c1"), true);

  const state = await instance.dispatch(Ipc.engineGetState, { conversationId: id }, {}) as { conversationId: string; cwd: string };
  assert.equal(state.conversationId, id);
  assert.equal(state.cwd, "remote:srv_alpha:/home/dev/app");

  const terminal = await instance.dispatch(Ipc.workspaceTerminalStart, { cwd: "remote:srv_alpha:/home/dev/app" }, {}) as { id: string; cwd: string };
  assert.equal(terminal.id, "remote:srv_alpha:term-1");
  assert.equal(terminal.cwd, "remote:srv_alpha:/home/dev/app");

  const preview = await instance.dispatch(Ipc.workspacePreview, { path: "remote:srv_alpha:/home/dev/app/a.ts" }, {}) as { path: string };
  assert.equal(preview.path, "remote:srv_alpha:/home/dev/app/a.ts");

  const entries = await instance.dispatch(Ipc.workspaceReadDir, { path: "remote:srv_alpha:/home/dev/app" }, {}) as Array<{ path: string }>;
  assert.equal(entries[0]!.path, "remote:srv_alpha:/home/dev/app/a.ts");

  const running = await instance.dispatch(Ipc.engineGetRunning, { conversationId: id }, {}) as string[];
  assert.deepEqual(running, [id, encodeRemoteConversationId("srv_alpha", "c2")]);

  const unknown = await instance.dispatch("engine:prompt", { conversationId: id }, {}) as { id: string; messages: Array<{ id: string }> };
  assert.equal(unknown.id, "tool-should-not-walk");
  assert.equal(unknown.messages[0]!.id, "msg-keep");
});

test("a late remote catalog push cannot override the local active conversation", () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
  });
  const { instance, broadcasts } = gateway({ file, connections });

  instance.acceptRemotePush(Ipc.workspaceChanged, {
    activeId: "remote:srv_alpha:ca",
    conversations: [
      { id: "remote:srv_alpha:ca", title: "A", cwd: "remote:srv_alpha:/home/dev/app", project: "remote:srv_alpha:/home/dev/app", createdAt: 1, updatedAt: 1 },
    ],
    projects: [{ cwd: "remote:srv_alpha:/home/dev/app", name: "app" }],
  });

  const catalogPushes = broadcasts.filter((item) => item.channel === Ipc.workspaceChanged);
  assert.equal(catalogPushes.length, 1);
  const snapshot = catalogPushes[0]!.payload as WorkspaceSnapshot;
  assert.equal(snapshot.activeId, "local-c1");
  assert.ok(snapshot.conversations.some((item) => item.id === "local-c1"));
  assert.ok(snapshot.conversations.some((item) => item.id === "remote:srv_alpha:ca"));

  instance.acceptRemotePush(Ipc.event, {
    type: "conversation_renamed",
    conversationId: "remote:srv_alpha:ca",
    snapshot: {
      activeId: "remote:srv_alpha:ca",
      conversations: [{ id: "remote:srv_alpha:ca", cwd: "remote:srv_alpha:/home/dev/app", project: "remote:srv_alpha:/home/dev/app", createdAt: 1, updatedAt: 1 }],
      projects: [],
    },
  });
  assert.equal(broadcasts.filter((item) => item.channel === Ipc.workspaceChanged).length, 1);
  const event = broadcasts.find((item) => item.channel === Ipc.event);
  assert.ok(event);
  const merged = (event!.payload as { snapshot: WorkspaceSnapshot }).snapshot;
  assert.equal(merged.activeId, "local-c1");
  assert.ok(merged.conversations.some((item) => item.id === "local-c1"));
  assert.ok(merged.conversations.some((item) => item.id === "remote:srv_alpha:ca"));
  assert.ok(merged.projects.some((item) => item.cwd === "/Users/me/local"));
  instance.acceptRemotePush(Ipc.event, { type: "conversation_opened", conversationId: "remote:srv_alpha:ca" });
  assert.equal(broadcasts.filter((item) => item.channel === Ipc.event).length, 1);
});

test("projects:add-remote without a remote ref throws and does not add a local path", async () => {
  const localCalls: Array<{ method: string; payload: unknown }> = [];
  const { instance, file } = gateway({
    localDispatch: async (method, payload) => {
      localCalls.push({ method, payload });
      return localSnap();
    },
  });
  await assert.rejects(
    () => instance.dispatch(Ipc.projectsAddRemote, { cwd: "/mnt/nas/app" }, {}),
    /主机或服务器标识/,
  );
  assert.equal(localCalls.length, 0);
  assert.equal(readBindings(file).length, 0);
});

test("projects:add-remote does not save a binding when workspace registration fails", async () => {
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
    errors: { [Ipc.projectsAddRemote]: "path refused" },
  });
  const { instance, file } = gateway({ file: bindingsFile(), connections });
  await assert.rejects(
    () => instance.dispatch(Ipc.projectsAddRemote, { cwd: "/home/dev/app", hostId: "host-a", serverInstanceId: "srv_alpha" }, {}),
    /path refused/,
  );
  assert.equal(readBindings(file).length, 0);
  assert.equal(instance.aggregate(localSnap()).projects.some((item) => item.cwd.startsWith("remote:")), false);
});

test("projects:add-remote does not fabricate a connectionId from the expected server", async () => {
  const { instance, file } = gateway({ profiles: [] });
  await assert.rejects(
    () => instance.dispatch(Ipc.projectsAddRemote, { cwd: "/home/dev/app", serverInstanceId: "srv_alpha" }, {}),
    /找不到远程主机配置/,
  );
  assert.equal(readBindings(file).length, 0);
});

test("an empty remote catalog push needs an explicit server id", () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
  });
  const { instance } = gateway({ file, connections });
  const key = bindingProjectKey(binding());
  instance.acceptRemotePush(Ipc.workspaceChanged, {
    conversations: [{ id: "remote:srv_alpha:ca", title: "A", cwd: key, project: key, createdAt: 1, updatedAt: 1 }],
    projects: [{ cwd: key, name: "app" }],
  });
  assert.equal(instance.aggregate(localSnap()).conversations.some((item) => item.id === "remote:srv_alpha:ca"), true);

  instance.acceptRemotePush(Ipc.workspaceChanged, { conversations: [], projects: [] });
  assert.equal(instance.aggregate(localSnap()).conversations.some((item) => item.id === "remote:srv_alpha:ca"), true);

  instance.acceptNamespacedRemotePush(Ipc.workspaceChanged, { conversations: [], projects: [] }, "srv_alpha");
  assert.equal(instance.aggregate(localSnap()).conversations.some((item) => item.id === "remote:srv_alpha:ca"), false);
  assert.equal(instance.aggregate(localSnap()).projects.some((item) => item.cwd === key), true);
});

test("acceptRemotePush does not double-prefix an already namespaced catalog", () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
  });
  const { instance } = gateway({ file, connections });
  const key = bindingProjectKey(binding());
  instance.acceptRemotePush(
    Ipc.workspaceChanged,
    {
      conversations: [{ id: "remote:srv_alpha:ca", title: "A", cwd: key, project: key, createdAt: 1, updatedAt: 1 }],
      projects: [{ cwd: key, name: "app" }],
    },
    "srv_alpha",
    true,
  );
  const snapshot = instance.aggregate(localSnap());
  assert.equal(snapshot.conversations.some((item) => item.id === "remote:srv_alpha:ca"), true);
  assert.equal(snapshot.conversations.some((item) => item.id.includes("remote:srv_alpha:remote:")), false);
});

test("refreshServer fetches the remote catalog after connect", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
    results: {
      [Ipc.conversationsList]: {
        projects: [{ cwd: "/home/dev/app", name: "app" }],
        conversations: [{ id: "ca", title: "A", cwd: "/home/dev/app", project: "/home/dev/app", createdAt: 1, updatedAt: 1 }],
      },
    },
  });
  const { instance, broadcasts } = gateway({ file, connections });
  await instance.refreshServer("srv_alpha");
  assert.ok(connections.calls.some((item) => item.method === Ipc.conversationsList));
  const snapshot = instance.aggregate(localSnap());
  assert.equal(snapshot.conversations.some((item) => item.id === encodeRemoteConversationId("srv_alpha", "ca")), true);
  assert.ok(broadcasts.some((item) => item.channel === Ipc.workspaceChanged));
});

test("lazy reconnect refreshes the remote catalog", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [],
    connectResult: () => ({ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }),
    results: {
      [Ipc.conversationsList]: {
        projects: [{ cwd: "/home/dev/app", name: "app" }],
        conversations: [{ id: "ca", title: "A", cwd: "/home/dev/app", project: "/home/dev/app", createdAt: 1, updatedAt: 1 }],
      },
      [Ipc.conversationsOpen]: {
        projects: [{ cwd: "/home/dev/app", name: "app", createdAt: 1, updatedAt: 1 }],
        conversations: [{ id: "ca", title: "A", cwd: "/home/dev/app", project: "/home/dev/app", createdAt: 1, updatedAt: 1 }],
        conversation: { id: "ca", title: "A", cwd: "/home/dev/app", project: "/home/dev/app", createdAt: 1, updatedAt: 1 },
        messages: [],
        state: { conversationId: "ca", cwd: "/home/dev/app", isStreaming: false },
        status: { state: "ready" },
      },
    },
  });
  const { instance } = gateway({ file, connections, profiles: [profile("host-a")] });
  const id = encodeRemoteConversationId("srv_alpha", "ca");
  const opened = await instance.dispatch(Ipc.conversationsOpen, { id }, {}) as {
    conversations: Conversation[];
    conversation: Conversation;
  };
  assert.deepEqual(connections.connectCalls, ["host-a"]);
  assert.ok(connections.calls.some((item) => item.method === Ipc.conversationsList));
  assert.equal(opened.conversation.id, id);
  assert.equal(opened.conversations.some((item) => item.id === id), true);
});

test("permission respond routes by namespaced id and unscopes it", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
  });
  const { instance } = gateway({ file, connections });
  await instance.dispatch(
    Ipc.enginePermissionRespond,
    { id: encodeRemoteConversationId("srv_alpha", "prompt-1"), confirmed: true },
    {},
  );
  assert.equal(connections.calls.length, 1);
  assert.equal(connections.calls[0]!.method, Ipc.enginePermissionRespond);
  assert.deepEqual(connections.calls[0]!.payload, { id: "prompt-1", confirmed: true });
});

test("a fork of a remote conversation is routed there and comes back namespaced", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const forked = { id: "c2", title: "远程（分叉）", cwd: "/home/dev/app", project: "/home/dev/app", createdAt: 2, updatedAt: 2 };
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
    results: {
      [Ipc.engineFork]: {
        projects: [{ cwd: "/home/dev/app", name: "app", createdAt: 1, updatedAt: 1 }],
        conversations: [forked],
        activeId: "c2",
        conversation: forked,
        messages: [{ id: "msg-keep", role: "assistant", text: "hi" }],
        state: { conversationId: "c2", cwd: "/home/dev/app", isStreaming: false },
        status: { state: "ready" },
      },
    },
  });
  const { instance } = gateway({ file, connections });
  const opened = await instance.dispatch(
    Ipc.engineFork,
    { entryId: "entry-1", conversationId: encodeRemoteConversationId("srv_alpha", "c1") },
    {},
  ) as { conversation: Conversation; messages: Array<{ id: string }>; state: { conversationId?: string } };

  assert.equal(connections.calls.length, 1);
  assert.equal(connections.calls[0]!.method, Ipc.engineFork);
  assert.deepEqual(connections.calls[0]!.payload, { entryId: "entry-1", conversationId: "c1" });
  const id = encodeRemoteConversationId("srv_alpha", "c2");
  assert.equal(opened.conversation.id, id);
  assert.equal(opened.conversation.project, "remote:srv_alpha:/home/dev/app");
  assert.equal(opened.state.conversationId, id);
  assert.equal(opened.messages[0]!.id, "msg-keep");
});

test("extra conversationId routes a subagent abort without rewriting tool ids", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
  });
  const { instance } = gateway({ file, connections });
  await instance.dispatch(
    Ipc.engineAbortSubagent,
    { subagentId: "call-1:0", conversationId: encodeRemoteConversationId("srv_alpha", "c1") },
    {},
  );
  assert.equal(connections.calls.length, 1);
  assert.equal(connections.calls[0]!.method, Ipc.engineAbortSubagent);
  assert.deepEqual(connections.calls[0]!.payload, { subagentId: "call-1:0", conversationId: "c1" });
});

test("terminal-data is namespaced and relayed", () => {
  const { instance, broadcasts } = gateway();
  instance.acceptRemotePush(Ipc.workspaceTerminalData, { id: "term-1", data: "hi" }, "srv_alpha");
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0]!.channel, Ipc.workspaceTerminalData);
  assert.deepEqual(broadcasts[0]!.payload, { id: "remote:srv_alpha:term-1", data: "hi" });
});

test("unknown remote pushes are dropped", () => {
  const { instance, broadcasts } = gateway();
  instance.acceptRemotePush("future:channel", { conversationId: "c1" }, "srv_alpha");
  assert.equal(broadcasts.length, 0);
});

test("local conversation cannot be moved onto a remote project", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const connections = fakeConnections({
    servers: [{ connectionId: "host-a", serverInstanceId: "srv_alpha", capabilities: ["engine"] }],
  });
  const localCalls: string[] = [];
  const { instance } = gateway({
    file,
    connections,
    localDispatch: async (method) => {
      localCalls.push(method);
      return localSnap();
    },
  });
  await assert.rejects(
    () => instance.dispatch(Ipc.conversationsSetProject, { id: "local-c1", project: bindingProjectKey(binding()) }, {}),
    /不能把会话移到另一台服务器的项目/,
  );
  assert.equal(localCalls.length, 0);
  assert.equal(connections.calls.length, 0);
});

test("unbound namespaced rename and remove never touch the local catalog", async () => {
  const localCalls: string[] = [];
  const { instance } = gateway({
    localDispatch: async (method) => {
      localCalls.push(method);
      throw new Error("local fs must not see an unbound remote key");
    },
  });
  const key = bindingProjectKey(binding());
  await assert.rejects(() => instance.dispatch(Ipc.projectsRename, { cwd: key, name: "x" }, {}), /未绑定的远程项目/);
  await assert.rejects(() => instance.dispatch(Ipc.projectsRemove, { cwd: key }, {}), /未绑定的远程项目/);
  assert.equal(localCalls.length, 0);
});

test("mixed project reorder persists the complete local sidebar order", async () => {
  const file = bindingsFile();
  saveBinding(file, binding());
  const localCalls: unknown[] = [];
  const { instance } = gateway({
    file,
    localDispatch: async (method, payload) => {
      localCalls.push({ method, payload });
      return localSnap();
    },
  });
  const key = bindingProjectKey(binding());
  await instance.dispatch(Ipc.projectsReorder, { cwds: [key, "/Users/me/local"] }, {});
  assert.deepEqual(localCalls, [{ method: Ipc.projectsReorder, payload: { cwds: ["/Users/me/local"] } }]);
  const snapshot = instance.aggregate(localSnap());
  assert.deepEqual(snapshot.projects.map((item) => item.cwd), [key, "/Users/me/local"]);
});

test("local project reorder refreshes a stale mixed-order file before overlaying the result", async () => {
  const file = bindingsFile();
  const first = localProject();
  const second: Project = { cwd: "/Users/me/second", name: "second", createdAt: 2, updatedAt: 2 };
  // Simulate the order file left behind by an earlier remote binding after that
  // binding was removed.
  reorderProjectOrder(file, [first.cwd, second.cwd]);
  const localBefore: WorkspaceSnapshot = {
    projects: [first, second],
    conversations: [localConversation()],
    activeId: "local-c1",
  };
  const { instance } = gateway({
    file,
    localDispatch: async () => ({ ...localBefore, projects: [second, first] }),
  });
  // The stale record contains an order that disagrees with the local catalog reply.
  // Calling reorder must replace it before the gateway overlays the result.
  await instance.dispatch(Ipc.projectsReorder, { cwds: [second.cwd, first.cwd] }, {});
  assert.deepEqual(readProjectOrder(file), [second.cwd, first.cwd]);
  assert.deepEqual(instance.aggregate({ ...localBefore, projects: [second, first] }).projects.map((item) => item.cwd), [second.cwd, first.cwd]);
});
