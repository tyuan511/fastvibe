import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * The SDK has no run signal while before_agent_start is waiting. Track preflight
 * separately so Stop cancels memory and refuses the prompt before it starts a run.
 */
export class PromptPreparations {
  readonly #context = new AsyncLocalStorage<{ conversationId: string; signal: AbortSignal }>();
  readonly #pending = new Map<string, Set<AbortController>>();

  signal(conversationId: string): AbortSignal | undefined {
    const current = this.#context.getStore();
    return current?.conversationId === conversationId ? current.signal : undefined;
  }

  cancel(conversationId?: string): void {
    const groups = conversationId === undefined ? this.#pending.values() : [this.#pending.get(conversationId)];
    for (const group of groups) {
      for (const controller of group ?? []) controller.abort(new DOMException("Prompt preparation stopped", "AbortError"));
    }
  }

  install(conversationId: string, session: Pick<AgentSession, "prompt">): void {
    const prompt = session.prompt.bind(session);
    session.prompt = async (text, options) => {
      const controller = new AbortController();
      const group = this.#pending.get(conversationId) ?? new Set<AbortController>();
      group.add(controller);
      this.#pending.set(conversationId, group);
      const finish = (): void => {
        group.delete(controller);
        if (group.size === 0 && this.#pending.get(conversationId) === group) this.#pending.delete(conversationId);
      };
      try {
        await this.#context.run({ conversationId, signal: controller.signal }, () => prompt(text, {
          ...options,
          preflightResult: (outcome) => {
            controller.signal.throwIfAborted();
            finish();
            options?.preflightResult?.(outcome);
          },
        }));
      } finally {
        finish();
      }
    };
  }
}
