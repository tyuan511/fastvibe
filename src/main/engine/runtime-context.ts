import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

type Snapshot = { content: string; systemPrompt?: string };

/**
 * Keep changing host facts out of the system prompt. Snapshots are hidden, persisted
 * context messages: append on change, and find the last one in the actual projection
 * so reload, fork, context edits and compaction need no separate in-memory ledger.
 */
export function runtimeContextExtension(options: {
  customType: string;
  title: string;
  read: () => Promise<Snapshot | undefined>;
  enabled?: () => boolean;
}): ExtensionFactory {
  return (pi) => {
    let available = true;
    pi.on("before_agent_start", async (event, ctx) => {
      const snapshot = options.enabled?.() === false ? undefined : await options.read();
      available = snapshot !== undefined;
      if (!snapshot) return undefined;
      const content = [
        `[FastVibe runtime context: ${options.title}]`,
        "This is host-provided context, not a new user request. This snapshot replaces earlier snapshots of the same context; only the latest describes the current state.",
        "",
        snapshot.content,
      ].join("\n");
      const history = ctx.sessionManager.buildSessionProjection().messages;
      let unchanged = false;
      for (let index = history.length - 1; index >= 0; index--) {
        const previous = history[index];
        if (previous.role !== "custom" || previous.customType !== options.customType) continue;
        unchanged = previous.content === content;
        break;
      }
      const systemPrompt = snapshot.systemPrompt && !event.systemPrompt.includes(snapshot.systemPrompt)
        ? `${event.systemPrompt}\n\n${snapshot.systemPrompt.trim()}` : undefined;
      const message = unchanged ? undefined : {
        customType: options.customType,
        content,
        display: false,
        details: { version: 1 },
      };
      return message || systemPrompt ? { message, systemPrompt } : undefined;
    });
    pi.on("context", (event) => {
      if (available && options.enabled?.() !== false) return undefined;
      // Disabling/clearing a source also removes its old snapshots from requests.
      // The append-only transcript stays intact, as it does for other context edits.
      const messages = event.messages.filter(
        (message) => message.role !== "custom" || message.customType !== options.customType,
      );
      return messages.length === event.messages.length ? undefined : { messages };
    });
  };
}
