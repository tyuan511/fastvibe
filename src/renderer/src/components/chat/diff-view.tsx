import { memo, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { parseDiff, splitDiffRows, changedRange, type DiffRow, type DiffRowKind } from "@/lib/diff";

/**
 * Rows drawn before the rest is folded behind a button.
 *
 * Every line of a diff is a handful of DOM nodes, and a tool result carries up to
 * 256 000 characters — a generated file or a wide refactor is thousands of lines built
 * into a box that shows about twenty at a time. The cap is generous enough that a
 * normal edit is never folded, and the fold is one click from the whole thing.
 */
const ROW_LIMIT = 400;

const ROW_STYLE: Record<DiffRowKind, string> = {
  added: "border-l-success bg-success/10",
  removed: "border-l-destructive bg-destructive/10",
  hunk: "bg-muted/60 text-muted-foreground",
  meta: "text-muted-foreground/70",
  context: "",
  skip: "text-muted-foreground/50",
};

const MARKER_STYLE: Record<DiffRowKind, string> = {
  added: "text-success",
  removed: "text-destructive",
  hunk: "",
  meta: "",
  context: "text-muted-foreground/60",
  skip: "",
};

/**
 * The two number columns, and the width they must share.
 *
 * A column is a *fixed* width, not a `min-width`: a floor lets the column that also
 * carries `border-r` grow to its own content — `2ch` of digits plus `0.75rem` of padding
 * plus that 1px border — on rows that carry a number, while a blank row stayed at the
 * floor. The two columns then differed by a pixel on exactly the rows next to a change,
 * and the rule between the gutter and the code stepped in and out down the whole diff.
 *
 * So both columns are one box: same padding, same 1px border (`border-r` is transparent on
 * the first, so only one line is drawn), and a width that counts all three. `overflow-hidden`
 * keeps a number wider than the box from doing what `min-width` did.
 */
const GUTTER_CELL = "shrink-0 select-none overflow-hidden px-1.5 text-right tabular-nums border-r";
const gutterWidth = (width: number) => ({ width: `calc(${width}ch + 0.75rem + 1px)` });

/** The two number columns: `old` is blank on an added line and `new` on a removed
 *  one, exactly as a unified diff reads. Header rows carry neither. */
function Gutter({ row, width }: { row: DiffRow; width: number }): JSX.Element {
  const size = gutterWidth(width);
  return (
    <>
      <span aria-hidden style={size} className={cn(GUTTER_CELL, "border-transparent text-muted-foreground/40")}>
        {row.oldNumber ?? ""}
      </span>
      <span aria-hidden style={size} className={cn(GUTTER_CELL, "border-border text-muted-foreground/60")}>
        {row.newNumber ?? ""}
      </span>
    </>
  );
}

/**
 * The one renderer for every diff in the app: a tool call's file change, a ```diff
 * fence in a reply, a `.patch` preview and the right pane's git diff. Numbers come
 * from the diff itself (`lib/diff.ts`), so a fragment that carries none is drawn
 * without a gutter rather than with an invented one.
 *
 * Lines always wrap. A diff is read for its content, not for its column alignment,
 * and the horizontal scrollbar a long line used to cost was worse than the wrap:
 * the transcript's cards are narrow, so the part worth reading sat off-screen with
 * no hint that anything was there. `overflow-x-hidden` is the promise, not the
 * wrapping — a row that cannot overflow cannot need one either way.
 */
export const DiffView = memo(function DiffView({
  text,
  className,
  mode = "unified",
  activeHunk,
  hideFileHeaders = false,
}: {
  text: string;
  className?: string;
  mode?: "unified" | "split";
  activeHunk?: number;
  hideFileHeaders?: boolean;
}): JSX.Element {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  const { rows, numberWidth } = useMemo(() => {
    const doc = parseDiff(text);
    return hideFileHeaders ? { ...doc, rows: doc.rows.filter((row) => row.kind !== "meta" || !/^(diff --git |index |--- |\+\+\+ )/.test(row.text)) } : doc;
  }, [text, hideFileHeaders]);
  const root = useRef<HTMLDivElement>(null);
  const pairs = useMemo(() => splitDiffRows(rows), [rows]);
  useEffect(() => { setExpanded(false); }, [text]);
  useEffect(() => {
    if (activeHunk === undefined || activeHunk < 0) return;
    setExpanded(true);
    const frame = requestAnimationFrame(() => root.current?.querySelectorAll<HTMLElement>("[data-diff-hunk]")[activeHunk]?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [activeHunk, mode]);
  const hidden = expanded ? 0 : Math.max(0, rows.length - ROW_LIMIT);
  const shown = hidden > 0 ? rows.slice(0, ROW_LIMIT) : rows;
  return (
    <div
      ref={root}
      className={cn(
        "mt-1.5 max-h-80 overflow-x-hidden overflow-y-auto rounded-md border border-border bg-background font-mono text-xs leading-5 select-text",
        className,
      )}
    >
      {mode === "split" ? (
        <div className="grid w-full grid-cols-2">
          {pairs.filter((pair) => !hidden || pair.sourceIndex < ROW_LIMIT).map((pair, index) => pair.header ? (
            <div key={index} data-diff-hunk={pair.header.kind === "hunk" ? "" : undefined} className={cn("col-span-2 px-3 py-0.5 whitespace-pre-wrap break-all", ROW_STYLE[pair.header.kind])}>{pair.header.text}</div>
          ) : (
            <div key={index} className="contents">
              <SplitCell row={pair.left} other={pair.right} side="old" width={numberWidth} />
              <SplitCell row={pair.right} other={pair.left} side="new" width={numberWidth} />
            </div>
          ))}
        </div>
      ) : shown.map((row, index) => (
        <div key={index} data-diff-hunk={row.kind === "hunk" ? "" : undefined} className={cn("flex w-full border-l-2 border-l-transparent", ROW_STYLE[row.kind])}>
          {numberWidth > 0 ? <Gutter row={row} width={numberWidth} /> : null}
          <span aria-hidden className={cn("w-4 shrink-0 text-center select-none", MARKER_STYLE[row.kind])}>
            {row.marker}
          </span>
          <code className="diff-line block min-w-0 flex-1 px-2 whitespace-pre-wrap break-all">{row.text || " "}</code>
        </div>
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          className="glass-cover sticky bottom-0 block w-full border-t border-border bg-muted/60 px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          {t("diff.more", { count: hidden })}
        </button>
      ) : null}
    </div>
  );
});

function SplitCell({ row, other, side, width }: { row?: DiffRow; other?: DiffRow; side: "old" | "new"; width: number }): JSX.Element {
  const changed = row && (row.kind === "added" || row.kind === "removed");
  const range = changed && other ? changedRange(row.text, other.text) : undefined;
  return (
    <div className={cn("flex min-w-0 border-l-2 border-l-transparent first:border-r first:border-r-border", row ? ROW_STYLE[row.kind] : "bg-muted/40")}>
      {width > 0 ? <span aria-hidden style={gutterWidth(width)} className={cn(GUTTER_CELL, "border-border text-muted-foreground/60")}>{(side === "old" ? row?.oldNumber : row?.newNumber) ?? ""}</span> : null}
      <code className="diff-line block min-w-0 flex-1 px-2 whitespace-pre-wrap break-all">
        {range && row ? <>{row.text.slice(0, range[0])}<span className={row.kind === "added" ? "bg-success/25" : "bg-destructive/25"}>{row.text.slice(range[0], range[1])}</span>{row.text.slice(range[1])}</> : row?.text || " "}
      </code>
    </div>
  );
}
