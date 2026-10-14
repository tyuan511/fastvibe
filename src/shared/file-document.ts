/**
 * Document parsing for the file pane's Markdown view: frontmatter fields and a
 * heading outline. Pure and dependency-free, so the renderer and `node --test`
 * both use it.
 *
 * The outline is read from the **source**, not from the rendered DOM. The rendered
 * tree comes from the transcript's own markdown renderer, which is memoised per
 * block; indexing it would mean a second traversal of React output and a slug pass
 * that the chat's renderer has no other use for. Parsing the source keeps one
 * definition of "what the contents are" and can be enumerated in a test.
 *
 * Only the subset of YAML that frontmatter actually carries is understood — a
 * scalar, an inline array, a `- item` list, and a block scalar. Anything else is
 * kept as its trimmed raw text rather than silently dropped, because a field the
 * reader can see beats a field that vanished.
 */

export type FrontmatterField = {
  key: string;
  value: string;
  /** Present when the value was written as a list; `value` is then the joined form. */
  items?: string[];
};

export type DocumentOutlineEntry = {
  /** 1 for `#`, 2 for `##` … */
  depth: number;
  text: string;
  /** Stable anchor id, unique within the document. */
  slug: string;
};

const FRONTMATTER_LINE = /^---[ \t]*$/;
const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]*-[ \t]+(.*)$/;

/**
 * Split a leading `---` frontmatter block off the body.
 *
 * Returns `null` when there is no block at all, so the caller can tell "a document
 * without frontmatter" from "a document whose frontmatter is empty" — the two draw
 * differently (nothing, against an empty definition list).
 *
 * Read line by line rather than by one regexp: `---\n---\n` is a legal empty block,
 * and a pattern that demands a newline before the closing fence misses it.
 */
export function splitFrontmatter(text: string): { fields: FrontmatterField[]; body: string } | null {
  const lines = text.split("\n");
  if (lines.length === 0 || !FRONTMATTER_LINE.test(lines[0]!.replace(/\r$/, ""))) return null;
  const close = lines.findIndex((line, index) => index > 0 && FRONTMATTER_LINE.test(line.replace(/\r$/, "")));
  if (close < 0) return null;
  const block = lines.slice(1, close).map((line) => line.replace(/\r$/, "")).join("\n");
  const body = lines.slice(close + 1).join("\n");
  return { fields: parseFields(block), body };
}

function parseFields(block: string): FrontmatterField[] {
  const lines = block.replace(/\r/g, "").split("\n");
  const fields: FrontmatterField[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    index += 1;
    if (isBlankOrComment(line)) continue;
    const match = KEY.exec(line);
    // A line that is not `key:` cannot start a field. Keep it under the previous key
    // rather than inventing a name for it — a wrapped scalar is the common case.
    if (!match) {
      const previous = fields.at(-1);
      if (previous) previous.value = `${previous.value} ${line.trim()}`.trim();
      continue;
    }
    const key = match[1]!;
    const rest = match[2]!;
    const blockScalar = /^[|>][+-]?\d*$/.test(rest.trim());
    const inlineList = rest.trim().startsWith("[");
    const collected: string[] = [];
    while (index < lines.length) {
      const next = lines[index]!;
      const blank = next.trim() === "";
      if (blank && !blockScalar) break;
      if (isBlankOrComment(next)) {
        index += 1;
        continue;
      }
      if (!/^[ \t]/.test(next)) break;
      collected.push(next);
      index += 1;
    }
    if (blockScalar) {
      fields.push({ key, value: blockScalarValue(collected, rest.trim().startsWith(">")) });
      continue;
    }
    if (inlineList) {
      const items = inlineListValue(rest);
      fields.push({ key, value: items.join(", "), items });
      continue;
    }
    if (collected.length > 0 && collected.every((line) => LIST_ITEM.test(line))) {
      const items = collected.map((line) => unquote(LIST_ITEM.exec(line)![1]!.trim()));
      fields.push({ key, value: items.join(", "), items });
      continue;
    }
    const extra = collected.map((line) => line.trim()).join(" ");
    fields.push({ key, value: unquote(`${rest} ${extra}`.trim()) });
  }
  return fields;
}

function isBlankOrComment(line: string): boolean {
  return /^[ \t]*(?:#.*)?$/.test(line);
}

/** A block scalar keeps its line breaks; a folded one (`>`) joins them with spaces. */
function blockScalarValue(lines: string[], folded: boolean): string {
  const indents = lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  const body = lines.map((line) => line.slice(Math.min(indent, line.length)).trimEnd());
  return folded ? body.map((line) => line.trim()).join(" ").trim() : body.join("\n").trim();
}

function inlineListValue(rest: string): string[] {
  const inner = rest.trim().replace(/^\[/, "").replace(/\][ \t]*$/, "");
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of inner) {
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      items.push(unquote(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "" || items.length > 0) items.push(unquote(current.trim()));
  return items.filter((item) => item !== "");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The headings of a Markdown body, in document order.
 *
 * Fenced code is skipped: a `# comment` inside a shell snippet is a comment, and a
 * contents list that offered it would jump the reader into the middle of a code block.
 * Setext headings are not read — they are rare in the documents this pane opens and
 * telling one from a thematic break needs the following line's context.
 */
export function documentOutline(body: string): DocumentOutlineEntry[] {
  const entries: DocumentOutlineEntry[] = [];
  const slugger = createSlugger();
  let fence: { marker: string; length: number } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    if (!heading) continue;
    const text = plainText(heading[2]!);
    if (text === "") continue;
    entries.push({ depth: heading[1]!.length, text, slug: slugger(text) });
  }
  return entries;
}

/**
 * A slugger that keeps its own occurrence count.
 *
 * The outline and the rendered headings both use this, from the same source text, so
 * a contents entry and the heading it points at cannot end up with different ids — the
 * failure that would look like a link that does nothing.
 */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = slugify(text) === "" ? "section" : slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/** A heading's label without the inline markup that would be read as literal text. */
/** A heading's label without the inline markup that would be read as literal text. */
export function headingText(value: string): string {
  return plainText(value);
}

function plainText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** GitHub's slug shape: lowercase, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Which columns of a table are numeric, so they can be right-aligned.
 *
 * A column counts only when **every** non-empty cell parses as a number: one word in
 * the column makes it a text column, and right-aligning text reads as a mistake. The
 * rows given are data rows — a caller with a header row passes the body, since a
 * header is a label and would make every column a text column.
 */
export function numericColumns(rows: string[][]): Set<number> {
  const columns = new Set<number>();
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  for (let column = 0; column < width; column++) {
    let numeric = 0;
    let text = 0;
    for (const row of rows) {
      const cell = (row[column] ?? "").trim();
      if (cell === "" || cell === "-" || cell === "—") continue;
      if (NUMBER.test(cell)) numeric += 1;
      else {
        text += 1;
        break;
      }
    }
    if (numeric > 0 && text === 0) columns.add(column);
  }
  return columns;
}

/**
 * Currency symbols, thousands separators and a trailing percent or single-letter unit
 * all count. `ms` does not: a two-letter unit is not a number with a suffix, and
 * guessing which units are allowed would make this a table of English words.
 */
const NUMBER = /^[-+(]?[$€£¥]?\d[\d,._ ']*(?:[.,]\d+)?[)%]?[kKmMbB]?$/;
