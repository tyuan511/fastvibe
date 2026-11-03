import type { EngineEvent, PermissionRequest } from "../../../shared/types.ts";
import { parsePermission } from "../stores/session-reducer.ts";

/** The list API has no snapshot watermark. Replay events observed during the read. */
export function reconcilePendingUi(snapshot: Array<Record<string, unknown>>, events: EngineEvent[]): PermissionRequest[] {
  const pending = new Map<string, PermissionRequest>();
  const apply = (event: EngineEvent): void => {
    if (event.type === "extension_ui_dismiss" && typeof event.id === "string") {
      const previous = pending.get(event.id);
      if (!previous || !event.conversationId || previous.conversationId === event.conversationId) pending.delete(event.id);
      return;
    }
    const request = parsePermission(event);
    if (request) pending.set(request.id, request);
  };
  for (const request of snapshot) apply(request as EngineEvent);
  for (const event of events) apply(event);
  return [...pending.values()];
}

/** Coalesce readers and commit one reconciled list; failures preserve the live queue. */
export function createPendingUiRefresh(deps: {
  read: () => Promise<Array<Record<string, unknown>>>;
  subscribe: (listener: (event: EngineEvent) => void) => () => void;
  adopt: (requests: PermissionRequest[]) => void;
}): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const events: EngineEvent[] = [];
    const off = deps.subscribe((event) => {
      if (event.type === "extension_ui_request" || event.type === "extension_ui_dismiss") events.push(event);
    });
    const work = (async () => {
      const snapshot = await deps.read();
      deps.adopt(reconcilePendingUi(snapshot, events));
    })().finally(() => { off(); inFlight = null; });
    inFlight = work;
    return work;
  };
}
