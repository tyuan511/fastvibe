import { Ipc } from "../shared/ipc.ts";
import { conversationScope } from "../shared/app-protocol.ts";
import type { StreamWatch } from "../main/pi/process-manager";

/** The part of the App Server the stream watch needs; a fake stands in for it in tests. */
export type StreamWatchServer = {
  shouldRetainStream(scope: string): boolean;
  publish(channel: string, payload: unknown, options?: { namedOnly?: boolean }): unknown;
};

/**
 * How a background conversation's live stream reaches the clients watching it.
 *
 * The engine forwards a streamed payload only for its active conversation, and hands the
 * rest to this watch — when there is one. Without it every other conversation's reply is
 * dropped on the floor. A phone never activates a chat (that would move every desktop
 * window onto it), so for a headless Agent *all* of the phone's chats are background
 * chats: the run finished on the server, its transcript was complete, and the phone saw a
 * spinner and then nothing. The desktop installs the same watch in `main/index.ts`; the
 * Agent had no such call, which stayed hidden because a desktop attached over SSH always
 * makes the chat it is showing the active one.
 *
 * Published `namedOnly`: only a client that subscribed to `conversation:<id>` by name
 * receives it, never a `*` subscriber, so a token stream is not fanned out to a client
 * that has no use for it.
 */
export function agentStreamWatch(server: StreamWatchServer): StreamWatch {
  return {
    isWatched: (conversationId) => server.shouldRetainStream(conversationScope(conversationId)),
    publish: (event) => {
      server.publish(Ipc.event, event, { namedOnly: true });
    },
  };
}
