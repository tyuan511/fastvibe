import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * 帮我批准 with the decision model (docs/decision-layer.md §7.11), through the real
 * sandbox extension with a stub `pi` and a stub judge. What must hold: the judge can
 * waive a prompt the patterns wanted and add one they missed; a `hard` rule never reaches
 * it; no answer means the patterns decide; and `ask` mode never consults it.
 */

type Judged = { tool: string; subject: string; ruleFlags: string[]; insideWorkspace?: boolean };
type ToolCall = (event: { toolName: string; input: unknown }, ctx: unknown) => Promise<{ block?: boolean } | undefined>;

async function sandbox(verdict: "allow" | "ask" | null | undefined) {
  const scope = globalThis as Record<string, unknown>;
  const judged: Judged[] = [];
  if (verdict === undefined) delete scope.__fastvibeApprovalJudge;
  else
    scope.__fastvibeApprovalJudge = async (call: Judged) => {
      judged.push(call);
      return verdict;
    };
  let onToolCall: ToolCall | undefined;
  const pi = {
    on: (event: string, handler: ToolCall) => {
      if (event === "tool_call") onToolCall = handler;
    },
    registerCommand: () => undefined,
  };
  const module = await import(`../resources/extensions/permission-sandbox.ts?t=${Date.now()}-${Math.random()}`);
  module.default(pi as never);
  const prompts: string[] = [];
  const ctx = {
    cwd: "/work/app",
    hasUI: true,
    signal: undefined,
    ui: {
      confirm: async (_title: string, message: string) => {
        prompts.push(message);
        return true;
      },
    },
  };
  const run = async (toolName: string, input: unknown) => {
    const before = prompts.length;
    await onToolCall!({ toolName, input }, ctx);
    return prompts.length > before;
  };
  return { run, judged };
}

function withMode<T>(mode: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FASTVIBE_PERMISSION_MODE;
  process.env.FASTVIBE_PERMISSION_MODE = mode;
  return fn().finally(() => {
    if (previous === undefined) delete process.env.FASTVIBE_PERMISSION_MODE;
    else process.env.FASTVIBE_PERMISSION_MODE = previous;
  });
}

test("allow waives a prompt the patterns wanted", () =>
  withMode("smart", async () => {
    const { run, judged } = await sandbox("allow");
    assert.equal(await run("bash", { command: "rm -rf dist" }), false);
    assert.equal(judged.length, 1);
    assert.deepEqual(judged[0].ruleFlags, ["Recursive delete", "Force delete"]);
  }));

test("ask adds a prompt the patterns missed", () =>
  withMode("smart", async () => {
    const { run } = await sandbox("ask");
    assert.equal(await run("bash", { command: "find . -name '*.ts' -delete" }), true);
  }));

test("no verdict leaves it to the patterns", () =>
  withMode("smart", async () => {
    const { run } = await sandbox(null);
    assert.equal(await run("bash", { command: "rm -rf dist" }), true);
    assert.equal(await run("bash", { command: "npm test" }), false);
  }));

test("with no judge installed the patterns decide", () =>
  withMode("smart", async () => {
    const { run } = await sandbox(undefined);
    assert.equal(await run("bash", { command: "rm -rf dist" }), true);
  }));

test("a hard rule is never put to the judge", () =>
  withMode("smart", async () => {
    const { run, judged } = await sandbox("allow");
    assert.equal(await run("bash", { command: "sudo rm -rf /var/cache/app" }), true);
    assert.equal(await run("write", { path: "/Users/me/.ssh/config" }), true);
    assert.equal(judged.length, 0);
  }));

test("workspace writes the patterns pass are not sent; flagged writes are", () =>
  withMode("smart", async () => {
    const { run, judged } = await sandbox("allow");
    assert.equal(await run("edit", { path: "src/index.ts" }), false);
    assert.equal(judged.length, 0);
    assert.equal(await run("write", { path: "/tmp/scratch.txt" }), false);
    assert.equal(judged.length, 1);
    assert.equal(judged[0].insideWorkspace, false);
  }));

test("ask mode never consults the judge", () =>
  withMode("ask", async () => {
    const { run, judged } = await sandbox("allow");
    assert.equal(await run("bash", { command: "rm -rf dist" }), true);
    assert.equal(judged.length, 0);
  }));

test("batch_decide is a network call: ask confirms it, smart does not", async () => {
  const input = { instructions: "Label each issue", items: [{ id: "a" }, { id: "b" }] };
  await withMode("ask", async () => {
    const { run } = await sandbox(undefined);
    assert.equal(await run("batch_decide", input), true);
  });
  await withMode("smart", async () => {
    const { run, judged } = await sandbox("ask");
    assert.equal(await run("batch_decide", input), false);
    assert.equal(judged.length, 0);
  });
});
