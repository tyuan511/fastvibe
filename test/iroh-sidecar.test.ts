import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IrohSidecar, IrohSocket, irohSidecarBinary, type IrohSidecarEvent } from "../src/main/rtc/iroh-sidecar.ts";
import { splitFrame } from "../src/main/rtc/frames.ts";

test("iroh sidecar prefers the configured FastVibe resources root", () => {
  assert.equal(
    irohSidecarBinary({ FASTVIBE_RESOURCES_PATH: "/tmp/fastvibe-resources" }),
    join("/tmp/fastvibe-resources", "iroh", "fastvibe-iroh"),
  );
});

test("iroh sidecar honors an explicit binary override", () => {
  assert.equal(
    irohSidecarBinary({ FASTVIBE_IROH_BIN: "/tmp/custom-fastvibe-iroh", FASTVIBE_RESOURCES_PATH: "/tmp/resources" }),
    "/tmp/custom-fastvibe-iroh",
  );
});

test("iroh sidecar reports a useful missing-binary error", async () => {
  const previous = process.env.FASTVIBE_IROH_BIN;
  process.env.FASTVIBE_IROH_BIN = "/tmp/does-not-exist-fastvibe-iroh";
  const sidecar = new IrohSidecar();
  try {
    await assert.rejects(
      sidecar.identity("/tmp/fastvibe-identity.key"),
      /找不到 iroh transport.*FASTVIBE_IROH_BIN/,
    );
  } finally {
    if (previous === undefined) delete process.env.FASTVIBE_IROH_BIN;
    else process.env.FASTVIBE_IROH_BIN = previous;
    await sidecar.stop();
  }
});

test("iroh socket holds initial messages until authorized transport attachment", () => {
  const sidecar = new IrohSidecar();
  sidecar.closeConnection = () => {};
  const socket = new IrohSocket(sidecar, "early", true);
  const emit = (text: string) => {
    for (const frame of splitFrame(Buffer.from(text), false, false)) {
      sidecar.emit("event", { type: "data", connectionId: "early", data: frame.toString("base64") });
    }
  };
  emit("first hello");
  const messages: string[] = [];
  socket.on("message", (data: Buffer) => messages.push(data.toString()));
  emit("second message");
  assert.deepEqual(messages, []);
  socket.resumeMessages();
  emit("live message");
  assert.deepEqual(messages, ["first hello", "second message", "live message"]);
  socket.terminate();
  assert.equal(sidecar.listenerCount("event"), 0);
});

test("iroh socket discards unauthorized initial messages on termination", () => {
  const sidecar = new IrohSidecar();
  sidecar.closeConnection = () => {};
  const socket = new IrohSocket(sidecar, "denied", true);
  const frame = splitFrame(Buffer.from("hello"), false, false)[0];
  sidecar.emit("event", { type: "data", connectionId: "denied", data: frame.toString("base64") });
  socket.terminate();
  socket.on("message", () => assert.fail("closed socket released initial data"));
  socket.resumeMessages();
  assert.equal(sidecar.listenerCount("event"), 0);
});

test("the real listening sidecar reports UDP addresses before any relay is reachable", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-iroh-addresses-"));
  const sidecar = new IrohSidecar();
  const events: IrohSidecarEvent[] = [];
  sidecar.on("event", (event: IrohSidecarEvent) => events.push(event));
  sidecar.on("error", () => {});
  try {
    const endpointId = await sidecar.identity(join(dir, "endpoint.key"));
    await sidecar.startLease({
      relayId: "unreachable", url: "http://127.0.0.1:9", quicPort: 9, token: "test-only",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const started = events.find((event) => event.type === "started");
    assert.ok(started?.type === "started");
    assert.equal(started.endpointId, endpointId);
    assert.ok(Array.isArray(started.directAddresses), "rebuild the iroh sidecar to provide LAN address events");
    const deadline = Date.now() + 3_000;
    while (!events.some((event) => event.type === "addresses") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const update = events.find((event) => event.type === "addresses");
    assert.ok(update?.type === "addresses");
    assert.equal(update.endpointId, endpointId);
    assert.ok(Array.isArray(update.directAddresses));
    for (const address of update.directAddresses) {
      const url = new URL(`http://${address}`);
      assert.ok(Number(url.port) > 0 && Number(url.port) <= 65535);
      assert.notEqual(url.hostname, "0.0.0.0");
      assert.notEqual(url.hostname, "[::]");
    }
  } finally {
    await sidecar.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("local iroh sidecar stays alive when a queued send targets a closed connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fastvibe-iroh-sidecar-"));
  const previous = process.env.FASTVIBE_RESOURCES_PATH;
  process.env.FASTVIBE_RESOURCES_PATH = join(process.cwd(), "resources");
  const sidecar = new IrohSidecar();
  const globalErrors: Error[] = [];
  sidecar.on("error", (error: Error) => globalErrors.push(error));
  try {
    const endpointId = await sidecar.identity(join(dir, "endpoint.key"));
    assert.match(endpointId, /^[a-f0-9]{64}$/);
    await assert.rejects(sidecar.send("closed-peer", Buffer.from("queued")), /unknown connection/);
    assert.deepEqual(globalErrors, []);
    assert.equal(await sidecar.identity(join(dir, "endpoint.key")), endpointId);
  } finally {
    delete process.env.FASTVIBE_RESOURCES_PATH;
    if (previous !== undefined) process.env.FASTVIBE_RESOURCES_PATH = previous;
    await sidecar.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
