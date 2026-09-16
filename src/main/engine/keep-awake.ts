import { powerSaveBlocker } from "electron";
import type { PersistedSettings } from "./app-settings";

/**
 * 运行时保持唤醒 — while an agent run is in flight, hold the machine awake so a
 * long tool call is not cut off by an idle sleep.
 *
 * The blocker is deliberately `prevent-app-suspension`, not
 * `prevent-display-sleep`: the system stays up and the run keeps progressing, but
 * the screen may still dim and turn off (battery, OLED). A late-night run should
 * not light the room.
 *
 * Two independent inputs decide the state, so `sync()` is the only place that
 * starts or stops the blocker: the user's preference, and whether anything is
 * actually streaming. Turning the preference off mid-run stops it immediately;
 * the last run to finish releases it even while the preference stays on.
 */
const running = new Set<string>();
let enabled = false;
let blockerId: number | null = null;

/** Re-read the preference from `settings.json`. Called at startup and on every write. */
export function applyKeepAwake(settings: PersistedSettings): void {
  enabled = settings.keepAwake === true;
  sync();
}

/**
 * Track a conversation's run state. Main learns this from the engine's
 * `conversation_running` event, which is broadcast for every conversation — not
 * just the active one — so a background chat still holds the machine awake.
 */
export function setConversationRunning(conversationId: string, isRunning: boolean): void {
  if (isRunning) running.add(conversationId);
  else running.delete(conversationId);
  sync();
}

/** Drop every tracked run (engine shutdown), so a blocker can never be orphaned. */
export function clearRunningConversations(): void {
  running.clear();
  sync();
}

function sync(): void {
  const wanted = enabled && running.size > 0;
  if (wanted) {
    if (blockerId === null) blockerId = powerSaveBlocker.start("prevent-app-suspension");
    return;
  }
  if (blockerId === null) return;
  if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
  blockerId = null;
}
