import { t } from "../i18n/core.ts";

export type HistoryPage<T> = { messages: T[]; beforeEntryId: string; nextBeforeEntryId: string | null; reset: boolean };
type Options<T> = {
  cursor?: string | null;
  load: (cursor: string) => Promise<HistoryPage<T>>;
  prepend: (messages: T[], cursor: string) => boolean;
  cursorChanged: (cursor: string | null) => void;
  reset: () => Promise<void>;
};

/** Older history has its own flight; it cannot block live snapshot reconciliation. */
export class HistoryPager<T extends { id: string }> {
  #options: Options<T>;
  #cursor: string | null;
  #generation = 0;
  #closed = false;
  #flight: Promise<void> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;

  constructor(options: Options<T>) { this.#options = options; this.#cursor = options.cursor ?? null; }

  replace(cursor: string | null): void {
    this.#generation++;
    this.#flight = null;
    this.#cursor = cursor;
    this.#options.cursorChanged(cursor);
    this.#attempt = 0;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
  }

  get cursor(): string | null { return this.#cursor; }

  loadOlder(): Promise<void> {
    if (this.#closed || !this.#cursor) return Promise.resolve();
    if (this.#flight) return this.#flight;
    const cursor = this.#cursor, generation = this.#generation;
    const current = () => !this.#closed && generation === this.#generation;
    const flight = this.#options.load(cursor).then(async (page) => {
      if (!current()) return;
      if (page.beforeEntryId !== cursor) throw new Error(t("chat.loadFailed"));
      if (page.reset) {
        // Keep the old cursor incomplete until the authoritative reset succeeds.
        // Otherwise a concurrent Copy All could copy this partial window.
        await this.#options.reset();
        if (current()) this.replace(null);
        return;
      }
      if ((page.nextBeforeEntryId !== null && typeof page.nextBeforeEntryId !== "string") || page.nextBeforeEntryId === cursor ||
          (page.nextBeforeEntryId && page.messages[0]?.id !== page.nextBeforeEntryId)) throw new Error(t("chat.loadFailed"));
      if (!this.#options.prepend(page.messages, cursor)) {
        await this.#options.reset();
        if (current()) this.replace(null);
        return;
      }
      this.#cursor = page.nextBeforeEntryId;
      this.#options.cursorChanged(this.#cursor);
      this.#attempt = 0;
    }).finally(() => { if (this.#flight === flight) this.#flight = null; });
    this.#flight = flight;
    return flight;
  }

  /** Invisible prefetch; transient failures retry while this view remains attached. */
  prefetch(): void {
    if (this.#closed || !this.#cursor || this.#retry) return;
    const generation = this.#generation;
    void this.loadOlder().catch(() => {
      if (this.#closed || this.#retry || generation !== this.#generation) return;
      this.#retry = setTimeout(() => { this.#retry = null; this.prefetch(); }, Math.min(1000 * 2 ** Math.min(this.#attempt++, 4), 15_000));
    });
  }

  /** Copy All must never silently copy just the visible history window. */
  async loadAll(): Promise<void> {
    while (!this.#closed && this.#cursor) {
      const before = this.#cursor, generation = this.#generation;
      await this.loadOlder();
      if (generation === this.#generation && this.#cursor === before) throw new Error(t("chat.loadFailed"));
    }
    if (this.#closed) throw new Error(t("chat.loadFailed"));
  }

  dispose(): void {
    this.#closed = true;
    this.#generation++;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
  }
}

/** Keep existing row objects and their inverted-list indices when older rows arrive. */
export function prependHistory<T extends { id: string }>(current: T[], older: T[], cursor: string): T[] | null {
  if (current[0]?.id !== cursor) return null;
  const present = new Set(current.map((message) => message.id));
  const prefix: T[] = [];
  for (const message of older) if (!present.has(message.id)) { prefix.push(message); present.add(message.id); }
  return prefix.length ? [...prefix, ...current] : current;
}
