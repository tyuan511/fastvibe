import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { parseReviewCommand } from "../src/shared/slash.ts";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = readFileSync(new URL("../src/main/pi/process-manager.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("manager.ts", source, ts.ScriptTarget.Latest, true);
let body = "";
const visit = (node: import("typescript").Node): void => {
  if (ts.isMethodDeclaration(node) && node.name.getText(file) === "#reviewIfCommand") body = node.getText(file).replaceAll("#", "");
  ts.forEachChild(node, visit);
};
visit(file);
assert.ok(body, "the engine still owns a /review interception");
const compiled = ts.transpileModule(`class Harness { ${body} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function fixture(conversation: { id: string; cwd: string } | null = { id: "owner", cwd: "/repo/sub" }) {
  const started: Array<Record<string, unknown>> = [];
  const dependencies = {
    parseReviewCommand,
    uiText: (_zh: string, en: string) => en,
  };
  const Harness = new Function(...Object.keys(dependencies), `${compiled}; return Harness;`)(...Object.values(dependencies));
  const host = new Harness();
  Object.assign(host, {
    catalog: { get: (id: string) => (conversation && id === conversation.id ? conversation : undefined) },
    startReview: async (request: Record<string, unknown>) => { started.push(request); return { id: "agent-review" }; },
  });
  return { host, started };
}

test("the parser accepts only the command itself, with the rest as review requirements", () => {
  assert.deepEqual(parseReviewCommand("/review"), { instructions: undefined });
  assert.deepEqual(parseReviewCommand("  /REVIEW  "), { instructions: undefined });
  assert.deepEqual(parseReviewCommand("/review 重点看停止路径"), { instructions: "重点看停止路径" });
  assert.deepEqual(parseReviewCommand("/review\n第一行\n第二行"), { instructions: "第一行\n第二行" });
  // Not the command: a word that merely starts with it, or an ordinary prompt.
  assert.equal(parseReviewCommand("/reviews are useful"), null);
  assert.equal(parseReviewCommand("please /review this"), null);
  assert.equal(parseReviewCommand("/compact"), null);
});

test("a /review line starts a worktree review of that conversation instead of prompting the model", async () => {
  const f = fixture();
  assert.equal(await f.host.reviewIfCommand("owner", "/review 重点看停止路径"), true);
  assert.deepEqual(f.started, [{
    conversationId: "owner",
    cwd: "/repo/sub",
    scope: "worktree",
    instructions: "重点看停止路径",
    command: "/review 重点看停止路径",
  }]);
});

test("a bare /review keeps the default scope and records the command verbatim for the transcript", async () => {
  const f = fixture();
  await f.host.reviewIfCommand("owner", "/review");
  assert.equal(f.started.length, 1);
  assert.equal("instructions" in f.started[0], false, "no empty requirement is stored");
  assert.equal(f.started[0].command, "/review");
  assert.equal(f.started[0].scope, "worktree");
});

test("anything that is not the command is left to the normal prompt path", async () => {
  const f = fixture();
  for (const text of ["hello", "/reviews are useful", "/compact"]) {
    assert.equal(await f.host.reviewIfCommand("owner", text), false, text);
  }
  assert.deepEqual(f.started, []);
});

test("a command with no conversation, or one that no longer exists, fails before any review starts", async () => {
  const none = fixture(null);
  await assert.rejects(none.host.reviewIfCommand("owner", "/review"), /conversation/i);
  assert.deepEqual(none.started, []);
  const missing = fixture();
  await assert.rejects(missing.host.reviewIfCommand("gone", "/review"), /conversation/i);
  assert.deepEqual(missing.started, []);
});
