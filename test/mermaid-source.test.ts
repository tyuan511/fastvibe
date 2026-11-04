import assert from "node:assert/strict";
import { test } from "node:test";
import { isClosedMermaidFence } from "../src/renderer/src/lib/mermaid-source.ts";

test("Mermaid layout waits for a matching closing fence", () => {
  assert.equal(isClosedMermaidFence("```mermaid\nflowchart LR\nA-->B"), false);
  assert.equal(isClosedMermaidFence("```mermaid\nflowchart LR\nA-->B\n```"), true);
  assert.equal(isClosedMermaidFence("~~~mmd\nsequenceDiagram\nA->>B: hello\n~~~~\n"), true);
  assert.equal(isClosedMermaidFence("````mermaid\nflowchart LR\n```"), false);
  assert.equal(isClosedMermaidFence("```mermaid\nflowchart LR\n~~~"), false);
  assert.equal(isClosedMermaidFence("```mermaid\nflowchart LR\n``` trailing text"), false);
});

test("nested source spans accept quote prefixes and indentation", () => {
  assert.equal(isClosedMermaidFence("```mermaid\n> flowchart LR\n> A-->B\n> ```"), true);
  assert.equal(isClosedMermaidFence("~~~mermaid\n  flowchart LR\n  A-->B\n  ~~~"), true);
});
