import assert from "node:assert/strict";
import test from "node:test";
import { viviSurfaceLayout } from "../src/main/vivi/panel-bounds.ts";
import { ViviAgentActivity, viviClickFeedback } from "../src/renderer/src/lib/vivi-agent-activity.ts";
import type { EngineEvent } from "../src/shared/types.ts";

const event = (value: Record<string, unknown>) => value as EngineEvent;

test("measured text dimensions reach the surface without fixed width or height floors", () => {
  const area = { x: 0, y: 24, width: 1440, height: 816 };
  const pet = { x: 600, y: 500, width: 140, height: 140 };
  for (const [width, height] of [[68, 36], [154, 36], [280, 76]]) {
    const layout = viviSurfaceLayout(pet, area, height, 0, width);
    assert.equal(layout.bubble?.width, width);
    assert.equal(layout.bubble?.height, height);
    assert.equal(layout.composer, undefined);
    assert.equal(layout.window.x + layout.pet.x, pet.x);
    assert.equal(layout.window.y + layout.pet.y, pet.y);
  }
});

test("corner close button fits within transparent margins and the bubble sits closer to Vivi", () => {
  const area = { x: 0, y: 24, width: 1440, height: 816 };
  for (const pet of [{ x: 0, y: 24, width: 140, height: 140 }, { x: 1300, y: 700, width: 140, height: 140 }, { x: 600, y: 400, width: 140, height: 140 }]) {
    const layout = viviSurfaceLayout(pet, area, 36, 0, 154);
    const bubble = layout.bubble!;
    assert.ok(bubble.x >= 14 && bubble.y >= 14);
    assert.ok(bubble.x + bubble.width + 14 <= layout.window.width);
    assert.ok(bubble.y + bubble.height + 14 <= layout.window.height);
    const gap = layout.pet.y > bubble.y ? layout.pet.y - bubble.y - bubble.height : bubble.y - layout.pet.y - layout.pet.height;
    assert.equal(gap, 2);
  }
});

test("expanded bubbles preserve pet position, size and screen containment at every corner", () => {
  for (const area of [{ x: 0, y: 24, width: 1440, height: 816 }, { x: -1920, y: -500, width: 1920, height: 1080 }]) {
    for (const x of [area.x, area.x + area.width - 140]) {
      for (const y of [area.y, area.y + area.height - 140]) {
        const pet = { x, y, width: 140, height: 140 };
        const layout = viviSurfaceLayout(pet, area, 460);
        assert.equal(layout.window.x + layout.pet.x, x);
        assert.equal(layout.window.y + layout.pet.y, y);
        assert.equal(layout.pet.width, 140);
        assert.equal(layout.pet.height, 140);
        assert.ok(layout.window.x >= area.x && layout.window.y >= area.y);
        assert.ok(layout.window.x + layout.window.width <= area.x + area.width);
        assert.ok(layout.window.y + layout.window.height <= area.y + area.height);
        assert.ok(layout.bubble);
        assert.deepEqual(viviSurfaceLayout(pet, area, 0).window, pet);
      }
    }
  }
});

test("compact text and chat controls stay inside one transparent window without moving Vivi", () => {
  for (const area of [{ x: 0, y: 24, width: 1440, height: 816 }, { x: -1600, y: -900, width: 1600, height: 900 }]) {
    for (const x of [area.x, area.x + 600, area.x + area.width - 140]) {
      for (const y of [area.y, area.y + 300, area.y + area.height - 140]) {
        const pet = { x, y, width: 140, height: 140 };
        for (const [height, controls] of [[0, 42], [80, 42], [148, 70], [460, 42]]) {
          const layout = viviSurfaceLayout(pet, area, height, controls);
          assert.equal(layout.window.x + layout.pet.x, x);
          assert.equal(layout.window.y + layout.pet.y, y);
          assert.ok(layout.composer);
          assert.ok(layout.window.x >= area.x && layout.window.y >= area.y);
          assert.ok(layout.window.x + layout.window.width <= area.x + area.width);
          assert.ok(layout.window.y + layout.window.height <= area.y + area.height);
          assert.ok(layout.composer.height > 0);
          if (layout.bubble) {
            const a = layout.bubble;
            const b = layout.composer;
            assert.ok(a.y + a.height <= b.y || b.y + b.height <= a.y || a.x + a.width <= b.x || b.x + b.width <= a.x);
          }
        }
      }
    }
  }
});

test("streamed reply text is bounded, survives catalog refresh and rejects stale snapshots", () => {
  const state = new ViviAgentActivity();
  state.setCatalog([{ id: "a", title: "Task A" }, { id: "b", title: "Task B" }]);
  state.event(event({ type: "conversation_running", conversationId: "a", running: true }));
  const revision = state.agents[0].replyRevision ?? 0;
  const pendingRevision = state.revision;
  state.event(event({ type: "message_update", conversationId: "a", assistantMessageEvent: { type: "text_delta", delta: "Hello " } }));
  state.event(event({ type: "message_update", conversationId: "a", assistantMessageEvent: { type: "text_delta", delta: "there" } }));
  assert.equal(state.agents[0].reply, "Hello there");
  assert.equal(state.setReply("a", "outdated", revision), false);
  assert.equal(state.revision, pendingRevision, "text streaming must not starve pending-prompt refresh");
  state.setCatalog([{ id: "a", title: "Renamed task" }, { id: "b", title: "Task B" }]);
  assert.equal(state.agents[0].reply, "Hello there");
  assert.equal(state.agents[1].reply, undefined);
  state.event(event({ type: "message_update", conversationId: "a", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(10000) } }));
  assert.equal(state.agents[0].reply?.length, 4000);
  state.event(event({ type: "conversation_running", conversationId: "a", running: true }));
  assert.equal(state.agents[0].reply, "");
});

test("requests queue across conversations and dismiss only the matching id", () => {
  const state = new ViviAgentActivity();
  state.event(event({ type: "extension_ui_request", method: "confirm", id: "a", conversationId: "chat-a", title: "Allow?" }));
  state.event(event({ type: "extension_ui_request", method: "input", id: "b", conversationId: "chat-b", title: "Name?" }));
  state.event(event({ type: "extension_ui_request", method: "select", id: "c", conversationId: "chat-a", options: ["one", "two"] }));
  assert.deepEqual(state.requests.map((request) => request.id), ["a", "b", "c"]);
  state.event(event({ type: "extension_ui_dismiss", id: "a", conversationId: "chat-a" }));
  assert.deepEqual(state.requests.map((request) => request.id), ["b", "c"]);
  state.remove("b");
  assert.equal(state.requests[0].id, "c");
});

test("authoritative refresh rejects stale reads and preserves remote namespaced prompts", () => {
  const state = new ViviAgentActivity();
  const revision = state.revision;
  state.event(event({ type: "extension_ui_request", method: "editor", id: "new", prefill: "Keep this" }));
  assert.equal(state.restore([], [], revision), false);
  assert.equal(state.requests[0].id, "new");
  const id = "remote:server:request";
  const conversationId = "remote:server:chat";
  assert.equal(state.restore([{ type: "extension_ui_request", method: "questions", id, conversationId, questions: [{ question: "Choose?", options: ["A", "B"], allowOther: true }] }], []), true);
  assert.equal(state.requests[0].id, id);
  assert.equal(state.requests[0].conversationId, conversationId);
  assert.equal(state.requests[0].questions?.[0].allowOther, true);
  state.restore([], []);
  assert.equal(state.requests.length, 0);
});

test("agent titles, tools, thinking and completion expiry follow real events", () => {
  let now = 0;
  const state = new ViviAgentActivity(() => now);
  state.setCatalog([{ id: "chat", title: "Build a page" }]);
  state.restore([], ["chat"]);
  state.event(event({ type: "message_update", conversationId: "chat", assistantMessageEvent: { type: "thinking_start" } }));
  assert.equal(state.agents[0].mood, "thinking");
  state.restore([], ["chat"]);
  assert.equal(state.agents[0].mood, "thinking");
  state.event(event({ type: "tool_execution_start", conversationId: "chat", toolName: "write" }));
  assert.equal(state.agents[0].title, "Build a page");
  assert.equal(state.agents[0].tool, "write");
  state.event(event({ type: "conversation_activity", conversationId: "chat", status: "completed" }));
  assert.equal(state.agents[0].mood, "success");
  now = 5001;
  assert.equal(state.agents[0].mood, "idle");
});

test("click feedback is varied, localized and wraps safely", () => {
  assert.notEqual(viviClickFeedback("zh", 0), viviClickFeedback("zh", 1));
  assert.match(viviClickFeedback("en", 0), /here/);
  for (const index of [-1, 0, 50]) assert.ok(viviClickFeedback("zh", index));
});
