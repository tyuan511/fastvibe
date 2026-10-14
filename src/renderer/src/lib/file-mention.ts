/**
 * The `@query` the caret is inside, when it is a file mention and not an address.
 *
 * `@` has to open a token: the start of the draft, whitespace, or any character that
 * cannot belong to an email local-part. `user@host` and `a.b@c` stay ordinary text.
 * The query runs from the character after `@` up to the caret and may not contain
 * whitespace — a space is the user leaving the mention.
 */
export type FileMention = {
  /** Index of the `@`. */
  start: number;
  /** Caret, which is also the end of the query. */
  end: number;
  query: string;
};

const EMAIL_LOCAL = /[A-Za-z0-9._%+\-]/;

export function fileMentionAtCaret(value: string, caret: number): FileMention | null {
  if (!Number.isFinite(caret)) return null;
  const end = Math.max(0, Math.min(value.length, caret));
  const at = value.lastIndexOf("@", end - 1);
  if (at < 0) return null;
  const before = at === 0 ? undefined : value[at - 1];
  if (before !== undefined && EMAIL_LOCAL.test(before)) return null;
  const query = value.slice(at + 1, end);
  if (query.length > 200 || /[\s@]/.test(query)) return null;
  return { start: at, end, query };
}

/**
 * Drop the `@query` token, leaving the sentence around it intact.
 *
 * The picked file becomes an attachment chip — the same reference a dropped file
 * is — so the token itself must not stay in the draft and be sent twice.
 */
export function applyFileMention(value: string, mention: FileMention): { value: string; caret: number } {
  const before = value.slice(0, mention.start);
  const after = value.slice(mention.end);
  // The mention was its own token. One space on each side becomes the one space
  // that was already separating the words; a space that only padded the token is dropped.
  const between = before.endsWith(" ") && after.startsWith(" ");
  let next = `${before}${between ? after.slice(1) : after}`;
  if (before.length === 0) next = next.replace(/^[ \t]+/, "");
  if (after.length === 0) next = next.replace(/[ \t]+$/, "");
  const caret = after.length === 0 ? next.length : before.length === 0 ? 0 : before.length;
  return { value: next, caret: Math.min(caret, next.length) };
}
