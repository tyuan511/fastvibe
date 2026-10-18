import { dirname, resolve } from "node:path";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";

/**
 * `SessionManager.open(file, undefined, cwd)`, from entries already read.
 *
 * `open` reads and parses the whole file, and the host has just done exactly that to relink
 * and close a transcript (`prepareTranscriptForOpen`) — for a transcript of tens of megabytes
 * that second parse was a third of what opening the chat cost on Main's thread. The SDK's own
 * `open` builds its manager through the same constructor with preloaded entries (it does so
 * when a header is too large to scan); the constructor is private to TypeScript only, so the
 * call is typed here and `test/session-open.test.ts` pins that both paths load the same session.
 * With no entries this is `SessionManager.open` itself.
 */
type PreloadingConstructor = new (
  cwd: string,
  sessionDir: string,
  sessionFile: string,
  persist: boolean,
  newSessionOptions: undefined,
  preloadedFileEntries: FileEntry[],
) => SessionManager;

export function openSessionFile(file: string, cwd: string, entries?: ReadonlyArray<Record<string, unknown>>): SessionManager {
  if (!entries || entries.length === 0) return SessionManager.open(file, undefined, cwd);
  const resolved = resolve(file);
  const Manager = SessionManager as unknown as PreloadingConstructor;
  return new Manager(cwd, dirname(resolved), resolved, true, undefined, entries as unknown as FileEntry[]);
}
