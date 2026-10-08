import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * A replacement's first prompt is submitted by Main, without the composer's
 * optimistic row. Publish it before SDK input/memory hooks, and retire it only
 * after the real user message has reached the transcript. The returned promise
 * still belongs to the whole run, just like sendUserMessage.
 */
export async function sendOpeningPrompt(
  session: Pick<AgentSession, "subscribe">,
  send: () => Promise<void>,
  finish: (delivered: boolean) => void,
): Promise<void> {
  let delivered = false;
  let finished = false;
  const settle = (): void => {
    if (finished) return;
    finished = true;
    unsubscribe();
    finish(delivered);
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "message_end" || event.message.role !== "user") return;
    delivered = true;
    // The SDK appends the entry after notifying subscribers. Main's persistence
    // callback is queued first, so snapshots never see a gap between the two rows.
    queueMicrotask(settle);
  });
  try {
    await send();
  } finally {
    // Input handlers can consume a prompt, and auth can refuse it, without ever
    // starting an agent. Neither path may leave the composer locked.
    settle();
  }
}
