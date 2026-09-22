import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeTodo,
  parseTodoList,
  todoPosition,
  todoSnapshot,
} from "../src/renderer/src/lib/todos.ts";

/**
 * The todo list is model-authored data, so its parser is the boundary between "the
 * agent wrote something odd" and the UI. The `n/N` position in particular is a rule
 * the project spells out — it names the step in play, not the count of finished ones —
 * and is read by both the panel above the composer and the transcript's card.
 */

test("a status decides the item, and a legacy `done` flag still counts as completed", () => {
  const items = parseTodoList([
    { content: "first", status: "completed" },
    { content: "second", status: "in_progress" },
    { content: "third", done: true },
  ]);
  assert.deepEqual(items.map((item) => item.status), ["completed", "in_progress", "completed"]);
});

test("unknown statuses fall back to pending rather than being dropped", () => {
  // A model inventing a status must not lose the item from the checklist.
  const items = parseTodoList([{ content: "x", status: "almost-done" }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "pending");
});

test("the list is found under the wrapper keys the tool uses", () => {
  assert.equal(parseTodoList({ todos: [{ content: "a", status: "pending" }] }).length, 1);
  assert.equal(parseTodoList({ tasks: [{ content: "a", status: "pending" }] }).length, 1);
  assert.deepEqual(parseTodoList({ nope: [] }), []);
});

test("the live todo call does not replace the panel until execution finishes", () => {
  const messages = [
    {
      id: "assistant",
      role: "assistant" as const,
      text: "",
      tools: [
        {
          id: "old",
          name: "todo",
          status: "done" as const,
          args: { todos: [{ content: "old task", status: "in_progress" }] },
        },
        {
          id: "live",
          name: "todo",
          status: "running" as const,
          args: { todos: [{ content: "new task", status: "in_progress" }] },
        },
      ],
      createdAt: 0,
    },
  ];
  assert.deepEqual(todoSnapshot(messages).items.map((item) => item.content), ["old task"]);

  messages[0].tools[1].status = "done";
  assert.deepEqual(todoSnapshot(messages).items.map((item) => item.content), ["new task"]);
});

test("a list written during the current turn is the panel's list", () => {
  const messages = [
    { id: "u1", role: "user" as const, text: "do the thing", tools: [], createdAt: 0 },
    {
      id: "a1",
      role: "assistant" as const,
      text: "",
      tools: [{ id: "t1", name: "todo", status: "done" as const, args: { todos: [{ content: "step", status: "in_progress" }] } }],
      createdAt: 1,
    },
  ];
  const snapshot = todoSnapshot(messages);
  assert.deepEqual(snapshot.items.map((item) => item.content), ["step"]);
  assert.equal(snapshot.superseded, false);
});

test("a newer user prompt closes a list written for the previous one", () => {
  // The complaint this rule answers: asking something else must not resurface the
  // previous task's leftovers above the composer the moment the new run starts.
  const messages = [
    { id: "u1", role: "user" as const, text: "do the thing", tools: [], createdAt: 0 },
    {
      id: "a1",
      role: "assistant" as const,
      text: "",
      tools: [{ id: "t1", name: "todo", status: "done" as const, args: { todos: [{ content: "step", status: "in_progress" }] } }],
      createdAt: 1,
    },
    { id: "u2", role: "user" as const, text: "unrelated question", tools: [], createdAt: 2 },
  ];
  const snapshot = todoSnapshot(messages);
  assert.deepEqual(snapshot.items.map((item) => item.content), ["step"]);
  assert.equal(snapshot.superseded, true);
});

test("the agent rewriting the list in the new turn un-closes the panel", () => {
  const messages = [
    { id: "u1", role: "user" as const, text: "do the thing", tools: [], createdAt: 0 },
    {
      id: "a1",
      role: "assistant" as const,
      text: "",
      tools: [{ id: "t1", name: "todo", status: "done" as const, args: { todos: [{ content: "old step", status: "pending" }] } }],
      createdAt: 1,
    },
    { id: "u2", role: "user" as const, text: "carry on", tools: [], createdAt: 2 },
    {
      id: "a2",
      role: "assistant" as const,
      text: "",
      tools: [{ id: "t2", name: "todo", status: "done" as const, args: { todos: [{ content: "old step", status: "in_progress" }] } }],
      createdAt: 3,
    },
  ];
  const snapshot = todoSnapshot(messages);
  assert.deepEqual(snapshot.items.map((item) => item.status), ["in_progress"]);
  assert.equal(snapshot.superseded, false);
});

test("a transcript with no todo call has nothing to close", () => {
  const messages = [{ id: "u1", role: "user" as const, text: "hi", tools: [], createdAt: 0 }];
  assert.deepEqual(todoSnapshot(messages), { items: [], superseded: false });
});

test("in_progress wins over pending, whichever comes first", () => {
  const items = parseTodoList([
    { content: "a", status: "pending" },
    { content: "b", status: "in_progress" },
  ]);
  assert.equal(activeTodo(items)?.content, "b");
});

test("the position names the step in play, not the number completed", () => {
  // The project's stated rule: `1/N` from the first moment. Counting completions would
  // read `0/N` here and understate a plan being worked back-to-front.
  const items = parseTodoList([
    { content: "a", status: "in_progress" },
    { content: "b", status: "pending" },
    { content: "c", status: "pending" },
  ]);
  assert.equal(todoPosition(items), 1);
});

test("with nothing in progress the position points at the next pending step", () => {
  const items = parseTodoList([
    { content: "a", status: "completed" },
    { content: "b", status: "completed" },
    { content: "c", status: "pending" },
  ]);
  assert.equal(todoPosition(items), 3);
});

test("a fully finished list reports its length rather than a dangling step", () => {
  const items = parseTodoList([
    { content: "a", status: "completed" },
    { content: "b", status: "cancelled" },
  ]);
  assert.equal(todoPosition(items), 2);
  assert.equal(activeTodo(items), undefined);
});
