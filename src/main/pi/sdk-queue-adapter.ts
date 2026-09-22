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
    /** A loop read refused this row's claim; its object was taken out of the SDK queue. */
    onWithdraw?: (id: string) => void;
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
  // Ids whose object the run already took. A queue token stays in async scope for the
  // whole run it started, so an extension's own steer/followUp (goal mode continuing
  // from `agent_end`) or a later prompt would otherwise be filed under that spent id —
  // and claiming it a second time is refused, which failed the run.
  const spent = new Set<string>();
  const tokenId = (): string | undefined => {
    const id = options.currentId();
    return id && !spent.has(id) ? id : undefined;
  };
  const remember = (message: AgentMessage): void => {
    const id = tokenId();
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
      // Every drain in 0.86.1 is a delivery: the agent loop's steering/follow-up
      // polls and `agent.continue()` both hand the drained objects to the run as-is.
      // The claim therefore cannot depend on which submission the read happens in.
      // It used to: a steer read by a run the user started directly (no queue token
      // in scope) was delivered unclaimed, so its row stayed 发送中 forever and could
      // not even be cancelled ("already claimed").
      //
      // Commit each claim before the SDK removes the objects. The read is the loop's
      // and must never throw into it: an object whose claim is refused (its queue was
      // paused, its row is gone, or the write failed) is withdrawn, not delivered.
      const claimedHere = new Set<string>();
      for (;;) {
        const selected = queue.mode === "all" ? queue.messages.slice() : queue.messages.slice(0, 1);
        let withdrawn = false;
        for (const message of selected) {
          const id = idByMessage.get(message as object);
          if (!id || claimedHere.has(id)) continue;
          try {
            options.onClaim(id);
            claimedHere.add(id);
            spent.add(id);
          } catch {
            queue.messages = queue.messages.filter((entry) => entry !== message);
            forget(message);
            options.onWithdraw?.(id);
            withdrawn = true;
          }
        }
        if (!withdrawn) break;
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
    const id = message ? tokenId() : undefined;
    if (message && id) {
      options.onClaim(id);
      spent.add(id);
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
  };
}
