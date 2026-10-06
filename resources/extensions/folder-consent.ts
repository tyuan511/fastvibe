import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { primeToolFolderConsent } from "./mac-folder-consent.ts";

/**
 * Not a permission check — nothing here ever blocks or asks. macOS raises its own
 * folder dialog (Desktop, Documents, Downloads, iCloud…) the first time a process reads
 * one, and the answer only sticks when the stat comes from the main thread, so this
 * touches the folder a tool is about to use before the tool runs.
 *
 * It is loaded into the main agent and into every delegated run, which load no other
 * extension.
 */
export default function folderConsent(pi: ExtensionAPI): void {
  pi.on("tool_call", (event, ctx) => {
    // Before any await, so the stat stays on this turn of the main thread.
    primeToolFolderConsent(event.toolName, event.input, ctx.cwd);
    return undefined;
  });
}
