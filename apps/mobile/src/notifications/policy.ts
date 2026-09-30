export type MobileNotice = {
  kind: "done" | "error" | "approval";
  conversationId: string;
  title?: string;
  key?: string;
};

type NoticeContext = {
  background: boolean;
  enabled: boolean;
  serverId: string;
  conversations: ReadonlyArray<{ id: string; kind?: string }>;
  archivedIds: readonly string[];
  permissionAlways: readonly string[];
};

const BLOCKING_METHODS = new Set(["confirm", "select", "input", "editor", "questions", "plan_review"]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function eligibleConversation(event: Record<string, unknown>, context: NoticeContext): string | null {
  const id = event.conversationId;
  if (!nonEmptyString(id)) return null;
  const conversation = context.conversations.find((item) => item.id === id);
  if (!conversation || conversation.kind === "side-chat" || context.archivedIds.includes(id)) return null;
  return id;
}

/** Decide whether a server event should produce one phone notification. */
export function mobileNoticeForEvent(
  event: Record<string, unknown>,
  context: NoticeContext,
): MobileNotice | null {
  if (!context.background || !context.enabled) return null;

  const conversationId = eligibleConversation(event, context);
  if (!conversationId) return null;

  if (event.type === "conversation_activity") {
    const status = event.status;
    if (status !== "completed" && status !== "failed") return null;
    const notice: MobileNotice = {
      kind: status === "completed" ? "done" : "error",
      conversationId,
    };
    if (typeof event.title === "string") notice.title = event.title;
    if (typeof event.seq === "number" && Number.isFinite(event.seq)) {
      notice.key = JSON.stringify([context.serverId, conversationId, event.seq]);
    }
    return notice;
  }

  if (event.type !== "extension_ui_request" || typeof event.method !== "string" || !BLOCKING_METHODS.has(event.method)) return null;
  if (!nonEmptyString(event.id)) return null;

  const method = event.method;
  if (
    method === "confirm" &&
    context.permissionAlways.includes(`${method}:${typeof event.title === "string" ? event.title : ""}:${typeof event.message === "string" ? event.message : ""}`)
  ) return null;

  return {
    kind: "approval",
    conversationId,
    key: JSON.stringify([context.serverId, event.id]),
  };
}

export function notificationTarget(data: unknown): { serverId: string; conversationId: string } | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  if (value.type !== "fastvibe.chat" || !nonEmptyString(value.serverId) || !nonEmptyString(value.conversationId)) return null;
  return { serverId: value.serverId, conversationId: value.conversationId };
}
