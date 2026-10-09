import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { resolveListenHost } from "../src/agent/listen.ts";
import { RemoteServer } from "../src/main/server/server.ts";
import { setPassword } from "../src/main/server/store.ts";
import { registeredChannels } from "./registered-channels.ts";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const PASSWORD = "a-good-enough-password";
const TOKEN = "c".repeat(64);

test("the Agent listens on loopback unless it is asked, in exactly one way, not to", () => {
  assert.deepEqual(resolveListenHost(undefined), { host: "127.0.0.1", exposed: false });
  assert.deepEqual(resolveListenHost(""), { host: "127.0.0.1", exposed: false });
  assert.deepEqual(resolveListenHost("localhost"), { host: "127.0.0.1", exposed: false });
  assert.deepEqual(resolveListenHost("0.0.0.0"), { host: "0.0.0.0", exposed: true });
  // Not an arbitrary interface: the bootstrap and the preflight only know these two states.
  for (const bad of ["192.168.1.5", "::", "example.com", "0.0.0.0:7777"]) {
    assert.throws(() => resolveListenHost(bad), /监听地址无效/, bad);
  }
});

async function withAccessFile<T>(withPassword: boolean, fn: (accessFile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-listen-"));
  const accessFile = join(dir, "remote-access.json");
  if (withPassword) setPassword(accessFile, PASSWORD);
  try {
    return await fn(accessFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function serverFor(accessFile: string): RemoteServer {
  return new RemoteServer({
    accessFile,
    channels: () => registeredChannels(),
    dispatch: async (method) => ({ echoed: method }),
    subscribe: () => () => undefined,
    log: silent,
    loopbackToken: TOKEN,
    policyScope: "subset",
  });
}

test("the desktop's case is unchanged: loopback, a token and no password still starts", async () => {
  await withAccessFile(false, async (accessFile) => {
    const server = serverFor(accessFile);
    await server.start({ port: 0, host: "127.0.0.1" });
    await server.stop();
  });
});

test("listening beyond loopback needs a password; the loopback token alone is not enough", async () => {
  await withAccessFile(false, async (accessFile) => {
    await assert.rejects(serverFor(accessFile).start({ port: 0, host: "0.0.0.0" }), /必须先设置密码/);
  });
});

test("with a password set the Agent may listen beyond loopback, and a phone can log in", async () => {
  await withAccessFile(true, async (accessFile) => {
    const server = serverFor(accessFile);
    const { port } = await server.start({ port: 0, host: "0.0.0.0" });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD, label: "phone" }),
      });
      assert.equal(response.status, 200);
      assert.ok(((await response.json()) as { token?: string }).token);
    } finally {
      await server.stop();
    }
  });
});

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return undefined;
}

/** What a socket's first reply to an `auth` frame was, or the close code if it never got one. */
function authAttempt(url: string, token: string): Promise<{ ok: boolean } | { closed: number }> {
  return new Promise((settle, fail) => {
    const socket = new WebSocket(url);
    socket.once("error", fail);
    socket.once("open", () => socket.send(JSON.stringify({ type: "auth", token })));
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { type?: string; ok?: boolean };
      if (message.type === "auth") {
        settle({ ok: message.ok === true });
        socket.close();
      }
    });
    socket.once("close", (code) => settle({ closed: code }));
  });
}

// The security property the whole feature rests on. Once the server listens beyond
// loopback, the loopback token is a secret that must still only work for a client that
// actually *arrived* from loopback. Connecting to this machine's own LAN address makes the
// peer address the LAN address, not 127.0.0.1, which is what a phone looks like.
test("beyond loopback, the loopback token works from loopback and is refused from anywhere else", { skip: lanAddress() === undefined }, async () => {
  await withAccessFile(true, async (accessFile) => {
    const server = serverFor(accessFile);
    const { port } = await server.start({ port: 0, host: "0.0.0.0" });
    try {
      assert.deepEqual(await authAttempt(`ws://127.0.0.1:${port}/ws`, TOKEN), { ok: true }, "the desktop's SSH forward");
      const outside = await authAttempt(`ws://${lanAddress()}:${port}/ws`, TOKEN);
      assert.equal("ok" in outside && outside.ok, false, "a client from another address presenting the same token");
    } finally {
      await server.stop();
    }
  });
});
