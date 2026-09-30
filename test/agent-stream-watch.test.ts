import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentStreamWatch } from "../src/agent/stream-watch.ts";
import { Ipc } from "../src/shared/ipc.ts";

function fakeServer(named: string[] = []) {
  const published: Array<{ channel: string; payload: unknown; options?: { namedOnly?: boolean } }> = [];
  return {
    published,
    server: {
      hasNamedSubscriber: (scope: string) => named.includes(scope),
      publish: (channel: string, payload: unknown, options?: { namedOnly?: boolean }) => {
        published.push({ channel, payload, options });
      },
    },
  };
}

test("a conversation is watched when some client subscribed to its scope by name", () => {
  const { server } = fakeServer(["conversation:abc"]);
  const watch = agentStreamWatch(server);
  assert.equal(watch.isWatched("abc"), true);
  assert.equal(watch.isWatched("other"), false);
});

test("a background event goes to named subscribers only", () => {
  const { server, published } = fakeServer(["conversation:abc"]);
  const event = { type: "message_update", conversationId: "abc" };
  agentStreamWatch(server).publish(event);
  assert.deepEqual(published, [{ channel: Ipc.event, payload: event, options: { namedOnly: true } }]);
});

// The engine drops every non-active conversation's stream unless a watch is installed,
// and the phone never activates a chat, so a headless Agent that forgets this call
// serves a phone that sees a spinner and never the reply. It is a call in a module with
// side effects, so pin it at the source.
test("the headless agent installs the stream watch on its engine", () => {
  const source = readFileSync(new URL("../src/agent/main.ts", import.meta.url), "utf8");
  assert.match(source, /runtime\.engine\.setStreamWatch\(agentStreamWatch\(appServer\)\)/);
});
