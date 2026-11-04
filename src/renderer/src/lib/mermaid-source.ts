/** The source span comes from the fenced code's HAST position, before HTML rendering. */
export function isClosedMermaidFence(source: string): boolean {
  const lines = source.trimEnd().split("\n");
  if (lines.length < 2) return false;
  const opening = /^[ \t]*(`{3,}|~{3,})/.exec(lines[0] ?? "")?.[1];
  // A nested blockquote keeps its `>` prefixes in the source span's later lines.
  const closing = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1) ?? "")?.[1];
  return Boolean(opening && closing && closing[0] === opening[0] && closing.length >= opening.length);
}

export const MAX_MERMAID_CHARS = 24_000;
