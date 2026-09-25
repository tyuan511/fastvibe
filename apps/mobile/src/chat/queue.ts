/** Native client's validated projection of shared ConversationQueueState. */
export type QueueItem = {
  id: string;
  text: string;
  behavior: "steer" | "followUp";
  sending?: boolean;
  claimed?: boolean;
};
export type QueueState = {
  conversationId: string;
  revision: number;
  items: QueueItem[];
  pause: "stopped" | "error" | null;
};
type QueuedPromptPreview = {
  previousTitle: string;
  previousPreview?: string;
  nextTitle: string;
  nextPreview?: string;
};

type Caller = { call(method: string, payload?: unknown, timeoutMs?: number): Promise<unknown> };

/** A lost acknowledgement is not proof of refusal; never encourage a duplicate send. */
export class SubmissionUncertainError extends Error {
  constructor() {
    super("未收到发送确认，请在连接恢复后检查队列和聊天记录，避免重复发送");
    this.name = "SubmissionUncertainError";
  }
}

export function emptyQueue(conversationId: string): QueueState {
  return { conversationId, revision: -1, items: [], pause: null };
}

/** All replies and pushes pass through this gate, including cancel/resume replies. */
export function mergeQueue(current: QueueState, value: unknown): QueueState {
  if (!isRecord(value) || value.conversationId !== current.conversationId ||
      typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) ||
      value.revision < current.revision || !Array.isArray(value.items) ||
      (value.pause !== null && value.pause !== "stopped" && value.pause !== "error")) return current;
  const items: QueueItem[] = [];
  for (const item of value.items) {
    // Do not silently empty part of an invalid queue: it could make Send bypass it.
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.text !== "string" ||
        item.conversationId !== current.conversationId ||
        (item.behavior !== "steer" && item.behavior !== "followUp")) return current;
    items.push({ id: item.id, text: item.text, behavior: item.behavior, sending: item.sending === true, claimed: item.claimed === true });
  }
  return { conversationId: current.conversationId, revision: value.revision, items, pause: value.pause };
}

/** Capture before any await: a Stop during record-prompt must keep this send queued. */
export function shouldQueueMessage(running: boolean, queue: QueueState): boolean {
  return running || queue.items.length > 0;
}

export function shouldHoldSend(sending: boolean, queueLoading: boolean): boolean {
  return sending || queueLoading;
}

/** Uses the host's durable queue, never prompt's implicit mid-run steering. */
export async function submitMessage(
  remote: Caller,
  input: {
    conversationId: string;
    text: string;
    enqueue: boolean;
    previous?: { title: string; preview?: string };
  },
  onPrompt: () => void,
): Promise<unknown> {
  const { conversationId, text, enqueue, previous } = input;
  const catalog = await remote.call("conversations:record-prompt", { id: conversationId, text });
  let preview: QueuedPromptPreview | undefined;
  if (previous && isRecord(catalog) && Array.isArray(catalog.conversations)) {
    const next = catalog.conversations.find((item) => isRecord(item) && item.id === conversationId);
    if (isRecord(next) && typeof next.title === "string") {
      preview = { previousTitle: previous.title, previousPreview: previous.preview,
        nextTitle: next.title, nextPreview: typeof next.preview === "string" ? next.preview : undefined };
    }
  }
  let dispatched = false;
  try {
    if (enqueue) {
      const settings = await remote.call("settings:get");
      // /compact is a command; steering it would inject the literal text into a run.
      const compact = /^\/compact(?:\s|$)/.test(text);
      const behavior = !compact && isRecord(settings) && settings.queueBehavior === "steer" ? "steer" : "followUp";
      dispatched = true;
      return await remote.call("engine:queue-add", { conversationId, text, message: text, behavior, preview });
    }
    // Only a direct submission gets an optimistic transcript row. Queued prompts
    // appear there when Main actually delivers them, not when they enter the tray.
    onPrompt();
    dispatched = true;
    await remote.call("engine:prompt", { message: text, conversationId }, 60_000);
    return null;
  } catch (error) {
    // RemoteClient uses these errors when it cannot know whether Main committed.
    if (dispatched && error instanceof Error && /^(请求超时|连接已断开|连接已关闭)$/.test(error.message)) {
      throw new SubmissionUncertainError();
    }
    if (preview) {
      await remote.call("conversations:restore-prompt", {
        id: conversationId, expectedTitle: preview.nextTitle, expectedPreview: preview.nextPreview,
        title: preview.previousTitle, preview: preview.previousPreview,
      }).catch(() => undefined);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
