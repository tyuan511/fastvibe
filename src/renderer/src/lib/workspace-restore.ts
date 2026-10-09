import type { EngineStatusState } from "../../../shared/types.ts";

/** Coordinate the first catalog/status replies before revealing the workspace. */
export function createWorkspaceRestore(options: {
  hasSelection: () => boolean;
  restore: (id: string) => Promise<void>;
  onSettled: () => void;
  onError: (error: unknown) => void;
}) {
  let status: EngineStatusState | null = null;
  let catalogKnown = false;
  let pendingId: string | null = null;
  let started = false;
  let disposed = false;

  const settle = (): void => {
    if (!disposed) options.onSettled();
  };
  const fail = (error: unknown): void => {
    if (disposed) return;
    started = true;
    options.onError(error);
    settle();
  };
  const advance = (): void => {
    if (disposed || started || status === null || status === "starting") return;
    // Leave settings/retry accessible on engine failure. Keep the pending restore
    // available if the engine subsequently starts successfully.
    if (status === "error" || status === "missing") {
      settle();
      return;
    }
    if (!catalogKnown) return;
    started = true;
    if (!pendingId || options.hasSelection()) {
      settle();
      return;
    }
    // The promise includes applying the transcript, not just requesting it. An
    // idle engine can be opened too: conversations.open starts it when needed.
    void options.restore(pendingId).then(settle, fail);
  };

  return {
    setStatus(next: EngineStatusState): void {
      status = next;
      advance();
    },
    setConversation(id: string | null): void {
      catalogKnown = true;
      pendingId = id;
      advance();
    },
    fail,
    dispose(): void { disposed = true; },
  };
}
