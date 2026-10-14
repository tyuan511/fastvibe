import { useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, Search01Icon, UnfoldMoreIcon } from "@hugeicons/core-free-icons";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { numericColumns } from "@shared/file-document";

/**
 * A CSV or a spreadsheet sheet, as a table rather than as text.
 *
 * The rows arrive parsed (the main process already knows how to read `.csv` and
 * `.xlsx`), so this decides presentation only: whether the first row is a header, which
 * columns are numeric, and how the reader narrows a large sheet. Alignment is computed
 * over the **body** — a header row is a label and would make every column a text column.
 *
 * Sorting and filtering are local: the sheet is already in memory, and a round trip to
 * the host to reorder a table would be a slower way to sort an array.
 */

type Sort = { column: number; direction: "asc" | "desc" };

export function CsvPreview({ rows, name }: { rows: string[][]; name: string }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [sort, setSort] = useState<Sort | null>(null);
  const [query, setQuery] = useState("");

  const hasHeader = useMemo(() => looksLikeHeader(rows), [rows]);
  const header = hasHeader ? rows[0]! : undefined;
  const body = useMemo(() => (hasHeader ? rows.slice(1) : rows), [rows, hasHeader]);
  const numeric = useMemo(() => numericColumns(body), [body]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return body;
    return body.filter((row) => row.some((cell) => cell.toLowerCase().includes(needle)));
  }, [body, query]);

  const sorted = useMemo(() => {
    if (sort === null) return filtered;
    const factor = sort.direction === "asc" ? 1 : -1;
    // A stable copy: the caller's array is a prop, and sorting in place would mutate it.
    return [...filtered].sort((a, b) => factor * compareCells(a[sort.column] ?? "", b[sort.column] ?? "", numeric.has(sort.column)));
  }, [filtered, sort, numeric]);

  function toggle(column: number): void {
    setSort((current) => {
      if (current?.column !== column) return { column, direction: "asc" };
      return current.direction === "asc" ? { column, direction: "desc" } : null;
    });
  }

  if (rows.length === 0) {
    return <p className="px-3 py-3 text-sm text-muted-foreground">{t("files.emptyFile")}</p>;
  }

  // The widest row decides the column count: a ragged sheet is normal, and a short row
  // must not truncate the table below it.
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);

  return (
    <div className="chat-csv">
      <div className="chat-csv-bar">
        <div className="relative">
          <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            className="h-7 w-56 pl-7 text-xs"
            placeholder={t("files.filterRows")}
            aria-label={t("files.filterRows")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
          {query.trim() === ""
            ? t("files.rowCount", { count: body.length })
            : t("files.rowCountFiltered", { shown: sorted.length, count: body.length })}
        </span>
      </div>
      <div className="chat-csv-scroll" tabIndex={0} role="region" aria-label={t("files.tablePreview")}>
        <table>
          {header ? (
            <thead>
              <tr>
                {header.map((cell, column) => (
                  <th
                    key={column}
                    scope="col"
                    data-numeric={numeric.has(column) ? "" : undefined}
                    aria-sort={sort?.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button type="button" onClick={() => toggle(column)} title={t("files.sortBy", { column: cell || String(column + 1) })}>
                      <span>{cell}</span>
                      <HugeiconsIcon
                        strokeWidth={2}
                        icon={sort?.column === column ? (sort.direction === "asc" ? ArrowUp01Icon : ArrowDown01Icon) : UnfoldMoreIcon}
                        className={cn("size-3.5 shrink-0", sort?.column === column ? "text-foreground" : "text-muted-foreground/60")}
                      />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {sorted.map((row, index) => (
              <tr key={index}>
                {Array.from({ length: width }, (_, column) => (
                  <td key={column} data-numeric={numeric.has(column) ? "" : undefined}>
                    {row[column] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="sr-only">{name}</span>
    </div>
  );
}

/**
 * Is the first row a header?
 *
 * A header is all text while the rows under it are mostly not, which is the shape a
 * spreadsheet has. The test is deliberately one-sided: guessing wrong the other way
 * would eat a real data row, and a table drawn with its header in the body is only
 * cosmetically wrong.
 */
function looksLikeHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0]!;
  if (first.length === 0) return false;
  const body = rows.slice(1, 21);
  const headerNumeric = first.filter((cell) => cell.trim() !== "" && isNumeric(cell)).length;
  const bodyNumeric = body.flat().filter((cell) => cell.trim() !== "" && isNumeric(cell)).length;
  const bodyCells = body.flat().filter((cell) => cell.trim() !== "").length;
  if (headerNumeric > 0) return false;
  return bodyCells > 0 && bodyNumeric / bodyCells > 0.5;
}

function isNumeric(cell: string): boolean {
  return /^[-+(]?[$€£¥]?\d[\d,._ ']*(?:[.,]\d+)?[)%]?[kKmMbB]?$/.test(cell.trim());
}

/** Numbers compare as numbers, so `9` does not sort after `10`. */
function compareCells(a: string, b: string, isNumber: boolean): number {
  if (isNumber) {
    const left = toNumber(a);
    const right = toNumber(b);
    if (left !== null && right !== null) return left - right;
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function toNumber(value: string): number | null {
  const cleaned = value.replace(/[$€£¥,\s']/g, "").replace(/%$/, "");
  if (cleaned === "") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}
