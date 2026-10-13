/**
 * Pinned chats (`id -> pinnedAt`), kept in localStorage rather than `settings.json`.
 *
 * Pins are a sidebar arrangement of the client doing the arranging — the same reasoning as
 * `sidebarCollapsed` — so they never travel through the settings file. They live in their
 * own module because two places need them and only one of them is a component: the
 * sidebar draws the 已置顶 section, and the auto-archive sweep must leave a pinned chat
 * alone (pinning is the user saying "keep this one where I can see it").
 */
const PINNED_KEY = "fastvibe.sidebar.pinned";

/**
 * Pins are stored as `id -> pinnedAt` so the "已置顶" list can be ordered by pin
 * time. Earlier builds stored a plain id array; keep reading that shape.
 */
export function readPinned(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const id of parsed) if (typeof id === "string") out[id] = 0;
      return out;
    }
    if (parsed && typeof parsed === "object") {
      const out: Record<string, number> = {};
      for (const [id, at] of Object.entries(parsed)) {
        if (typeof at === "number") out[id] = at;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

export function persistPinned(value: Record<string, number>): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify(value));
}
