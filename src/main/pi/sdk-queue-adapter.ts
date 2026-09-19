import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SdkQueueClaims } from "../engine/message-queue";

/**
 * This adapter intentionally targets the private queue shape in pi-agent-core 0.85.1.
 * package.json pins that exact version; fail closed if the shape changes instead of
 * silently turning a cancellation into clear-and-replay.
 */
export const SUPPORTED_PI_AGENT_CORE_VERSION = "0.85.1";

type PendingQueue = {
  messages: AgentMessage[];
  mode: "all" | "one-at-a-time";
  drain: () => AgentMessage[];
};

type SupportedAgent = {
  steeringQueue: PendingQueue;
  followUpQueue: PendingQueue;
  steer: (message: AgentMessage) => void;
  followUp: (message: AgentMessage) => void;
  prompt: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
};

export type SdkQueueAdapter = {
  /** Check exact-object membership before committing the matching durable mutation. */
  hasPending(id: string): boolean;
  /** Remove only an object still owned by the SDK queue. False means it was already taken. */
  cancelPending(id: string): boolean;
  /** Ids still physically present in either SDK queue. */
  pendingIds(): string[];
};

function supportedQueue(value: unknown): value is PendingQueue {
  if (!value || typeof value !== "object") return false;
  const queue = value as Partial<PendingQueue>;
  return Array.isArray(queue.messages) &&
    (queue.mode === "all" || queue.mode === "one-at-a-time") &&
    typeof queue.drain === "function";
}

/**
 * Attach durable ids to the exact SDK message objects and observe the real dequeue
 * boundary. Merely calling `agent.steer()` does not claim a row: the object remains
 * cancellable until pi-agent-core's `PendingMessageQueue.drain()` takes it for the
 * agent loop (`getSteeringMessages`).
 */
export function installSdkQueueAdapter(
  value: unknown,
  options: {
    currentId: () => string | undefined;
    onClaim: (id: string) => void;
    claims: SdkQueueClaims;
  },
): SdkQueueAdapter {
  const agent = value as Partial<SupportedAgent>;
  if (
    !supportedQueue(agent.steeringQueue) ||
    !supportedQueue(agent.followUpQueue) ||
    typeof agent.steer !== "function" ||
    typeof agent.followUp !== "function" ||
    typeof agent.prompt !== "function"
  ) {
    throw new Error(`Unsupported pi-agent-core queue internals; expected ${SUPPORTED_PI_AGENT_CORE_VERSION}`);
  }

  const byId = new Map<string, AgentMessage>();
  const idByMessage = new WeakMap<object, string>();
  const remember = (message: AgentMessage): void => {
    const id = options.currentId();
    if (!id) return;
    byId.set(id, message);
    idByMessage.set(message as object, id);
  };
  const forget = (message: AgentMessage): void => {
    const id = idByMessage.get(message as object);
    if (id && byId.get(id) === message) byId.delete(id);
  };

  const wrapEnqueue = (name: "steer" | "followUp"): void => {
    const original = agent[name]!.bind(agent);
    agent[name] = (message: AgentMessage) => {
      remember(message);
      try {
        original(message);
      } catch (error) {
        forget(message);
        throw error;
      }
    };
  };

  const wrapDrain = (queue: PendingQueue): void => {
    const original = queue.drain.bind(queue);
    queue.drain = () => {
      const selected = queue.mode === "all" ? queue.messages.slice() : queue.messages.slice(0, 1);
      // Commit ownership before the SDK removes the objects. If persistence fails,
      // throw and leave its queue untouched so the caller can pause without loss.
      for (const message of selected) {
        const id = idByMessage.get(message as object);
        if (id) options.onClaim(id);
      }
      const drained = original();
      for (const message of drained) {
        const id = idByMessage.get(message as object);
        if (!id) continue;
        options.claims.claim(message as object, id);
        forget(message);
      }
      return drained;
    };
  };

  wrapEnqueue("steer");
  wrapEnqueue("followUp");
  wrapDrain(agent.steeringQueue);
  wrapDrain(agent.followUpQueue);

  // A durable row sent while idle enters as the run's initial prompt rather than an
  // SDK pending queue. agent.prompt is its actual ownership boundary.
  const prompt = agent.prompt.bind(agent);
  agent.prompt = async (messages: AgentMessage | AgentMessage[]) => {
    const list = Array.isArray(messages) ? messages : [messages];
    const message = list.find((entry) => entry.role === "user");
    const id = message ? options.currentId() : undefined;
    if (message && id) {
      options.onClaim(id);
      options.claims.claim(message as object, id);
    }
    await prompt(messages);
  };

  return {
    hasPending(id) {
      const message = byId.get(id);
      return Boolean(message && [agent.steeringQueue!, agent.followUpQueue!].some((queue) => queue.messages.includes(message)));
    },
    cancelPending(id) {
      const message = byId.get(id);
      if (!message) return false;
      let removed = false;
      for (const queue of [agent.steeringQueue!, agent.followUpQueue!]) {
        const next = queue.messages.filter((entry) => entry !== message);
        if (next.length !== queue.messages.length) {
          queue.messages = next;
          removed = true;
        }
      }
      if (removed) forget(message);
      return removed;
    },
    pendingIds() {
      const ids: string[] = [];
      for (const queue of [agent.steeringQueue!, agent.followUpQueue!]) {
        for (const message of queue.messages) {
          const id = idByMessage.get(message as object);
          if (id) ids.push(id);
        }
      }
      return ids;
    },
  };
}
