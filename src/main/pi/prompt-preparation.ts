import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Stop during preflight must refuse the prompt before the provider is called.
 *
 * pi 1.2.0 marks the session busy for the whole of `before_agent_start`, and calls
 * `preflightResult("started")` only after that hook, from a path that does not catch.
 * Throwing there skips the run's cleanup and leaves the session busy forever. The
 * refusal is therefore thrown from `_prepareRun`, whose caller clears the busy flag
 * and rejects the prompt before `agent.prompt`.
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
    const raw = session as unknown as { _prepareRun?: (trigger: unknown) => Promise<unknown> };
    const prepare = raw._prepareRun?.bind(raw);
    if (prepare) {
      raw._prepareRun = async (trigger) => {
        const messages = await prepare(trigger);
        // The hook resumed because Stop aborted this signal. Reject here, while
        // `_startRun` still catches, so the provider is never called and the
        // session does not stay busy.
        if (this.signal(conversationId)?.aborted) {
          throw new DOMException("Prompt preparation stopped", "AbortError");
        }
        return messages;
      };
    }
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
      // A caller without `_prepareRun` (and any future SDK that reports "started"
      // while Stop is already in) still has to reject. Do not throw inside the
      // callback: 1.2.0 invokes it from a path that does not catch.
      let refused: DOMException | undefined;
      try {
        await this.#context.run({ conversationId, signal: controller.signal }, () => prompt(text, {
          ...options,
          preflightResult: (outcome) => {
            finish();
            if (controller.signal.aborted) {
              refused = new DOMException("Prompt preparation stopped", "AbortError");
              return;
            }
            options?.preflightResult?.(outcome);
          },
        }));
      } finally {
        finish();
      }
      if (refused) throw refused;
    };
  }
}
