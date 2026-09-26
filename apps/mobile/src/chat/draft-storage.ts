import AsyncStorage from "@react-native-async-storage/async-storage";

const PREFIX = "fastvibe.chat-draft.v1:";
const memory = new Map<string, MobileDraft | null>();
const writes = new Map<string, Promise<void>>();

export type MobileDraft = {
  serverId: string;
  conversationId: string;
  text: string;
  updatedAt: number;
};

function key(serverId: string, conversationId: string): string {
  return `${PREFIX}${encodeURIComponent(serverId)}:${encodeURIComponent(conversationId)}`;
}

function parse(value: string | null, serverId: string, conversationId: string): MobileDraft | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MobileDraft>;
    if (
      typeof parsed.text !== "string" ||
      typeof parsed.updatedAt !== "number" ||
      !Number.isFinite(parsed.updatedAt)
    ) return null;
    return { serverId, conversationId, text: parsed.text, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

export async function readDraft(serverId: string, conversationId: string): Promise<MobileDraft | null> {
  const storageKey = key(serverId, conversationId);
  if (memory.has(storageKey)) return memory.get(storageKey) ?? null;
  try {
    const saved = parse(await AsyncStorage.getItem(storageKey), serverId, conversationId);
    memory.set(storageKey, saved);
    return saved;
  } catch {
    return null;
  }
}

export function writeDraft(serverId: string, conversationId: string, text: string): Promise<void> {
  const storageKey = key(serverId, conversationId);
  const draft = text.length === 0 ? null : { serverId, conversationId, text, updatedAt: Date.now() };
  // Update the in-memory view synchronously so returning to a chat never waits for
  // the native storage bridge. The actual writes for one key are serialized below.
  memory.set(storageKey, draft);
  const previous = writes.get(storageKey) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (draft) await AsyncStorage.setItem(storageKey, JSON.stringify(draft));
      else await AsyncStorage.removeItem(storageKey);
    });
  writes.set(storageKey, next);
  void next.then(
    () => {
      if (writes.get(storageKey) === next) writes.delete(storageKey);
    },
    () => {
      if (writes.get(storageKey) === next) writes.delete(storageKey);
    },
  );
  return next.catch(() => undefined);
}

export async function listDrafts(serverId: string): Promise<MobileDraft[]> {
  try {
    const prefix = `${PREFIX}${encodeURIComponent(serverId)}:`;
    const keys = (await AsyncStorage.getAllKeys()).filter((item) => item.startsWith(prefix));
    const values = await AsyncStorage.multiGet(keys);
    const drafts = new Map<string, MobileDraft>();
    for (const [storageKey, value] of values) {
      const conversationId = decodeURIComponent(storageKey.slice(prefix.length));
      const draft = parse(value, serverId, conversationId);
      if (draft) drafts.set(storageKey, draft);
    }
    for (const [storageKey, draft] of memory) {
      if (!storageKey.startsWith(prefix)) continue;
      if (draft) drafts.set(storageKey, draft);
      else drafts.delete(storageKey);
    }
    return [...drafts.values()].filter((item) => item.text.length > 0).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [...memory.entries()]
      .filter(([storageKey, draft]) => storageKey.startsWith(`${PREFIX}${encodeURIComponent(serverId)}:`) && draft !== null && draft.text.length > 0)
      .map(([, draft]) => draft as MobileDraft)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
