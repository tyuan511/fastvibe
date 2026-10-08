type Client = { call(method: string): Promise<unknown> };
type Entry = { promise: Promise<unknown[]>; expires: number; pending: boolean };
const entries = new WeakMap<Client, Entry>();
const MAX_AGE_MS = 60_000;

/** Reuse the host-wide model catalog across chats and share concurrent reads. */
export function readModelCatalog(client: Client, now = Date.now()): Promise<unknown[]> {
  const previous = entries.get(client);
  if (previous && (previous.pending || previous.expires > now)) return previous.promise;
  const entry: Entry = { promise: Promise.resolve([]), expires: 0, pending: true };
  entries.set(client, entry);
  entry.promise = client.call("engine:get-models").then((value) => {
    entry.pending = false;
    entry.expires = Date.now() + MAX_AGE_MS;
    return Array.isArray(value) ? value : [];
  }).catch((error) => {
    if (entries.get(client) === entry) entries.delete(client);
    throw error;
  });
  return entry.promise;
}

export function invalidateModelCatalog(client: Client): void { entries.delete(client); }
