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
 * Whether desktop notifications are on.
 *
 * One switch (设置 → 通用 → 系统通知) covers every scenario. It writes the four keys
 * together, so the install is silent only when every one of them is explicitly false.
 * A single false is a leftover from when each scenario had its own row; those rows are
 * gone, and that scenario is on. Absent means on, so an older `settings.json` is not
 * silently muted.
 */
export function notificationsEnabled(settings: Partial<Record<NotificationSetting, unknown>>): boolean {
  return NOTIFICATION_SETTINGS.some((key) => settings[key] !== false);
}

/** Whether this scenario should raise a notice. Every scenario follows the one switch. */
export function notificationEnabled(
  settings: Partial<Record<NotificationSetting, unknown>>,
  _setting: NotificationSetting,
): boolean {
  return notificationsEnabled(settings);
}

/**
 * Drop retired per-scene offs so they cannot outlive the rows that set them.
 *
 * A non-boolean is not a "no" and is removed. A lone `false` is removed too, which
 * reads back as the default — on. All four explicit falses are the master switch and
 * are kept.
 */
export function normalizeNotificationSettings(settings: Partial<Record<NotificationSetting, unknown>>): void {
  for (const key of NOTIFICATION_SETTINGS) {
    if (typeof settings[key] !== "boolean") delete settings[key];
  }
  if (!notificationsEnabled(settings)) return;
  for (const key of NOTIFICATION_SETTINGS) {
    if (settings[key] === false) delete settings[key];
  }
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
    // that refused. The notice says that out loud instead of 「任务已完成」; the two are not
    // separate switches anymore, only separate wording.
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
