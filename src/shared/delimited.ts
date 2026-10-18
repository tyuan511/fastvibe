/**
 * The app's own reader for delimited text: `.csv` and `.tsv`.
 *
 * This is what the table preview shows, and it used to be `line.split(",")`, which is not a CSV
 * parser. A quoted field containing a comma (`"1,234"`, an address, a name) split into two
 * columns, a quoted field containing a newline ended the row early, and `""` inside a quoted
 * field stayed as a literal pair of quotes. A spreadsheet exported to CSV almost always has at
 * least one of the three, so the preview was a table whose columns had stopped lining up with
 * its header — and it looked like the *file* was wrong.
 *
 * RFC 4180 is the grammar actually in the wild, so that is what is implemented: a field may be
 * quoted, quotes inside a quoted field are doubled, a newline inside a quoted field belongs to
 * the field, and the record separator is CRLF, LF or CR. A truly empty line between records is
 * skipped, because every editor writes one at the end of a file.
 *
 * The delimiter comes from the extension rather than from sniffing the first line: a sniff
 * cannot tell a one-column CSV from a plain text log, and a preview whose shape depends on its
 * first row is worse than one whose shape depends on its name.
 */

/** Largest file the pane will load as a table. Past it the preview says so instead of hanging. */
export const MAX_CSV_BYTES = 4 * 1024 * 1024;
/** Rows kept for display. A million-row export is not a table this layout can hold. */
export const MAX_CSV_ROWS = 500;

export type DelimitedFormat = "csv" | "tsv";

function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

/** Which delimiter a name says the file uses, or null when it is not delimited text. */
export function delimitedFormatOf(filePath: string): DelimitedFormat | null {
  const ext = extensionOf(filePath);
  if (ext === ".tsv" || ext === ".tab") return "tsv";
  if (ext === ".csv") return "csv";
  return null;
}

export type DelimitedTable = {
  /** The rows kept, each with as many fields as its own record had. */
  rows: string[][];
  /** The table was cut short, and by what. */
  truncated: "rows" | "size" | null;
  /** Records in the whole text, including the ones not returned. */
  totalRows: number;
};

/**
 * Split delimited text into records.
 *
 * `maxRows` bounds what is *returned*, not what is read: the walk consumes the whole text so
 * `totalRows` can say how much was left out, which is the difference between a preview and a
 * truncated one that looks complete.
 */
export function parseDelimited(
  text: string,
  format: DelimitedFormat = "csv",
  options?: { maxRows?: number; truncatedBySize?: boolean },
): DelimitedTable {
  const delimiter = format === "tsv" ? "\t" : ",";
  const maxRows = options?.maxRows ?? MAX_CSV_ROWS;
  const rows: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  /** Something has been seen in this record, so a terminator ends a row rather than nothing. */
  let started = false;
  let totalRows = 0;

  const endRecord = (): void => {
    if (!started && record.length === 0 && field === "") return;
    record.push(field);
    field = "";
    started = false;
    totalRows += 1;
    if (rows.length < maxRows) rows.push(record);
    record = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        // `""` is one literal quote inside a quoted field; a lone `"` closes the field.
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    // A quote opens a field only at its start. `started` is already true after a comma, so it
    // cannot be part of this test — that is what used to split `"1,234"` into two columns.
    if (char === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (char === delimiter) {
      record.push(field);
      field = "";
      started = true;
      continue;
    }
    if (char === "\r" || char === "\n") {
      // CR LF is one separator; a lone CR (the old Mac export) is one too.
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
      continue;
    }
    field += char;
    started = true;
  }
  // The last record has no terminator. A file that ends *with* one is already closed above, so
  // this does not invent the empty row every editor writes. An unclosed quote is still a field.
  endRecord();

  const truncated = options?.truncatedBySize
    ? "size"
    : totalRows > rows.length
      ? "rows"
      : null;
  return { rows, truncated, totalRows };
}
