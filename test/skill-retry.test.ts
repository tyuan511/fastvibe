import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { mapEngineMessages } from "../src/main/engine/map-messages.ts";
import { skillCommandOf } from "../src/shared/skill-invocation.ts";
import { attachmentPromptSuffix, attachmentsToImages } from "../src/renderer/src/lib/attachments.ts";
import type { ChatAttachment } from "../src/shared/types.ts";

// Exercise the real App callback without mounting Electron/React. In particular,
// testing skillCommandOf alone cannot catch a retry path that forgets to call it.
const source = ts.createSourceFile("App.tsx", readFileSync("src/renderer/src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = "";
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "runRetry" &&
    node.initializer && ts.isCallExpression(node.initializer)) {
    callback = node.initializer.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback);
const compiled = ts.transpileModule(`const retry = ${callback};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const args of ["帮我写个周报", ""]) {
  for (const role of ["user", "assistant"]) {
    test(`retry from ${role} preserves a skill ${args ? "with words" : "on its own"}`, async () => {
      const expanded = '<skill name="office" location="/skills/office/SKILL.md">\nInstructions for the model\n</skill>' + (args ? `\n\n${args}` : "");
      const messages = mapEngineMessages([
        { message: { id: "u1", role: "user", content: expanded, timestamp: 1 } },
        { message: { id: "a1", role: "assistant", content: "reply", timestamp: 2 } },
      ]);
      const payloads: string[] = [];
      const optimistic: string[] = [];
      const state = { activeId: "c1", messages, streaming: false };
      const bindings = {
        retrying: { current: false }, useSessionStore: { getState: () => state }, canChat: true,
        skillCommandOf,
        engine: { branch: async () => [], prompt: async (text: string) => payloads.push(text), getState: async () => null },
        setMessages: () => {}, setDraft: () => {}, addUserMessage: (text: string) => optimistic.push(text),
        attachmentPromptSuffix: () => "", attachmentsToImages: () => undefined,
        setSession: () => {}, dropEmptyAssistant: () => {}, setError: () => {}, isAbortOutcome: () => false,
      };
      const retry = new Function(...Object.keys(bindings), `${compiled}\nreturn retry;`)(...Object.values(bindings));
      await retry(messages[role === "user" ? 0 : 1]);
      const expected = args ? `/skill:office ${args}` : "/skill:office";
      assert.deepEqual(payloads, [expected]);
      assert.deepEqual(optimistic, [expected]);
    });
  }
}

for (const kind of ["image", "file", "paste"] as const) {
  test(`retry preserves a textless ${kind} attachment`, async () => {
    const attachment: ChatAttachment = kind === "image"
      ? { id: "image", kind: "image", name: "image.png", dataUrl: "data:image/png;base64,YWJj", mimeType: "image/png" }
      : kind === "file"
        ? { id: "file", kind: "file", name: "notes.md", path: "/tmp/notes.md" }
        : { id: "paste", kind: "file", name: "pasted.txt", text: "粘贴的正文" };
    const payload = attachmentPromptSuffix([attachment]);
    // Exercise both the optimistic row and the persisted metadata-only row.
    for (const text of ["", payload]) {
      const message = { id: "u1", role: "user", text, tools: [], attachments: [attachment] };
      const sent: unknown[] = [];
      const bindings = {
        retrying: { current: false },
        useSessionStore: { getState: () => ({ activeId: "c1", messages: [message], streaming: false }) },
        canChat: true, skillCommandOf, attachmentPromptSuffix, attachmentsToImages,
        engine: {
          branch: async () => [],
          prompt: async (...args: unknown[]) => { sent.push(args); },
          getState: async () => null,
        },
        setMessages: () => {}, setDraft: () => {}, addUserMessage: () => {}, setSession: () => {},
        dropEmptyAssistant: () => {}, setError: (error: string) => assert.fail(error), isAbortOutcome: () => false,
      };
      const retry = new Function(...Object.keys(bindings), `${compiled}\nreturn retry;`)(...Object.values(bindings));
      await retry(message);
      assert.deepEqual(sent, [[payload, { images: attachmentsToImages([attachment]) }]]);
    }
  });
}
