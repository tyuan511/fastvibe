import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ImageGenerationService } from "../src/main/images/service.ts";
import { openDatabase } from "../src/main/engine/db.ts";
import type { FastVibePaths } from "../src/main/engine/paths.ts";
import type { ImageConfig, ImageProtocol } from "../src/shared/image-generation.ts";
import { readBounded } from "../src/main/images/assets.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const imageResponse = { data: [{ b64_json: PNG.toString("base64") }] };
const reference = { data: PNG.toString("base64"), mimeType: "image/png", name: "reference.png" };

async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>, protocol: ImageProtocol = "openai", extra: { fetch?: typeof fetch; resolveProviderKey?: (id: string) => Promise<string | undefined> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-images-test-"));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    try { await handler(req, res, Buffer.concat(chunks)); }
    catch (error) { res.writeHead(500).end(JSON.stringify({ error: { message: String(error) } })); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const paths = { userData: dir, runtimeRoot: join(dir, "runtime"), databaseFile: join(dir, "fastvibe.db") } as FastVibePaths;
  const events: number[] = [];
  const config: ImageConfig = {
    defaultModelId: "provider-a/test-image",
    models: [{ id: "provider-a/test-image", providerId: "provider-a", name: "Test image model", model: "test-image", protocol, baseUrl, enabled: true, hasKey: true }],
  };
  const serviceOptions = {
    paths,
    getConfig: async () => structuredClone(config),
    resolveProviderKey: async () => "secret-image-key",
    ...extra,
    onChanged: (event: { revision: number }) => events.push(event.revision),
  };
  const service = new ImageGenerationService(serviceOptions);
  t.after(async () => {
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    openDatabase(paths.databaseFile).close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, serviceOptions, config, paths, events, baseUrl, dir };
}

function send(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("independent tasks return immediately, dispatch concurrently and deduplicate request IDs", async (t) => {
  const replies: ServerResponse[] = [];
  const { service, events } = await fixture(t, (_req, res) => { replies.push(res); });
  const session = await service.createSession("Designs");
  const [first, second] = await Promise.all([
    service.generate({ requestId: "first", sessionId: session.id, prompt: "A lighthouse" }),
    service.generate({ requestId: "second", sessionId: session.id, prompt: "A bicycle" }),
  ]);
  assert.equal(first.status, "generating");
  assert.equal(second.status, "generating");
  assert.notEqual(first.id, second.id);
  await until(() => replies.length === 2);
  assert.equal((await service.snapshot(session.id)).tasks.filter((task) => task.status === "generating").length, 2);
  const again = await service.generate({ requestId: "first", sessionId: session.id, prompt: "A lighthouse" });
  assert.equal(again.id, first.id);
  assert.equal(replies.length, 2);
  for (const reply of replies) send(reply, imageResponse);
  const finished = await Promise.all([service.waitForTask(first.id), service.waitForTask(second.id)]);
  assert.ok(finished.every((task) => task.status === "succeeded"));
  assert.deepEqual(readFileSync(finished[0]!.images[0]!.path), PNG);
  assert.equal(finished[0]!.images[0]!.width, 1);
  assert.equal((await service.snapshot()).tasks.length, 0);
  assert.ok(events.every((revision, index) => index === 0 || revision > events[index - 1]!));
  assert.equal(JSON.stringify(await service.snapshot(session.id)).includes(PNG.toString("base64")), false);
});

test("OpenAI generation sends image parameters and a Bearer credential", async (t) => {
  let captured: { url?: string; auth?: string; body: unknown } | undefined;
  const { service } = await fixture(t, (req, res, body) => {
    captured = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body.toString()) };
    send(res, imageResponse);
  });
  const task = await service.generate({ requestId: "openai", prompt: "A lighthouse", options: { aspectRatio: "3:2", quality: "high" } });
  assert.equal((await service.waitForTask(task.id)).status, "succeeded");
  assert.deepEqual(captured, { url: "/v1/images/generations", auth: "Bearer secret-image-key", body: { model: "test-image", prompt: "A lighthouse", n: 1, size: "1536x1024", quality: "high" } });
});

test("current GPT models send widescreen high-resolution sizes in both generation and editing requests", async (t) => {
  const captured: { size: string; multipart: boolean }[] = [];
  const { service, config } = await fixture(t, (req, res, bytes) => {
    const multipart = String(req.headers["content-type"]).includes("multipart/form-data");
    const size = multipart ? /name="size"\r\n\r\n([^\r]+)/.exec(bytes.toString())?.[1] : JSON.parse(bytes.toString()).size;
    captured.push({ size, multipart });
    send(res, imageResponse);
  });
  config.models[0]!.model = "gpt-image-2.5-flare-1k";
  for (const editing of [false, true]) {
    const task = await service.generate({ requestId: `custom-size-${editing}`, prompt: "A landscape", options: { aspectRatio: "16:9", size: "3840x2160" }, ...(editing ? { references: [reference] } : {}) });
    assert.equal((await service.waitForTask(task.id)).status, "succeeded");
    assert.equal((await service.snapshot(task.sessionId)).tasks[0]!.options.size, "3840x2160");
  }
  assert.deepEqual(captured, [{ size: "3840x2160", multipart: false }, { size: "3840x2160", multipart: true }]);
});

test("OpenAI editing uploads reference bytes as multipart rather than a JSON image URL", async (t) => {
  let contentType = "";
  let bytes = Buffer.alloc(0);
  let url = "";
  const { service } = await fixture(t, (req, res, body) => {
    contentType = String(req.headers["content-type"]); bytes = body; url = req.url ?? "";
    send(res, imageResponse);
  });
  const task = await service.generate({ requestId: "openai-edit", prompt: "Change the sky", references: [reference], options: { size: "1024x1024" } });
  const finished = await service.waitForTask(task.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(url, "/v1/images/edits");
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  assert.ok(bytes.includes(PNG));
  assert.match(bytes.toString(), /name="image"; filename="reference-1.png"/);
  assert.match(bytes.toString(), /1024x1024/);
  assert.equal(finished.references.length, 1);
  assert.deepEqual(readFileSync(finished.references[0]!.path), PNG);
});

test("Gemini sends contents/imageConfig and retains returned text alongside the image", async (t) => {
  let captured: Record<string, unknown> = {};
  const { service } = await fixture(t, (req, res, body) => {
    captured = { url: req.url, key: req.headers["x-goog-api-key"], authorization: req.headers.authorization, payload: JSON.parse(body.toString()) };
    send(res, { candidates: [{ content: { parts: [{ text: "Here is your image" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] }, finishReason: "STOP" }] });
  }, "gemini");
  const task = await service.generate({ requestId: "gemini", prompt: "Watercolor", references: [reference], options: { aspectRatio: "16:9", size: "2K" } });
  const result = await service.waitForTask(task.id);
  assert.equal(result.status, "succeeded");
  assert.equal(result.text, "Here is your image");
  assert.equal(captured.url, "/v1beta/models/test-image:generateContent");
  assert.equal(captured.key, "secret-image-key");
  assert.equal(captured.authorization, undefined);
  assert.deepEqual(captured.payload, {
    contents: [{ role: "user", parts: [{ text: "Watercolor" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" } },
  });
});

test("Grok editing uses JSON and a data URI, with its own ratio and resolution fields", async (t) => {
  let captured: Record<string, unknown> = {};
  const { service } = await fixture(t, (req, res, body) => {
    captured = { url: req.url, type: req.headers["content-type"], payload: JSON.parse(body.toString()) };
    send(res, imageResponse);
  }, "grok");
  const task = await service.generate({ requestId: "grok", prompt: "A neon sky", references: [reference], options: { aspectRatio: "9:16", size: "2k" } });
  assert.equal((await service.waitForTask(task.id)).status, "succeeded");
  assert.equal(captured.url, "/v1/images/edits");
  assert.equal(captured.type, "application/json");
  assert.deepEqual(captured.payload, { model: "test-image", prompt: "A neon sky", n: 1, response_format: "b64_json", aspect_ratio: "9:16", resolution: "2k", image: { url: `data:image/png;base64,${PNG.toString("base64")}` } });
});

test("each image publishes while other requests are active; partial failure retains successful files", async (t) => {
  const replies: ServerResponse[] = [];
  const { service } = await fixture(t, (_req, res) => { replies.push(res); });
  const task = await service.generate({ requestId: "partial", prompt: "An icon", options: { count: 2 } });
  const updates: Array<{ status: string; images: number; index?: number }> = [];
  const unsubscribe = service.subscribeTask(task.id, (snapshot) => {
    updates.push({ status: snapshot.status, images: snapshot.images.length, index: snapshot.images[0]?.index });
    snapshot.images.length = 0; // Observers receive isolated snapshots.
  });
  await until(() => replies.length === 2);
  send(replies[0]!, imageResponse);
  await until(async () => (await service.snapshot(task.sessionId)).tasks[0]?.images.length === 1);
  assert.equal((await service.snapshot(task.sessionId)).tasks[0]!.status, "generating");
  send(replies[1]!, { error: { message: "Rate limited" } }, 429);
  const result = await service.waitForTask(task.id);
  assert.equal(result.status, "partial");
  assert.equal(result.images.length, 1);
  assert.match(result.error!, /429/);
  assert.deepEqual(readFileSync(result.images[0]!.path), PNG);
  assert.equal(replies.length, 2, "no automatic paid retry");
  unsubscribe();
  assert.ok(updates.some((task) => task.status === "generating" && task.images === 1 && task.index === 0));
  assert.equal(updates.at(-1)?.status, "partial");
  assert.equal(updates.at(-1)?.images, 1);
});

test("cancel wins against a fetch implementation that returns a late success", async (t) => {
  let finish: ((response: Response) => void) | undefined;
  const fetcher = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  const { service } = await fixture(t, () => undefined, "openai", { fetch: fetcher });
  const task = await service.generate({ requestId: "cancel", prompt: "An icon" });
  const statuses: string[] = [];
  const unsubscribe = service.subscribeTask(task.id, (snapshot) => { statuses.push(snapshot.status); });
  await until(() => Boolean(finish));
  await service.cancel(task.id);
  assert.equal((await service.waitForTask(task.id)).status, "cancelled");
  finish!(Response.json(imageResponse));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const after = (await service.snapshot(task.sessionId)).tasks[0]!;
  assert.equal(after.status, "cancelled");
  assert.equal(after.images.length, 0);
  assert.equal(statuses.at(-1), "cancelled");
  unsubscribe();
});

test("a cancelled waiter cancels its underlying generation and releases the wait", async (t) => {
  const { service } = await fixture(t, () => undefined);
  const task = await service.generate({ requestId: "wait-abort", prompt: "An icon" });
  const controller = new AbortController();
  const pending = service.waitForTask(task.id, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal((await service.waitForTask(task.id)).status, "cancelled");
});

test("startup turns persisted generating rows into interrupted tasks without resending", async (t) => {
  let requests = 0;
  const { service, paths, serviceOptions } = await fixture(t, (_req, res) => { requests++; send(res, imageResponse); });
  const task = await service.generate({ requestId: "restart", prompt: "An icon" });
  const finished = await service.waitForTask(task.id);
  await service.dispose();
  const db = openDatabase(paths.databaseFile);
  db.run("UPDATE image_tasks SET data = ? WHERE id = ?", JSON.stringify({ ...finished, status: "generating", completedAt: undefined, images: [] }), task.id);
  const reopened = new ImageGenerationService(serviceOptions);
  t.after(() => reopened.dispose());
  const restored = (await reopened.snapshot(task.sessionId)).tasks[0]!;
  assert.equal(restored.status, "interrupted");
  assert.ok(restored.completedAt);
  assert.equal(requests, 1);
  assert.ok((await reopened.snapshot()).revision > 0);
});

test("unified provider models are read live without creating separate image configuration or credentials", async (t) => {
  const { service, dir, config } = await fixture(t, (_req, res) => send(res, imageResponse));
  config.models[0]!.name = "Renamed in provider settings";
  assert.equal((await service.getConfig()).models[0]!.name, "Renamed in provider settings");
  const task = await service.generate({ requestId: "private", prompt: "An icon" });
  await service.waitForTask(task.id);
  assert.equal(task.model.name, "Renamed in provider settings");
  assert.equal(JSON.stringify(await service.snapshot(task.sessionId)).includes("secret-image-key"), false);
  assert.equal(JSON.stringify(await service.getConfig()).includes("secret-image-key"), false);
  assert.equal(existsSync(join(dir, "image-models.json")), false);
  assert.equal(existsSync(join(dir, "image-model-keys.json")), false);
  const savedModel = structuredClone(config.models[0]!);
  for (const patch of [{ enabled: false }, { hasKey: false }, { baseUrl: "file:///tmp/image" }, { model: "" }]) {
    config.models = [{ ...savedModel, ...patch }];
    await assert.rejects(service.generate({ requestId: `unusable-${JSON.stringify(patch)}`, prompt: "An icon" }), /默认图片模型|default image model/);
  }
  config.models = [];
  await assert.rejects(service.generate({ requestId: "missing-default", prompt: "An icon" }), /默认图片模型|default image model/);
});

test("each dispatch resolves the current owning provider key without persisting credentials", async (t) => {
  const observed: string[] = [];
  let key = "first-provider-key";
  let lookups = 0;
  const { service } = await fixture(t, (req, res) => { observed.push(req.headers.authorization ?? ""); send(res, imageResponse); }, "openai", {
    resolveProviderKey: async (id) => { assert.equal(id, "provider-a"); lookups++; return key; },
  });
  await service.getConfig();
  await service.createSession();
  assert.equal(lookups, 0, "reading model metadata must not resolve credentials");
  const first = await service.generate({ requestId: "first-key", prompt: "Icon" });
  await service.waitForTask(first.id);
  key = "updated-provider-key";
  const second = await service.generate({ requestId: "next-key", prompt: "Icon" });
  await service.waitForTask(second.id);
  assert.equal(lookups, 2);
  assert.deepEqual(observed, ["Bearer first-provider-key", "Bearer updated-provider-key"]);
  const metadata = JSON.stringify(await service.snapshot(second.sessionId));
  assert.equal(metadata.includes("first-provider-key"), false);
  assert.equal(metadata.includes(key), false);
});

test("temporary image URLs are downloaded without forwarding the model credential", async (t) => {
  let baseUrl = "";
  let downloadAuth: string | undefined = "not-yet";
  const { service, baseUrl: url } = await fixture(t, (req, res) => {
    if (req.url === "/cdn/image") {
      downloadAuth = req.headers.authorization;
      res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    } else send(res, { data: [{ url: `${baseUrl.replace(/\/v1$/, "")}/cdn/image` }] });
  });
  baseUrl = url;
  const task = await service.generate({ requestId: "download", prompt: "Icon" });
  const result = await service.waitForTask(task.id);
  assert.equal(result.status, "succeeded");
  assert.equal(downloadAuth, undefined);
  assert.deepEqual(readFileSync(result.images[0]!.path), PNG);
});

test("upstream errors redact the API key and never retry paid requests", async (t) => {
  let attempts = 0;
  const { service } = await fixture(t, (_req, res) => { attempts++; send(res, { error: { message: "Rejected secret-image-key, Authorization: Bearer another-key" } }, 401); });
  const task = await service.generate({ requestId: "error", prompt: "Icon" });
  const result = await service.waitForTask(task.id);
  assert.equal(result.status, "failed");
  assert.equal(result.error!.includes("secret-image-key"), false);
  assert.equal(result.error!.includes("another-key"), false);
  assert.match(result.error!, /401/);
  assert.equal(attempts, 1);
});

test("source conversations reuse their image session and deletion prevents late resurrection", async (t) => {
  const { service } = await fixture(t, (_req, res) => send(res, imageResponse));
  const first = await service.generate({ requestId: "source-first", sourceConversationId: "chat-1", prompt: "Icon" });
  await service.waitForTask(first.id);
  const second = await service.generate({ requestId: "source-second", sourceConversationId: "chat-1", prompt: "Landscape" });
  await service.waitForTask(second.id);
  assert.equal(first.sessionId, second.sessionId);
  await service.renameSession(first.sessionId, "My images");
  assert.equal((await service.snapshot()).sessions[0]!.title, "My images");
  await service.deleteSession(first.sessionId);
  assert.equal((await service.snapshot()).sessions.length, 0);
  assert.equal((await service.snapshot(first.sessionId)).tasks.length, 0);
  await assert.rejects(service.waitForTask(first.id), /不存在|no longer exists/);
});

test("invalid references and non-image responses fail cleanly without exposing image bytes", async (t) => {
  const { service } = await fixture(t, (_req, res) => send(res, { data: [{ b64_json: Buffer.from("<html>not an image</html>").toString("base64") }] }));
  const badOutput = await service.generate({ requestId: "bad-output", prompt: "Icon" });
  const failed = await service.waitForTask(badOutput.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.images.length, 0);
  const badInput = await service.generate({ requestId: "bad-input", prompt: "Icon", references: [{ data: "not-base64!?", mimeType: "image/png", name: "bad.png" }] });
  assert.equal((await service.waitForTask(badInput.id)).status, "failed");
  await assert.rejects(service.generate({ requestId: "count", prompt: "Icon", options: { count: 0 } }));
  await assert.rejects(service.generate({ requestId: "count-5", prompt: "Icon", options: { count: 5 } }));
});

test("deleting a session aborts active writers and a late fetch cannot recreate its files", async (t) => {
  let finish: ((response: Response) => void) | undefined;
  const fetcher = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  const { service, paths } = await fixture(t, () => undefined, "openai", { fetch: fetcher });
  const task = await service.generate({ requestId: "delete-live", prompt: "An icon", references: [reference] });
  await until(() => Boolean(finish));
  const waiting = service.waitForTask(task.id);
  const deleting = service.deleteSession(task.sessionId);
  assert.equal((await waiting).status, "cancelled");
  await assert.rejects(service.generate({ requestId: "during-delete", sessionId: task.sessionId, prompt: "Must not start" }), /正在删除|being deleted/);
  finish!(Response.json(imageResponse));
  await deleting;
  await assert.rejects(service.waitForTask(task.id), /不存在|no longer exists/);
  assert.equal((await service.snapshot()).sessions.length, 0);
  assert.equal(existsSync(join(paths.runtimeRoot, "image-generation", task.sessionId)), false);
  assert.equal((await service.snapshot(task.sessionId)).tasks.length, 0);
});

test("two reference images are rejected before storing a task or contacting the provider", async (t) => {
  let attempts = 0;
  const { service } = await fixture(t, (_req, res) => { attempts++; send(res, imageResponse); });
  const session = await service.createSession();
  await assert.rejects(service.generate({ requestId: "two-references", sessionId: session.id, prompt: "Icon", references: [reference, reference] }), /最多使用 1 张|at most one/);
  assert.equal(attempts, 0);
  assert.equal((await service.snapshot(session.id)).tasks.length, 0);
});

test("four requested images dispatch concurrently and keep all four successful files", async (t) => {
  const replies: ServerResponse[] = [];
  const { service } = await fixture(t, (_req, res) => { replies.push(res); });
  const task = await service.generate({ requestId: "four-images", prompt: "Four icons", options: { count: 4 } });
  await until(() => replies.length === 4);
  for (const reply of replies) send(reply, imageResponse);
  const finished = await service.waitForTask(task.id);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.images.length, 4);
  assert.deepEqual(finished.images.map((image) => image.index), [0, 1, 2, 3]);
  for (const image of finished.images) assert.deepEqual(readFileSync(image.path), PNG);
});

test("deleting one task removes its files while preserving sibling tasks and copied reference assets", async (t) => {
  const { service, paths } = await fixture(t, (_req, res) => send(res, imageResponse));
  const session = await service.createSession();
  const source = await service.generate({ requestId: "reference-source", sessionId: session.id, prompt: "Original icon", references: [reference] });
  const first = await service.waitForTask(source.id);
  const next = await service.generate({ requestId: "reference-copy", sessionId: session.id, prompt: "A variation", references: [{ path: first.images[0]!.path }] });
  const second = await service.waitForTask(next.id);
  assert.notEqual(second.references[0]!.path, first.images[0]!.path);
  await service.deleteTask(source.id);
  assert.equal(existsSync(join(paths.runtimeRoot, "image-generation", session.id, source.id)), false);
  assert.equal(existsSync(first.references[0]!.path), false);
  assert.equal(existsSync(first.images[0]!.path), false);
  assert.deepEqual(readFileSync(second.references[0]!.path), PNG);
  assert.deepEqual(readFileSync(second.images[0]!.path), PNG);
  assert.deepEqual((await service.snapshot(session.id)).tasks.map((task) => task.id), [second.id]);
  assert.equal((await service.snapshot()).sessions.length, 1);
  await assert.rejects(service.waitForTask(source.id), /不存在|no longer exists/);
  await service.deleteTask(source.id);
  await service.deleteSession(session.id);
  assert.equal(existsSync(join(paths.runtimeRoot, "image-generation", session.id)), false);
});

test("deleting an active task cancels its waiter and late success cannot restore the row or directory", async (t) => {
  const replies: ((response: Response) => void)[] = [];
  const fetcher = (() => new Promise<Response>((resolve) => replies.push(resolve))) as typeof fetch;
  const { service, paths } = await fixture(t, () => undefined, "openai", { fetch: fetcher });
  const task = await service.generate({ requestId: "delete-partial-live", prompt: "Two icons", references: [reference], options: { count: 2 } });
  await until(() => replies.length === 2);
  replies[0]!(Response.json(imageResponse));
  await until(async () => (await service.snapshot(task.sessionId)).tasks[0]!.images.length === 1);
  const waiting = service.waitForTask(task.id);
  const deleting = service.deleteTask(task.id);
  assert.equal((await waiting).status, "cancelled");
  replies[1]!(Response.json(imageResponse));
  await deleting;
  assert.equal((await service.snapshot(task.sessionId)).tasks.length, 0);
  assert.equal(existsSync(join(paths.runtimeRoot, "image-generation", task.sessionId, task.id)), false);
  await assert.rejects(service.waitForTask(task.id), /不存在|no longer exists/);
  assert.equal((await service.snapshot()).sessions.length, 1);
});

test("failed asset cleanup keeps the cancelled task available for a later delete attempt", async (t) => {
  let finish: ((response: Response) => void) | undefined;
  const fetcher = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  const { service, paths } = await fixture(t, () => undefined, "openai", { fetch: fetcher });
  const task = await service.generate({ requestId: "delete-cleanup-failure", prompt: "Icon", references: [reference] });
  await until(() => Boolean(finish));
  const root = join(paths.runtimeRoot, "image-generation");
  const movedRoot = `${root}.saved`;
  renameSync(root, movedRoot);
  writeFileSync(root, "A file obstructs the asset directory");
  try {
    const deleting = service.deleteTask(task.id);
    finish!(Response.json(imageResponse));
    await assert.rejects(deleting, { code: "ENOTDIR" });
    assert.equal((await service.snapshot(task.sessionId)).tasks[0]!.status, "cancelled");
  } finally {
    rmSync(root, { force: true });
    renameSync(movedRoot, root);
  }
  await service.deleteTask(task.id);
  assert.equal((await service.snapshot(task.sessionId)).tasks.length, 0);
  assert.equal(existsSync(join(root, task.sessionId, task.id)), false);
});

test("bounded downloads reject excessive declared lengths and streamed bytes", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(readBounded(new Response("x", { headers: { "content-length": "1000" } }), 10, signal), /大小限制|size limit/);
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readBounded(new Response(body), 10, signal), /大小限制|size limit/);
  assert.equal(cancelled, true);
});

test("missing local references produce a readable failure before any provider request", async (t) => {
  let attempts = 0;
  const { service, dir } = await fixture(t, (_req, res) => { attempts++; send(res, imageResponse); });
  const task = await service.generate({ requestId: "missing-reference", prompt: "Icon", references: [{ path: join(dir, "missing.png") }] });
  const result = await service.waitForTask(task.id);
  assert.equal(result.status, "failed");
  assert.match(result.error!, /参考图已不存在|reference image is missing/);
  assert.equal(result.error!.includes("ENOENT"), false);
  assert.equal(attempts, 0);
});

test("Gemini rejects JSON null, arrays and primitives with a readable response error", async (t) => {
  let payload: unknown = null;
  let status = 200;
  const { service } = await fixture(t, (_req, res) => send(res, payload, status), "gemini");
  for (const value of [null, [], [null], "text", 42]) {
    for (const code of [200, 400]) {
      payload = value; status = code;
      const task = await service.generate({ requestId: `invalid-json-${JSON.stringify(value)}-${code}`, prompt: "Icon" });
      const result = await service.waitForTask(task.id);
      assert.equal(result.status, "failed");
      assert.match(result.error!, /无法识别的响应|unreadable response/);
      assert.match(result.error!, new RegExp(`HTTP ${code}`));
      assert.doesNotMatch(result.error!, /TypeError|Cannot read/);
    }
  }
});

test("count results retain request slot order during reverse completion, partial failure and reload", async (t) => {
  const replies: ((response: Response) => void)[] = [];
  const fetcher = (() => new Promise<Response>((resolve) => replies.push(resolve))) as typeof fetch;
  const { service, serviceOptions } = await fixture(t, () => undefined, "openai", { fetch: fetcher });
  const task = await service.generate({ requestId: "slot-order", prompt: "Icons", options: { count: 4 } });
  await until(() => replies.length === 4);
  for (const index of [3, 2, 0]) {
    replies[index]!(Response.json(imageResponse));
    const expected = [3, 2, 0].slice(0, [3, 2, 0].indexOf(index) + 1).sort((a, b) => a - b).map((slot) => `image-${slot + 1}.png`);
    await until(async () => (await service.snapshot(task.sessionId)).tasks[0]!.images.length === expected.length);
    const current = (await service.snapshot(task.sessionId)).tasks[0]!;
    assert.deepEqual(current.images.map((image) => basename(image.path)), expected);
    assert.equal(current.status, "generating");
  }
  replies[1]!(Response.json({ error: { message: "Rate limited" } }, { status: 429 }));
  const result = await service.waitForTask(task.id);
  assert.equal(result.status, "partial");
  assert.deepEqual(result.images.map((image) => basename(image.path)), ["image-1.png", "image-3.png", "image-4.png"]);
  await service.dispose();
  const reopened = new ImageGenerationService(serviceOptions);
  t.after(() => reopened.dispose());
  assert.deepEqual((await reopened.snapshot(task.sessionId)).tasks[0]!.images, result.images);
});

test("legacy GPT Image refuses unsupported ratios and size conflicts before creating a task or sending a request", async (t) => {
  let attempts = 0;
  const { service, config } = await fixture(t, (_req, res) => { attempts++; send(res, imageResponse); });
  config.models[0]!.model = "gpt-image-1";
  for (const [index, options] of [
    { aspectRatio: "16:9" }, { aspectRatio: "9:16", size: "1024x1536" },
    { aspectRatio: "4:3" }, { aspectRatio: "3:2", size: "1024x1024" },
    { aspectRatio: "1:1", size: "1536x1024" }, { size: "2K" }, { size: "1920x1080" },
  ].entries()) {
    await assert.rejects(service.generate({ requestId: `invalid-options-${index}`, prompt: "Icon", options }), /比例|aspect ratio/);
  }
  assert.equal(attempts, 0);
  assert.equal((await service.snapshot()).sessions.length, 0);
});

test("OpenAI records explicit size ratios and sends all supported ratios without silent remapping", async (t) => {
  const sizes: (string | undefined)[] = [];
  const { service } = await fixture(t, (_req, res, bytes) => { sizes.push(JSON.parse(bytes.toString()).size); send(res, imageResponse); });
  for (const [index, aspectRatio] of ["auto", "1:1", "3:2", "2:3"].entries()) {
    const task = await service.generate({ requestId: `supported-ratio-${index}`, prompt: "Icon", options: { aspectRatio } });
    assert.equal((await service.waitForTask(task.id)).status, "succeeded");
  }
  assert.deepEqual(sizes, [undefined, "1024x1024", "1536x1024", "1024x1536"]);
  for (const aspectRatio of [undefined, "auto", "3:2"]) {
    const task = await service.generate({ requestId: `explicit-size-${aspectRatio}`, prompt: "Icon", options: { size: "1536x1024", aspectRatio } });
    assert.equal(task.options.aspectRatio, "3:2");
    await service.waitForTask(task.id);
    const snapshot = await service.snapshot(task.sessionId);
    assert.equal(snapshot.tasks[0]!.options.aspectRatio, "3:2");
    assert.equal(snapshot.sessions.find((session) => session.id === task.sessionId)!.options!.aspectRatio, "3:2");
  }
});

test("dispose joins active jobs and all public entrypoints reject after shutdown without touching a closed database", async (t) => {
  let finish: ((response: Response) => void) | undefined;
  const fetcher = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  const { service, paths, dir } = await fixture(t, () => undefined, "openai", { fetch: fetcher });
  const task = await service.generate({ requestId: "dispose-live", prompt: "Icon" });
  await until(() => Boolean(finish));
  const waiting = service.waitForTask(task.id);
  const first = service.dispose();
  const second = service.dispose();
  assert.equal(first, second, "concurrent disposal must join the same pending jobs");
  assert.equal((await waiting).status, "interrupted");
  let disposed = false;
  void second.then(() => { disposed = true; });
  await Promise.resolve();
  assert.equal(disposed, false);
  const rejectedCalls = () => [
    service.getConfig(), service.snapshot(task.sessionId), service.cancel(task.id), service.waitForTask(task.id),
    service.deleteTask(task.id),
    service.createSession(), service.renameSession(task.sessionId, "Changed"), service.deleteSession(task.sessionId),
    service.generate({ requestId: "after-dispose", prompt: "Icon" }),
  ];
  for (const call of rejectedCalls()) await assert.rejects(call, /图片生成服务已关闭|image generation service is closed/);
  finish!(Response.json(imageResponse));
  await Promise.all([first, second]);
  const db = openDatabase(paths.databaseFile);
  const stored = JSON.parse(db.get<{ data: string }>("SELECT data FROM image_tasks WHERE id = ?", task.id)!.data);
  assert.equal(stored.status, "interrupted");
  assert.equal(stored.images.length, 0);
  db.close();
  for (const call of rejectedCalls()) await assert.rejects(call, /图片生成服务已关闭|image generation service is closed/);
  await service.dispose();
  assert.equal(existsSync(join(dir, "image-models.json")), false);
});
