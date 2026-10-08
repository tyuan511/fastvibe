/** Preserve completed reply objects across streamed updates, including merged tool rounds. */
export function createReplyCache<T extends object>(joinable: (value: T) => boolean, combine: (a: T, b: T) => T): (messages: T[]) => T[] {
  const cache = new WeakMap<T, { previous: T; merged: T }>();
  return (messages) => {
    const out: T[] = [];
    for (const message of messages) {
      const previous = out.at(-1);
      if (!previous || !joinable(previous) || !joinable(message)) { out.push(message); continue; }
      let entry = cache.get(message);
      if (!entry || entry.previous !== previous) {
        entry = { previous, merged: combine(previous, message) };
        cache.set(message, entry);
      }
      out[out.length - 1] = entry.merged;
    }
    return out;
  };
}
