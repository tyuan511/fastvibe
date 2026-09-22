import { NOTIFICATION_SETTINGS, type NotificationSetting } from "./types.ts";

/**
 * 系统通知 — what is decided about a notice before it is raised.
 *
 * Kept free of Electron on purpose. The two questions asked here — *should* this scenario
 * notify, and *which* scenario is this event — are the ones worth a test, and a module
 * that imports `electron` cannot be loaded by `node --test`. What is left for the
 * Electron side (`engine/notifications.ts`) is the part that genuinely needs it: showing
 * the notification and answering its click.
 */

export type NotificationRequest = {
  setting: NotificationSetting;
  title: string;
  body: string;
  /**
   * The conversation to open when the notification is clicked. Absent for a notice that
   * is not about a chat (an update), which then only brings the window forward.
   */
  conversationId?: string;
};

/**
 * Whether the user wants this scenario.
 *
 * Absent means **on**: the switch in 设置 → 通用 has to be turned off to silence anything,
 * so an install whose `settings.json` predates the switches is not silently muted.
 */
export function notificationEnabled(settings: Record<string, unknown>, setting: NotificationSetting): boolean {
  return settings[setting] !== false;
}

/** Which scenarios a fresh install gets: every one of them, until somebody says no. */
export function defaultNotificationSettings(): Record<NotificationSetting, boolean> {
  return Object.fromEntries(NOTIFICATION_SETTINGS.map((key) => [key, true])) as Record<NotificationSetting, boolean>;
}

/**
 * Whether an extension UI request is one that parks the run until a human answers.
 *
 * `notify` / `setStatus` / `setWidget` are one-way and must not raise a notification;
 * only the dialog methods block. `editor` is a dialog too, and it is answered through
 * the modal — the user still has to act, so it counts.
 */
export function isBlockingPrompt(event: Record<string, unknown>): boolean {
  const method = event.method;
  return (
    method === "confirm" ||
    method === "select" ||
    method === "input" ||
    method === "editor" ||
    method === "questions"
  );
}

/**
 * Which desktop notice this engine event should raise, or null for one that raises none.
 *
 * The wording is not decided here — Main applies it, because every user-facing string in
 * Main goes through `uiText` and follows 界面语言 (`raiseNotification`). This says only
 * *what happened* and *which chat*, which is the part that can be wrong independently of
 * the language it is said in.
 */
export function notificationForEvent(
  event: Record<string, unknown>,
): { setting: NotificationSetting; title?: string; conversationId?: string } | null {
  const conversationId = typeof event.conversationId === "string" ? event.conversationId : undefined;
  if (event.type === "conversation_activity") {
    // `failed` is a run that settled on an error — a retry chain that gave up, a provider
    // that refused. Someone who works in a terminal all day wants that said out loud even
    // when they asked not to hear about every ordinary finish, which is why the two are
    // separate switches rather than one 「任务结束」 one.
    return {
      setting: event.status === "failed" ? "notifyError" : "notifyDone",
      title: typeof event.title === "string" ? event.title : undefined,
      conversationId,
    };
  }
  if (event.type === "extension_ui_request" && isBlockingPrompt(event)) {
    return { setting: "notifyApproval", conversationId };
  }
  return null;
}
