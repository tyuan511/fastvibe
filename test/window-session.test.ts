import assert from "node:assert/strict";
import test from "node:test";
import {
  createAppServer,
  initAppServer,
  resetAppServerRuntime,
} from "../src/main/app-server/runtime.ts";
import { broadcast, subscriberCount } from "../src/main/ipc/broadcast.ts";
import { attachWindowSession, windowOrigin } from "../src/main/transport/window-session.ts";
import { ALL_SCOPES } from "../src/shared/app-protocol.ts";
import { Ipc } from "../src/shared/ipc.ts";

const identity = { serverInstanceId: "srv_window1", version: "0.7.0", platform: "darwin" };

function setup() {
  resetAppServerRuntime();
  const calls: Array<{ method: string; payload: unknown; origin?: string }> = [];
  const server = createAppServer({
    identity,
    channels: () => [Ipc.engineGetStatus, Ipc.settingsGet, Ipc.browserResponse],
  });
  initAppServer({
    dispatch: async (method, payload, context) => {
      calls.push({ method, payload, origin: context.origin });
      return { echoed: method, payload };
    },
  });
  return { server, calls };
}

test("windowOrigin is derived from the webContents id", () => {
  assert.equal(windowOrigin(3), "window:3");
});

test("handshake boots the wildcard subscription before call", async () => {
  const { server } = setup();
  try {
    const window = attachWindowSession(server, {
      origin: "window:1",
      sendToRenderer: () => undefined,
    });
    await window.ready;
    assert.equal(window.session.isSubscribed(ALL_SCOPES), true);
    assert.equal(window.session.handshaken, true);
    window.dispose();
  } finally {
    resetAppServerRuntime();
  }
});

test("calls are preserved through the window session", async () => {
  const { server, calls } = setup();
  try {
    const window = attachWindowSession(server, {
      origin: "window:1",
      window: { id: 1 },
      sendToRenderer: () => undefined,
    });
    const status = await window.call(Ipc.engineGetStatus, { a: 1 });
    assert.deepEqual(status, { echoed: Ipc.engineGetStatus, payload: { a: 1 } });
    const settings = await window.call(Ipc.settingsGet, { b: 2 });
    assert.deepEqual(settings, { echoed: Ipc.settingsGet, payload: { b: 2 } });
    assert.deepEqual(
      calls.map((item) => item.method),
      [Ipc.engineGetStatus, Ipc.settingsGet],
    );
    assert.equal(calls[0]?.origin, "window:1");
    window.dispose();
  } finally {
    resetAppServerRuntime();
  }
});

test("broadcast reaches the renderer exactly once; except skips the origin", async () => {
  const { server } = setup();
  try {
    const aSends: Array<{ channel: string; payload: unknown }> = [];
    const bSends: Array<{ channel: string; payload: unknown }> = [];
    const a = attachWindowSession(server, {
      origin: "window:1",
      sendToRenderer: (channel, payload) => aSends.push({ channel, payload }),
    });
    const b = attachWindowSession(server, {
      origin: "window:2",
      sendToRenderer: (channel, payload) => bSends.push({ channel, payload }),
    });
    await Promise.all([a.ready, b.ready]);
    const before = subscriberCount();

    broadcast("workspace:changed", { n: 1 });
    await waitUntil(() => aSends.length === 1 && bSends.length === 1, "both windows should see one event");
    assert.equal(aSends.length, 1);
    assert.equal(bSends.length, 1);
    assert.equal(aSends[0]?.channel, "workspace:changed");
    assert.deepEqual(aSends[0]?.payload, { n: 1 });
    assert.deepEqual(bSends[0]?.payload, { n: 1 });
    assert.equal(subscriberCount(), before, "window sessions are not broadcast subscribers");

    aSends.length = 0;
    bSends.length = 0;
    broadcast("workspace:changed", { n: 2 }, { except: "window:1" });
    await waitUntil(() => bSends.length === 1, "the other window should see the excepted event");
    assert.equal(aSends.length, 0);
    assert.equal(bSends.length, 1);
    assert.deepEqual(bSends[0]?.payload, { n: 2 });

    a.dispose();
    b.dispose();
  } finally {
    resetAppServerRuntime();
  }
});

test("dispose detaches; a closed window is not pushed again", async () => {
  const { server } = setup();
  try {
    const sends: Array<{ channel: string; payload: unknown }> = [];
    let closed = false;
    const window = attachWindowSession(server, {
      origin: "window:9",
      isClosed: () => closed,
      sendToRenderer: (channel, payload) => sends.push({ channel, payload }),
    });
    await window.ready;
    const count = server.sessionCount;
    window.dispose();
    assert.equal(server.sessionCount, count - 1);

    broadcast("workspace:changed", { n: 3 });
    await new Promise((settle) => setTimeout(settle, 40));
    assert.equal(sends.length, 0);

    closed = true;
    window.dispose();
  } finally {
    resetAppServerRuntime();
  }
});

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  throw new Error(message);
}
