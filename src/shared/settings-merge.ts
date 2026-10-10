import { mergeSettingsPreservingProxy } from "./proxy.ts";

/**
 * The keys only Main's own `remote:*` methods write: the switch, the port, the computer's
 * name. They live in `settings.json` beside the preferences, but they are not one — no
 * client edits them through a settings save.
 */
function isRemoteKey(key: string): boolean {
  return key.startsWith("remote");
}

/** The remote-access keys of a settings object, and nothing else. */
export function remoteSettingsOf(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => isRemoteKey(key)));
}

/**
 * What `settings:set` writes: the client's snapshot, with the keys that are not a
 * client's to write taken from the file instead.
 *
 * A client saves the whole object it loaded at startup. `remote:start` writes
 * `remoteEnabled` to the file without that copy hearing of it, so the next unrelated
 * save — a sidebar drag is one — used to write the switch back to what it was when the
 * window opened. The listener kept running, which is why nobody saw it happen; the next
 * launch (an update, usually) read the file and left remote access off.
 */
export function mergeClientSettings(current: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const client = Object.fromEntries(Object.entries(incoming).filter(([key]) => !isRemoteKey(key)));
  return { ...mergeSettingsPreservingProxy(current, client), ...remoteSettingsOf(current) };
}
