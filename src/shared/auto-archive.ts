import type { Conversation } from "./types";

/**
 * 会话自动归档: a conversation nobody has touched for a long time is moved to the
 * archive list on its own.
 *
 * The rules live here, apart from the stores that carry them out, because the one
 * thing that must not drift is *which* conversations are eligible — the same pure
 * function is unit-tested (`test/auto-archive.test.ts`) and called by the renderer's
 * sweep. Nothing here touches the engine or the disk: archiving is a preference, and
 * this module only decides what belongs in it.
 */

/** Days of inactivity after which a conversation is archived, unless changed. */
export const DEFAULT_AUTO_ARCHIVE_DAYS = 30;

/** The stored value that turns automatic archiving off (never archive). */
export const AUTO_ARCHIVE_OFF = 0;

/**
 * What the 归档对话 picker offers, in order. `0` is 永不 — a retention rule a user
 * cannot switch off is worse than one they can, so the off state is a choice here
 * rather than the absence of the feature.
 */
export const AUTO_ARCHIVE_DAY_OPTIONS = [AUTO_ARCHIVE_OFF, 7, 14, 30, 90, 180, 365] as const;

/** Ten years is well past any real choice; a value beyond it is a corrupt file. */
const MAX_AUTO_ARCHIVE_DAYS = 3650;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function isAutoArchiveDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_AUTO_ARCHIVE_DAYS;
}

/** A stored value, or the default when the file holds something else. */
export function readAutoArchiveDays(value: unknown): number {
  return isAutoArchiveDays(value) ? value : DEFAULT_AUTO_ARCHIVE_DAYS;
}

export type AutoArchiveOptions = {
  now: number;
  /** Days of inactivity that make a conversation eligible; `0` means off. */
  days: number;
  /** Ids already in the archive list. */
  archived?: ReadonlySet<string>;
  /** Conversations whose run is in flight; never archived mid-reply. */
  running?: ReadonlySet<string>;
  /** Pinned chats: pinning is the user saying "keep this where I can see it". */
  pinned?: ReadonlySet<string>;
  /** The conversation on screen; archiving it would hide the open thread's row. */
  activeId?: string | null;
};

/**
 * The conversations a sweep should archive, oldest first.
 *
 * `updatedAt` is the catalog's "last mutation" time, and it is bumped by everything
 * that makes a chat current — a prompt preview, a rename, binding a project, opening a
 * session — which is the same thing the archive pane already shows as 更新时间. It is
 * deliberately not `createdAt`: a chat created long ago and used yesterday is not stale.
 *
 * Four kinds are left alone, each for a different reason:
 * - **A side chat** lives in the right pane, not the sidebar, and belongs to the chat
 *   that opened it.
 * - **An empty draft** (no preview) is a project's composer workspace that 新对话
 *   reuses; archiving it would hide a chat the app then hands back as a new one.
 * - **A running chat** has a reply in flight, and hiding a busy chat behind a row the
 *   user cannot reach is the state the manual archive path goes out of its way to avoid.
 * - **The active chat** is on screen: its row disappearing would leave an open thread
 *   with nothing in the sidebar pointing at it.
 *
 * A pinned chat is a fifth: pins live in localStorage (`lib/pinned.ts`), not the archive
 * list, but archiving one would take it out of the 已置顶 section the user put it in.
 */
export function staleConversationIds(
  conversations: readonly Conversation[],
  options: AutoArchiveOptions,
): string[] {
  const { now, days, activeId } = options;
  if (!Number.isFinite(days) || days <= AUTO_ARCHIVE_OFF) return [];
  const archived = options.archived ?? new Set<string>();
  const running = options.running ?? new Set<string>();
  const pinned = options.pinned ?? new Set<string>();
  const cutoff = now - days * MS_PER_DAY;
  return conversations
    .filter(
      (item) =>
        item.kind !== "side-chat" &&
        Boolean(item.preview) &&
        !archived.has(item.id) &&
        !running.has(item.id) &&
        !pinned.has(item.id) &&
        item.id !== activeId &&
        Number.isFinite(item.updatedAt) &&
        item.updatedAt < cutoff,
    )
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
    .map((item) => item.id);
}

/** Ids of the conversations the archive list should hold, from a plain boolean map. */
export function runningIds(running: Readonly<Record<string, boolean>>): Set<string> {
  return new Set(Object.entries(running).filter(([, value]) => value === true).map(([id]) => id));
}
