import { useMemo } from "react";
import { todoIsCurrent, todoSnapshot, type TodoSnapshot } from "@/lib/todos";
import { useConversationWorking, useSessionStore } from "@/stores/session";

/**
 * The checklist a surface should draw for the conversation on screen, or `null` when
 * nothing should be drawn.
 *
 * Both the panel above the composer (`TodoPanel`) and 会话资源 › 任务清单 go through this
 * one hook instead of each re-deciding for itself. The rule for when a list stops
 * being this turn's plan is spelled out once, in `todoIsCurrent`; a resource panel
 * that kept drawing an abandoned checklist while the composer's panel had hidden it
 * is exactly the inconsistency that made a stale plan read as a live one.
 *
 * The transcript's own todo card is deliberately *not* built on this: that card is a
 * record of what the model submitted in its turn, and history stays on screen.
 */
export function useConversationTodo(): TodoSnapshot | null {
  // Select the transcript itself, never the snapshot: `todoSnapshot` allocates a new
  // object on every call, and Zustand/React's `useSyncExternalStore` treats that as a
  // changed snapshot — "Maximum update depth exceeded" on every paint.
  const messages = useSessionStore((state) => state.messages);
  const working = useConversationWorking();
  const snapshot = useMemo(() => todoSnapshot(messages), [messages]);
  return todoIsCurrent(snapshot, working) ? snapshot : null;
}
