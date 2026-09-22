import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SdkQueueClaims } from "../engine/message-queue";

/**
 * This adapter intentionally targets the private queue shape in pi-agent-core 0.86.1.
 * package.json pins that exact version; fail closed if the shape changes instead of
 * silently turning a cancellation into clear-and-replay.
 */
export const SUPPORTED_PI_AGENT_CORE_VERSION = "0.86.1";

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
  /**
   * Detach one pending object without touching the SDK queue.
   *
   * The session drains its own steering queue to build an idle run's opening
   * prompt, and the object it drained is no longer in the queue the adapter
   * watches — but the caller still has to claim that exact object, because the
   * delivery acknowledgement matches on object identity. Returns nothing once the
   * agent loop has already taken it.
   */
  takePending(id: string): AgentMessage | undefined;
  /**
   * Make the SDK's next queue read return nothing, once per queue.
   *
   * `agent.continue()` starts a fresh run when the transcript ends on an assistant
   * message, and that run drains both pending queues before it ever looks at the
   * transcript. Those objects were steered while the interrupted run was live and
   * are still owned by FastVibe's queue, so a resume must not deliver them. The
   * suppression is one read only: a steer that arrives after the resumed run has
   * started is a new decision and has to be delivered normally.
   */
  suppressNextDrain(): void;
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

  // One suppressed read per queue, held until that read happens. A resume arms both
  // before it starts. The hold has to span the whole read rather than expire at its
  // start: steering mode is one-at-a-time, so a steer that arrives while the resumed
  // run's first poll is in flight would otherwise land behind the stale head and be
  // the message that poll returns.
  const skipDrains = new WeakSet<PendingQueue>();
  const wrapDrain = (queue: PendingQueue): void => {
    const original = queue.drain.bind(queue);
    queue.drain = () => {
      if (skipDrains.has(queue)) {
        skipDrains.delete(queue);
        return [];
      }
      const selected = queue.mode === "all" ? queue.messages.slice() : queue.messages.slice(0, 1);
      // The agent loop's own read is the claim boundary, and it always happens
      // inside a submission. A drain made outside one — the session builds an idle
      // run's opening prompt by draining this queue itself — leaves the object
      // unclaimed, because that prompt is a different object and the claim on
      // `agent.prompt` never sees this one. The caller reclaims it by identity
      // afterwards (`takePending`). Committing the claim before the SDK removes the
      // objects means a failed write leaves its queue untouched.
      if (options.currentId()) {
        for (const message of selected) {
          const id = idByMessage.get(message as object);
          if (id) options.onClaim(id);
        }
      }
      const drained = original();
      if (options.currentId()) {
        for (const message of drained) {
          const id = idByMessage.get(message as object);
          if (!id) continue;
          options.claims.claim(message as object, id);
          forget(message);
        }
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
    suppressNextDrain() {
      skipDrains.add(agent.steeringQueue!);
      skipDrains.add(agent.followUpQueue!);
    },
    takePending(id) {
      const message = byId.get(id);
      if (!message) return undefined;
      // Still physically queued: the agent loop has not taken it, so claiming it
      // here would acknowledge a delivery that has not happened.
      if ([agent.steeringQueue!, agent.followUpQueue!].some((queue) => queue.messages.includes(message))) return undefined;
      forget(message);
      return message;
    },
  };
}
