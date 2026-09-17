/**
 * Unified-diff parsing for `DiffView`. Two shapes reach the renderer and both are
 * first-class here:
 *
 * - A real unified diff (system `git diff`, a `.patch` file): `@@ -12,4 +12,4 @@`
 *   hunk headers carry the line numbers, and both counters are tracked from them.
 * - pi's edit tool, whose `details.diff` has no headers at all — it bakes the file's
 *   own line number into every row (`- 12   label: 'x'`, context rows padded to the
 *   same column). Those numbers are read back out.
 *
 * A model's hand-written ```diff fence usually has neither, and renders unnumbered.
 *
 * Line numbers always come from the diff, never from the row's position in the
 * text: a gutter that counted rows put an invented number next to pi's real one.
 */

export type DiffRowKind = "added" | "removed" | "context" | "hunk" | "meta" | "skip";

export type DiffRow = {
  kind: DiffRowKind;
  /** The unified diff's first character (`+` / `-` / ` `), blank on header rows. */
  marker: string;
  /** The line without its marker, and without any baked-in number. */
  text: string;
  oldNumber?: number;
  newNumber?: number;
};

export type DiffDocument = {
  rows: DiffRow[];
  /** Digits a line number needs, or 0 when the diff carries none (no gutter at all). */
  numberWidth: number;
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const META =
  /^(?:diff --git |diff --|index [0-9a-f]{4,}\.\.[0-9a-f]{4,}|--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |\\ No newline)/;
/** pi's numbered row: marker, a right-aligned number field, one space, the line. */
const BAKED = /^([ +-])( *)(\d+) (.*)$/;
/** pi's "context lines were dropped here" row — a number field of blanks. */
const ELISION = /^ *\.\.\. *$/;

export function parseDiff(text: string): DiffDocument {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  // Hunk headers win where they exist; pi's baked numbers only make sense without them.
  const baked = lines.some((line) => HUNK.test(line)) ? undefined : bakedField(lines);
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let counted = false;

  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      counted = true;
      rows.push({ kind: "hunk", marker: "", text: line });
      continue;
    }
    if (META.test(line)) {
      rows.push({ kind: "meta", marker: "", text: line });
      continue;
    }
    if (baked !== undefined) {
      rows.push(bakedRow(line) ?? { kind: "context", marker: "", text: line });
      continue;
    }
    const marker = line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") ? line[0] : "";
    const kind: DiffRowKind = marker === "+" ? "added" : marker === "-" ? "removed" : "context";
    const row: DiffRow = { kind, marker, text: marker ? line.slice(1) : line };
    if (counted) {
      if (kind !== "added") row.oldNumber = oldNo++;
      if (kind !== "removed") row.newNumber = newNo++;
    }
    rows.push(row);
  }

  return { rows, numberWidth: numberWidth(rows) };
}

/**
 * Whether these lines are pi's numbered format, and nothing else: every content
 * row has to carry a number ending in the same column (pi pads the field), and at
 * least one of them has to be a change. A hand-written diff fails that — its
 * context lines are plain text — and a numbered-looking prose line cannot pass on
 * its own.
 */
function bakedField(lines: string[]): number | undefined {
  let end: number | undefined;
  let numbered = 0;
  let changed = 0;
  for (const line of lines) {
    if (ELISION.test(line)) continue;
    if (!line.startsWith("+") && !line.startsWith("-") && !line.startsWith(" ")) return undefined;
    const match = BAKED.exec(line);
    if (!match) return undefined;
    const column = 1 + match[2].length + match[3].length;
    if (end === undefined) end = column;
    else if (end !== column) return undefined;
    numbered++;
    if (!line.startsWith(" ")) changed++;
  }
  return numbered >= 2 && changed > 0 ? end : undefined;
}

function bakedRow(line: string): DiffRow | undefined {
  if (ELISION.test(line)) return { kind: "skip", marker: "", text: line.trim() };
  const match = BAKED.exec(line);
  if (!match) return undefined;
  const [, marker, , digits, body] = match;
  const number = Number(digits);
  const kind: DiffRowKind = marker === "+" ? "added" : marker === "-" ? "removed" : "context";
  const row: DiffRow = { kind, marker, text: body };
  if (marker !== "+") row.oldNumber = number;
  if (marker !== "-") row.newNumber = number;
  return row;
}

function numberWidth(rows: DiffRow[]): number {
  let max = 0;
  for (const row of rows) {
    max = Math.max(max, row.oldNumber ?? 0, row.newNumber ?? 0);
  }
  return max === 0 ? 0 : String(max).length;
}
