import { powerSaveBlocker } from "electron";
import type { PersistedSettings } from "./app-settings";

/**
 * 运行时保持唤醒 — while an agent run is in flight, or while the remote-access server
 * is listening, hold the machine awake so a long tool call is not cut off by an idle
 * sleep and a phone does not lose the machine it is connected to.
 *
 * The blocker is deliberately `prevent-app-suspension`, not
 * `prevent-display-sleep`: the system stays up and the run keeps progressing, but
 * the screen may still dim and turn off (battery, OLED). A late-night run should
 * not light the room.
 *
 * The remote server counts because an idle Mac is exactly the one a phone is
 * reaching into: nothing streams while the user reads a transcript or walks away
 * between prompts, and an idle sleep there took the socket, the tunnel and the
 * next prompt down with it. A listening server is enough — a phone reconnects
 * whenever it likes, so waiting for a connected client would sleep between visits.
 *
 * What no assertion can do is survive a closed lid. `prevent-app-suspension` is
 * IOKit's `PreventUserIdleSystemSleep`, whose own header says the system «may still
 * sleep for lid close»; only `pmset disablesleep` (root) or clamshell mode with an
 * external display does that, and neither is an app's call to make.
 *
 * Three inputs decide the state, so `sync()` is the only place that starts or
 * stops the blocker: the user's preference, whether anything is streaming, and
 * whether the remote server is up. Turning the preference off stops it
 * immediately; the last reason to stay up going away releases it even while the
 * preference stays on.
 */
const running = new Set<string>();
let remoteServing = false;
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

/** Track whether the remote-access server is listening. Called on every state push. */
export function setRemoteServing(serving: boolean): void {
  if (remoteServing === serving) return;
  remoteServing = serving;
  sync();
}

/** Drop every tracked run (engine shutdown), so a blocker can never be orphaned. */
export function clearRunningConversations(): void {
  running.clear();
  sync();
}

function sync(): void {
  const wanted = enabled && (running.size > 0 || remoteServing);
  if (wanted) {
    if (blockerId === null) blockerId = powerSaveBlocker.start("prevent-app-suspension");
    return;
  }
  if (blockerId === null) return;
  if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
  blockerId = null;
}
