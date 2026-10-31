#!/usr/bin/env node
// Process-level native core regression (not GUI acceptance).
// Build the shared target first, then: node scripts/native-core-journey.mjs [SERVER_BINARY] [--keep]
// Uses only Node builtins, a loopback OpenAI SSE mock, and a disposable HOME/data/git tree.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once, EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? join(root, "native/target/debug/fastvibe-server"));
const keep = process.argv.includes("--keep");
const key = "native-journey-local-dummy-key";
const modelId = "journey-local-model";
const deadlineMs = 20_000;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const report = { kind: "native-process-protocol-regression", executable, steps: [], guiAcceptance: "not run" };
const regressions = [];
const started = Date.now();
let activeStep = "setup";
let client;
let mock;
let temporary;

// Use a whitelist: never forward the developer's API keys, proxy settings, git config or HOME.
function isolatedEnvironment(home, temporary) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
    HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
    TMPDIR: `${temporary}/`, SHELL: "/bin/sh", LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Native Journey", GIT_AUTHOR_EMAIL: "journey@localhost.invalid",
    GIT_COMMITTER_NAME: "Native Journey", GIT_COMMITTER_EMAIL: "journey@localhost.invalid",
  };
}

class ProtocolProcess {
  constructor(data, work, env) {
    this.events = [];
    this.pending = new Map();
    this.changed = new EventEmitter();
    this.nextId = 1;
    this.stderr = "";
    this.child = spawn(executable, ["--data-dir", data, "--listen", "stdio"], {
      cwd: work, env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.closed = new Promise((resolveClose) => this.child.once("close", (code, signal) => {
      this.exit = { code, signal };
      this.fail(new Error(`server closed (${code ?? signal}): ${this.stderr}`));
      resolveClose(this.exit);
    }));
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-12_000); });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const frame = JSON.parse(line);
        if (frame.method) {
          // This journey should never park on a question, approval, or browser request.
          assert.equal(frame.id, undefined, `unexpected server request: ${frame.method}`);
          const previous = this.events.findLast((event) => event.params?.threadId === frame.params?.threadId && Number.isInteger(event.params?.seq));
          if (Number.isInteger(frame.params?.seq) && previous) assert.ok(frame.params.seq > previous.params.seq, "thread notification sequence must advance");
          this.events.push(frame);
          this.changed.emit("change");
        } else {
          const pending = this.pending.get(frame.id);
          assert.ok(pending, `unexpected response id ${frame.id}`);
          this.pending.delete(frame.id);
          pending.resolve(frame);
        }
      } catch (error) { this.fail(error); }
    });
  }
  fail(error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.changed.emit("change");
  }
  async raw(method, params = {}) {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    let timer;
    try {
      return await Promise.race([
        new Promise((resolveResponse, reject) => {
          this.pending.set(id, { resolve: resolveResponse, reject });
          this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC timed out: ${method}`)), deadlineMs); }),
      ]);
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async call(method, params = {}) {
    const response = await this.raw(method, params);
    assert.ok(!response.error, `${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  }
  async wait(predicate, after = 0) {
    const end = Date.now() + deadlineMs;
    for (;;) {
      if (this.failure) throw this.failure;
      const found = this.events.slice(after).find(predicate);
      if (found) return found;
      assert.ok(Date.now() < end, `notification timed out during ${activeStep}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(500, end - Date.now()));
      try { await once(this.changed, "change", { signal: controller.signal }); }
      catch (error) { if (error.name !== "AbortError") throw error; }
      finally { clearTimeout(timer); }
    }
  }
  async settled(threadId, turnId, after, status = "completed") {
    const completion = await this.wait((e) => e.method === "turn/completed" && e.params.threadId === threadId && e.params.turnId === turnId, after);
    assert.equal(completion.params.status, status, JSON.stringify(completion.params));
    await this.wait((e) => e.method === "thread/status/changed" && e.params.threadId === threadId && !e.params.running && e.params.seq > completion.params.seq, after);
    return this.events.slice(after).filter((e) => e.params?.threadId === threadId && e.params?.turnId === turnId);
  }
  async send(threadId, text) {
    const after = this.events.length;
    const { turnId } = await this.call("turn/start", { threadId, text });
    return { turnId, events: await this.settled(threadId, turnId, after) };
  }
  async stop() {
    if (!this.exit) {
      this.child.kill("SIGTERM");
      this.child.stdin.end();
      let timer;
      try {
        await Promise.race([this.closed, new Promise((_, reject) => {
          timer = setTimeout(() => { this.child.kill("SIGKILL"); reject(new Error("server did not exit cleanly")); }, 8000);
        })]);
      } finally { clearTimeout(timer); }
    }
    assert.equal(this.exit.code, 0, `unclean server exit: ${JSON.stringify(this.exit)} ${this.stderr}`);
  }
}

const longLines = Array.from({ length: 640 }, (_, i) => `row-${String(i).padStart(4, "0")} ${"native journey patch ".repeat(6)} boundary-${i}`);
longLines.splice(320, 0, `long-line-${"x".repeat(8192)}-end`);
const patchText = `*** Begin Patch\n*** Update File: journey.txt\n@@\n-original\n+agent changed\n*** Add File: long-patch.txt\n${longLines.map((line) => `+${line}`).join("\n")}\n*** End Patch\n`;
const expectedLongFile = `${longLines.join("\n")}\n`;

async function startMock() {
  const requests = [];
  const violations = [];
  let stopAttempts = 0;
  const sockets = new Set();
  const responses = new Set();
  function check(condition, message) { if (!condition) throw new Error(message); }
  function chunk(response, delta, finish = null) {
    response.write(`data: ${JSON.stringify({ id: "local-journey", object: "chat.completion.chunk", created: 1, model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  }
  function done(response, finish = "stop") {
    chunk(response, {}, finish);
    response.end(`data: ${JSON.stringify({ id: "local-journey", object: "chat.completion.chunk", created: 1, model: modelId, choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
  }
  const server = createServer(async (request, response) => {
    responses.add(response);
    response.once("close", () => responses.delete(response));
    try {
      check(request.headers.authorization === `Bearer ${key}`, "provider request did not use the configured dummy credential");
      if (request.method === "GET" && request.url === "/v1/models") {
        requests.push({ kind: "models" });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model", owned_by: "local-test" }] }));
        return;
      }
      check(request.method === "POST" && request.url === "/v1/chat/completions", `unexpected endpoint ${request.method} ${request.url}`);
      const chunks = [];
      for await (const data of request) chunks.push(data);
      const body = JSON.parse(Buffer.concat(chunks));
      check(body.model === modelId && body.stream === true, "wrong model or non-streamed request");
      const prompt = body.messages.findLast((m) => m.role === "user")?.content;
      check(typeof prompt === "string", "last user prompt was not text");
      requests.push({ kind: "chat", prompt, body });
      const users = body.messages.filter((m) => m.role === "user").map((m) => m.content);
      if (["Edit journey", "Later turn", "Fork check", "Make patch", "After restart"].includes(prompt)) {
        check(!users.includes("Stop journey"), "edited prompt remained in provider context");
        check(!JSON.stringify(body.messages).includes("Retry complete"), "discarded retry answer remained in provider context");
      }
      if (["Fork check", "Make patch", "After restart"].includes(prompt)) check(!users.includes("Later turn"), "fork leaked a turn after its selected boundary");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.flushHeaders();
      chunk(response, { role: "assistant" });
      if (prompt === "Stop journey" && stopAttempts++ === 0) {
        chunk(response, { content: "Partial before stop" });
        // Intentionally do not finish: the real server must cancel its HTTP stream.
        return;
      }
      if (prompt === "Make patch" && body.messages.at(-1)?.role !== "tool") {
        check(body.tools.some((t) => t.function?.name === "apply_patch"), "apply_patch was not offered to the configured model");
        chunk(response, { tool_calls: [{ index: 0, id: "journey_patch", type: "function", function: { name: "apply_patch", arguments: "" } }] });
        const argumentsText = JSON.stringify({ input: patchText });
        for (let offset = 0; offset < argumentsText.length; offset += 2048) {
          if (response.destroyed) return;
          chunk(response, { tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(offset, offset + 2048) } }] });
          await delay(3);
        }
        done(response, "tool_calls");
        return;
      }
      if (prompt === "Make patch") check(body.messages.at(-1).content.includes("long-patch.txt"), "tool result did not return the real patch paths");
      const answers = { "Start journey": "Streamed initial answer", "Stop journey": "Retry complete", "Edit journey": "Edited answer", "Later turn": "Must stay on parent", "Fork check": "Fork boundary verified", "Make patch": "Patch applied", "After restart": "Restored context verified" };
      const answer = answers[prompt];
      check(answer, `unexpected model prompt ${prompt}`);
      chunk(response, { content: answer.slice(0, 8) });
      await delay(40);
      chunk(response, { content: answer.slice(8) });
      done(response);
    } catch (error) {
      violations.push(error.message);
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: error.message, type: "invalid_request_error" } }));
    }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`, requests, violations,
    pendingStreams: () => responses.size,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolveClose) => server.close(resolveClose)); },
  };
}

async function step(name, action) {
  activeStep = name;
  const start = Date.now();
  const before = regressions.length;
  const evidence = await action();
  const errors = regressions.slice(before);
  const status = errors.length ? "failed" : "passed";
  report.steps.push({ name, status, durationMs: Date.now() - start, ...evidence, ...(errors.length ? { errors } : {}) });
  console.log(`${errors.length ? "FAIL" : "PASS"} ${name}${evidence ? ` ${JSON.stringify(evidence)}` : ""}`);
}
const texts = (snapshot, type) => snapshot.turns.flatMap((turn) => turn.items.filter((item) => item.type === type).map((item) => item.text));
const answer = (events) => events.filter((e) => e.method === "item/completed" && e.params.item.type === "agentMessage").map((e) => e.params.item.text).join("");
// Text item IDs are allocated during streaming and position-derived on disk. Compare the
// stable turn IDs and exact item contents; provider tool-call IDs must also survive intact.
const restoredContent = (snapshot) => snapshot.turns.map((turn) => ({
  id: turn.id,
  items: turn.items.map(({ id, ...item }) => item.type === "toolCall" ? { id, ...item } : item),
}));

try {
  await access(executable);
  temporary = await realpath(await mkdtemp(join(tmpdir(), "fv-native-journey-")));
  const home = join(temporary, "home");
  const data = join(temporary, "data");
  const work = join(temporary, "workspace");
  report.fixture = { root: temporary, home, data, workspace: work };
  await Promise.all([mkdir(home), mkdir(work), mkdir(data)]);
  const env = isolatedEnvironment(home, temporary);
  const git = (...args) => execFileSync("git", ["-C", work, ...args], { env, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(work, "journey.txt"), "original\n");
  git("add", "journey.txt");
  git("commit", "--quiet", "-m", "Initial journey fixture");
  const initialCommit = git("rev-parse", "HEAD");
  // Seed only the public metadata cache so startup's hourly refresh never reaches models.dev.
  // Provider configuration and credentials still go through the actual protocol below.
  await writeFile(join(data, "models-dev.json"), JSON.stringify({
    v: 4, t: Date.now(), s: "local-journey-fixture",
    m: [[modelId, "Journey local model", 128000, 8192, 1, []]], x: { [modelId]: 0 },
  }));
  mock = await startMock();
  client = new ProtocolProcess(data, work, env);
  const initialize = async () => {
    const hello = await client.call("initialize", { clientInfo: { name: "native-core-journey", version: "1" }, protocolVersion: 1, capabilities: {} });
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.dataDir, data);
    assert.equal(hello.hasRunningTurns, false);
    return hello;
  };
  let label, threadId, editedTurnId, forkId, savedRevision, commit;
  await step("configure provider, discover model, select defaults", async () => {
    report.server = await initialize();
    assert.deepEqual((await client.call("provider/list")).providers, []);
    const { provider } = await client.call("provider/upsert", { name: "Local Journey", protocol: "chat", baseUrl: mock.url, apiKey: key, enabled: true, models: [] });
    assert.equal(provider.hasKey, true);
    const { models } = await client.call("provider/fetchModels", { providerId: provider.id });
    assert.equal(models.length, 1);
    assert.equal(models[0].id, modelId);
    await client.call("provider/upsert", { ...provider, expected: provider, models });
    const listed = await client.call("provider/list");
    assert.ok(!JSON.stringify(listed).includes(key));
    assert.equal((await stat(join(data, "credentials.json"))).mode & 0o777, 0o600);
    const entries = (await client.call("model/list")).models;
    assert.equal(entries.length, 1);
    label = entries[0].label;
    assert.equal((await client.call("model/defaults/set", { model: label, thinking: null })).model, label);
    await client.call("settings/set", { replySuggestions: false, autoCompactionEnabled: false });
    return { model: label, credentialMode: "0600", requests: mock.requests.length };
  });
  await step("create project/thread and stream a reply", async () => {
    const project = await client.call("project/create", { name: "Journey project", folders: [work] });
    const { thread } = await client.call("thread/start", { cwd: work, project: project.path, model: null });
    threadId = thread.id;
    assert.equal((await client.call("thread/model/set", { threadId, model: label, thinking: null })).thread.model, label);
    const result = await client.send(threadId, "Start journey");
    assert.equal(answer(result.events), "Streamed initial answer");
    assert.equal(result.events.filter((e) => e.method === "item/agentMessage/delta").map((e) => e.params.delta).join(""), "Streamed initial answer");
    assert.ok(result.events.filter((e) => e.method === "item/agentMessage/delta").length >= 2);
    const snapshot = await client.call("thread/resume", { threadId });
    assert.equal(snapshot.running, false);
    assert.deepEqual(texts(snapshot, "userMessage"), ["Start journey"]);
    assert.deepEqual(texts(snapshot, "agentMessage"), ["Streamed initial answer"]);
    return { threadId, deltas: result.events.filter((e) => e.method === "item/agentMessage/delta").length };
  });
  await step("interrupt an unfinished provider stream", async () => {
    const after = client.events.length;
    const { turnId } = await client.call("turn/start", { threadId, text: "Stop journey" });
    await client.wait((e) => e.method === "item/agentMessage/delta" && e.params.turnId === turnId && e.params.delta.includes("Partial"), after);
    const live = await client.call("thread/resume", { threadId });
    assert.equal(live.running, true);
    assert.ok(texts(live, "agentMessage").join("").includes("Partial before stop"));
    await client.call("turn/interrupt", { threadId });
    await client.settled(threadId, turnId, after, "interrupted");
    const end = Date.now() + 3000;
    while (mock.pendingStreams() && Date.now() < end) await delay(20);
    assert.equal(mock.pendingStreams(), 0, "interruption must close the actual provider stream");
    editedTurnId = turnId;
    return { interruptedTurnId: turnId, providerStreamClosed: true };
  });
  await step("retry then edit the stopped turn", async () => {
    let after = client.events.length;
    const retry = await client.call("turn/rewind", { threadId, turnId: editedTurnId, rewindFiles: false });
    const retriedEvents = await client.settled(threadId, retry.turnId, after);
    assert.equal(answer(retriedEvents), "Retry complete");
    after = client.events.length;
    const edit = await client.call("turn/rewind", { threadId, turnId: retry.turnId, text: "Edit journey", rewindFiles: true });
    editedTurnId = edit.turnId;
    assert.equal(edit.files.hadCheckpoint, true);
    assert.deepEqual(edit.files.skipped, []);
    assert.equal(answer(await client.settled(threadId, editedTurnId, after)), "Edited answer");
    const snapshot = await client.call("thread/resume", { threadId });
    assert.deepEqual(texts(snapshot, "userMessage"), ["Start journey", "Edit journey"]);
    assert.deepEqual(texts(snapshot, "agentMessage"), ["Streamed initial answer", "Edited answer"]);
    return { checkpoint: edit.files.hadCheckpoint, visibleTurns: snapshot.turns.length };
  });
  await step("fork at an earlier complete turn and verify context isolation", async () => {
    await client.send(threadId, "Later turn");
    const { thread } = await client.call("thread/fork", { threadId, turnId: editedTurnId });
    forkId = thread.id;
    assert.notEqual(forkId, threadId);
    assert.equal(thread.model, label);
    const fork = await client.call("thread/resume", { threadId: forkId });
    assert.deepEqual(texts(fork, "userMessage"), ["Start journey", "Edit journey"]);
    assert.equal(answer((await client.send(forkId, "Fork check")).events), "Fork boundary verified");
    assert.deepEqual(texts(await client.call("thread/resume", { threadId }), "userMessage"), ["Start journey", "Edit journey", "Later turn"]);
    return { forkId, copiedTurns: fork.turns.length, parentUnchanged: true };
  });
  await step("stream and execute a long real tool patch", async () => {
    const result = await client.send(forkId, "Make patch");
    assert.equal(answer(result.events), "Patch applied");
    const tools = result.events.filter((e) => e.method === "item/completed" && e.params.item.type === "toolCall");
    assert.equal(tools.length, 1);
    assert.equal(tools[0].params.item.name, "apply_patch");
    assert.equal(tools[0].params.item.isError, false, tools[0].params.item.output);
    assert.deepEqual(tools[0].params.item.arguments, { input: patchText });
    try {
      const streamedArguments = result.events.filter((e) => e.method === "item/toolCall/argumentsDelta").map((e) => e.params.delta).join("");
      assert.ok(streamedArguments === JSON.stringify({ input: patchText }), `tool arguments must reach the client incrementally and exactly (received ${streamedArguments.length} of ${JSON.stringify({ input: patchText }).length} characters)`);
    } catch (error) {
      // This does not prevent file/Git/restart validation. Preserve the failing assertion in
      // the report and exit nonzero at the end instead of hiding the remaining outcomes.
      regressions.push({ step: activeStep, message: error.message, code: error.code });
    }
    assert.equal(await readFile(join(work, "journey.txt"), "utf8"), "agent changed\n");
    assert.equal(await readFile(join(work, "long-patch.txt"), "utf8"), expectedLongFile);
    const diff = await client.call("workspace/gitDiff", { cwd: work, path: "long-patch.txt", source: "unstaged" });
    assert.ok(Buffer.byteLength(diff.text) > 64 * 1024);
    assert.ok(diff.text.includes("+row-0000 ") && diff.text.includes("+row-0639 ") && diff.text.includes(`+long-line-${"x".repeat(8192)}-end`));
    return { patchBytes: Buffer.byteLength(patchText), diffBytes: Buffer.byteLength(diff.text), lines: longLines.length };
  });
  await step("open/edit/save and reject a stale exact-byte baseline", async () => {
    const path = join(work, "journey.txt");
    const opened = await client.call("workspace/preview", { cwd: work, path: "journey.txt" });
    assert.equal(opened.text, "agent changed\n");
    assert.equal(opened.revision, hash(opened.text));
    const before = await stat(path);
    const external = "other changed\n"; // Same size and restored mtime: hashes, not timestamps, catch this.
    assert.equal(Buffer.byteLength(external), Buffer.byteLength(opened.text));
    await writeFile(path, external);
    await utimes(path, before.atime, before.mtime);
    const stale = await client.raw("workspace/writeFile", { cwd: work, path: "journey.txt", text: "My unsaved draft\n", baseline: opened.revision });
    assert.equal(stale.error?.code, -32602);
    assert.ok(stale.error.message.includes(hash(external)), "conflict must report the current revision");
    assert.equal(await readFile(path, "utf8"), external);
    assert.equal(git("rev-parse", "HEAD"), initialCommit, "a rejected editor save must not alter repository history");
    const reloaded = await client.call("workspace/preview", { cwd: work, path: "journey.txt" });
    const saved = await client.call("workspace/writeFile", { cwd: work, path: "journey.txt", text: "Resolved and saved\n", baseline: reloaded.revision });
    savedRevision = saved.revision;
    assert.equal(savedRevision, hash("Resolved and saved\n"));
    assert.equal((await client.call("workspace/preview", { cwd: work, path: "journey.txt" })).revision, savedRevision);
    assert.equal(await readFile(path, "utf8"), "Resolved and saved\n");
    return { staleSaveRejected: true, externalBytesPreserved: true, savedRevision };
  });
  await step("inspect/stage/commit through Git APIs", async () => {
    const status = await client.call("workspace/gitStatus", { cwd: work });
    assert.equal(status.changed, 2);
    assert.deepEqual(status.files.map((f) => f.path).sort(), ["journey.txt", "long-patch.txt"]);
    assert.equal((await client.call("workspace/gitStage", { cwd: work, all: true })).staged, 2);
    const statusAfter = await client.call("workspace/gitCommit", { cwd: work, message: "test: complete isolated native journey" });
    assert.equal(statusAfter.changed, 0);
    commit = git("rev-parse", "HEAD");
    assert.notEqual(commit, initialCommit);
    assert.equal(git("show", "HEAD:journey.txt"), "Resolved and saved");
    const history = await client.call("workspace/gitHistory", { cwd: work, scope: "current" });
    assert.equal(history.commits[0].hash, commit);
    assert.equal(history.commits[0].subject, "test: complete isolated native journey");
    assert.deepEqual(history.commits[0].parents, [initialCommit]);
    return { commit, clean: true, commits: history.commits.length };
  });
  await step("restart actual process and restore provider/thread/fork/files/Git", async () => {
    const parent = await client.call("thread/resume", { threadId });
    const fork = await client.call("thread/resume", { threadId: forkId });
    await client.stop();
    client = new ProtocolProcess(data, work, env);
    const hello = await initialize();
    assert.equal(hello.serverVersion, report.server.serverVersion);
    assert.equal(hello.protocolVersion, report.server.protocolVersion);
    assert.deepEqual(hello.features, report.server.features);
    assert.equal((await client.call("provider/list")).providers[0].hasKey, true);
    assert.equal((await client.call("model/defaults/get")).model, label);
    assert.equal((await client.call("model/list")).models[0].label, label);
    assert.equal((await client.call("project/list")).projects[0].name, "Journey project");
    assert.equal((await client.call("thread/list")).threads.length, 2);
    const restoredParent = await client.call("thread/resume", { threadId });
    const restoredFork = await client.call("thread/resume", { threadId: forkId });
    assert.deepEqual(restoredContent(restoredParent), restoredContent(parent));
    assert.deepEqual(restoredContent(restoredFork), restoredContent(fork));
    assert.equal(restoredParent.running, false);
    assert.equal(restoredFork.running, false);
    assert.equal(restoredFork.thread.model, label);
    assert.equal((await client.call("workspace/preview", { cwd: work, path: "journey.txt" })).revision, savedRevision);
    assert.equal((await client.call("workspace/gitStatus", { cwd: work })).changed, 0);
    assert.equal((await client.call("workspace/gitHistory", { cwd: work })).commits[0].hash, commit);
    assert.equal(answer((await client.send(forkId, "After restart")).events), "Restored context verified");
    const sent = mock.requests.findLast((r) => r.prompt === "After restart").body;
    assert.ok(sent.messages.some((m) => m.role === "tool" && m.content.includes("long-patch.txt")), "restored provider history must retain the tool result");
    assert.deepEqual(mock.violations, []);
    assert.equal(mock.requests.filter((r) => r.kind === "chat").length, 9, "unexpected background or repeated model request");
    await client.stop();
    return { parentTurns: restoredParent.turns.length, forkTurns: restoredFork.turns.length, modelRequests: 9, cleanShutdowns: 2 };
  });
  report.status = regressions.length ? "failed" : "passed";
  if (regressions.length) { report.regressions = regressions; process.exitCode = 1; }
} catch (error) {
  report.status = "failed";
  report.failedStep = activeStep;
  report.error = error.stack ?? String(error);
  if (client?.stderr) report.serverStderr = client.stderr;
  if (mock?.violations.length) report.mockViolations = mock.violations;
  process.exitCode = 1;
} finally {
  if (client && !client.exit) {
    try { await client.stop(); } catch (error) { report.cleanupError = error.message; report.status = "failed"; process.exitCode = 1; }
  }
  if (mock) await mock.close();
  report.durationMs = Date.now() - started;
  if (temporary) {
    if (keep || report.status !== "passed") {
      report.retainedFixture = temporary;
      report.validationReport = join(temporary, "validation-report.json");
      await writeFile(report.validationReport, `${JSON.stringify(report, null, 2)}\n`);
    } else await rm(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report, null, 2));
}
