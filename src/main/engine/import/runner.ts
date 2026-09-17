import { existsSync } from "node:fs";
import { uiText } from "../ui-text";
import type { ImportCandidate, ImportOutcome, ImportRunResult, ImportSourceId, ImportSourceStatus, WorkspaceSnapshot } from "@shared/types";
import type { ConversationCatalog } from "../conversation-catalog";
import type { FastVibePaths } from "../paths";
import { IMPORT_ADAPTERS, importAdapter } from "./adapters";
import { writeImportedSession, type WrittenSession } from "./writer";

/**
 * Orchestration for 设置 → 导入.
 *
 * Kept out of `PiProcessManager` because none of it is about the live engine: it scans
 * other agents' data read-only, converts what it finds, and hands finished files back to
 * the caller to register as conversations. The manager supplies the two things this
 * cannot own — the isolated runtime paths, and the conversation catalog — through the
 * `register` callback.
 */

/** What each source looks like right now, for the rows in the 导入 pane. */
export async function scanImportSources(): Promise<ImportSourceStatus[]> {
  const statuses: ImportSourceStatus[] = [];
  for (const adapter of IMPORT_ADAPTERS) {
    if (!existsSync(adapter.root)) {
      // Not installed, or never run. Nothing to offer and nothing to explain, so the
      // source is left out entirely: a row that can only ever say 「未找到数据目录」 is
      // noise on the common machine where one or two of the four agents are absent.
      // An agent that *is* installed but has no sessions still gets a row — there the
      // empty state is news the user would otherwise go looking for.
      continue;
    }
    const status: ImportSourceStatus = {
      id: adapter.id,
      name: adapter.name,
      sessionCount: 0,
    };
    try {
      const candidates = await adapter.scan();
      status.sessionCount = candidates.length;
      // Counted separately so the row can say how many are behind the 显示已归档 switch
      // without the pane ever having to scan for itself.
      status.archivedCount = candidates.filter((candidate) => candidate.archived).length;
      status.latestAt = candidates.reduce<number | undefined>(
        (latest, candidate) => (latest === undefined || candidate.updatedAt > latest ? candidate.updatedAt : latest),
        undefined,
      );
      if (candidates.length === 0) status.reason = uiText("没有找到会话", "No sessions found");
    } catch (error) {
      status.reason = error instanceof Error ? error.message : uiText("读取失败", "Failed to read");
    } finally {
      // Release whatever the scan opened before the pane's next refresh.
      await adapter.dispose?.().catch(() => undefined);
    }
    statuses.push(status);
  }
  return statuses;
}

/**
 * Past this, an imported chat is minutes of scrolling and more context than any model
 * holds, so the picker says so up front instead of letting the first turn discover it.
 */
const LARGE_MESSAGES = 800;
const LARGE_BYTES = 15 * 1024 * 1024;

/** The sessions one source can offer, newest first. */
export async function scanImportCandidates(
  source: ImportSourceId,
  importedKeys: ReadonlySet<string>,
): Promise<ImportCandidate[]> {
  const adapter = importAdapter(source);
  if (!adapter) throw new Error(uiText(`不支持的来源：${source}`, `Unsupported source: ${source}`));
  try {
    const candidates = await adapter.scan();
    return candidates
      .map((candidate) => ({
        id: candidate.id,
        source: adapter.id,
        title: candidate.title,
        cwd: candidate.cwd,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
        messageCount: candidate.messageCount,
        bytes: candidate.bytes,
        archived: candidate.archived,
        imported: importedKeys.has(keyOf(adapter.id, candidate.id)),
        note: noteFor(candidate.note, candidate.messageCount, candidate.bytes),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    await adapter.dispose?.().catch(() => undefined);
  }
}

/**
 * Codex leaves work like this on disk: transcripts of thousands of messages whose next
 * turn would immediately overrun the window. The import still works — the engine
 * auto-compacts — but the user should decide knowing that.
 */
function noteFor(note: string | undefined, messageCount: number | undefined, bytes: number | undefined): string | undefined {
  const parts = note ? [note] : [];
  if ((messageCount !== undefined && messageCount > LARGE_MESSAGES) || (bytes !== undefined && bytes > LARGE_BYTES)) {
    parts.push(uiText("会话较长，导入后建议先压缩上下文", "This session is long; compact after import"));
  }
  return parts.length ? parts.join("；") : undefined;
}

/**
 * Import the chosen sessions.
 *
 * One failure never stops the run: the local agents' data is inconsistent by nature (a
 * pruned rollout, a half-written JSONL, a session whose project is gone), and a user who
 * picked twelve chats should get the eleven that work plus a readable reason for the
 * twelfth.
 */
export async function importSessions(options: {
  paths: FastVibePaths;
  catalog: ConversationCatalog;
  source: ImportSourceId;
  ids: string[];
}): Promise<ImportRunResult> {
  const adapter = importAdapter(options.source);
  if (!adapter) throw new Error(uiText(`不支持的来源：${options.source}`, `Unsupported source: ${options.source}`));
  const outcomes: ImportOutcome[] = [];
  let snapshot: WorkspaceSnapshot | undefined;
  try {
    for (const id of options.ids) {
      try {
        const session = await adapter.read(id);
        const written = writeImportedSession(session, {
          sessionsDir: options.paths.sessionsDir,
          scratchDir: options.paths.scratchDir,
        });
        snapshot = registerImportedConversation(options.catalog, written, options.source, session.sourceId).snapshot;
        outcomes.push({
          id,
          title: written.title,
          ok: true,
          messages: written.messages,
          skipped: session.skipped,
          cwd: written.cwd,
          conversationId: written.sessionId,
        });
      } catch (error) {
        outcomes.push({
          id,
          title: id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await adapter.dispose?.().catch(() => undefined);
  }
  // The catalog coalesces writes on a short debounce, so an import that reports success
  // must not leave the new chats only in memory: flush once here, the way shutdown does.
  options.catalog.flush();
  // Falls back to the catalog when every session failed, so the renderer always gets a
  // snapshot it can apply rather than an empty shell.
  return {
    source: options.source,
    outcomes,
    snapshot: snapshot ?? options.catalog.snapshot(),
  };
}

/**
 * Adopt one written transcript as a conversation.
 *
 * Deliberately not activated: importing a dozen chats must not walk the user through a
 * dozen tab switches. `createdAt` stays "now" (the catalog owns it as the sidebar's sort
 * key), so freshly imported chats surface at the top of their project.
 */
export function registerImportedConversation(
  catalog: ConversationCatalog,
  written: WrittenSession,
  source: ImportSourceId,
  sourceId: string,
): { conversationId: string; snapshot: WorkspaceSnapshot } {
  const conversation = catalog.create(
    written.project,
    { sessionFile: written.sessionFile, sessionId: written.sessionId, cwd: written.cwd },
    { title: written.title, activate: false },
  );
  // `titleManual` keeps the auto-titler away from a name that came from the other agent.
  catalog.update(conversation.id, {
    preview: written.preview,
    importedFrom: { source, sourceId },
    titleManual: true,
  });
  return { conversationId: conversation.id, snapshot: catalog.snapshot() };
}

/** `source:sourceId`, the key that makes a second import of the same session recognisable. */
export function keyOf(source: ImportSourceId, sourceId: string): string {
  return `${source}:${sourceId}`;
}
