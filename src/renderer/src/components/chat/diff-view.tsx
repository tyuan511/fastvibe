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

/** The two number columns: `old` is blank on an added line and `new` on a removed
 *  one, exactly as a unified diff reads. Header rows carry neither. */
function Gutter({ row, width }: { row: DiffRow; width: number }): JSX.Element {
  const cell = "shrink-0 select-none px-1.5 text-right tabular-nums";
  const size = { minWidth: `calc(${width}ch + 0.75rem)` };
  return (
    <>
      <span aria-hidden style={size} className={cn(cell, "text-muted-foreground/40")}>
        {row.oldNumber ?? ""}
      </span>
      <span aria-hidden style={size} className={cn(cell, "border-r border-border text-muted-foreground/60")}>
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
 */
export const DiffView = memo(function DiffView({
  text,
  className,
  mode = "unified",
  wrap = false,
  activeHunk,
  hideFileHeaders = false,
}: {
  text: string;
  className?: string;
  mode?: "unified" | "split";
  wrap?: boolean;
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
        "mt-1.5 max-h-80 overflow-auto rounded-md border border-border bg-background font-mono text-xs leading-5 select-text",
        className,
      )}
    >
      {mode === "split" ? (
        <div className={cn("grid min-w-full", wrap ? "grid-cols-2" : "grid-cols-[minmax(max-content,1fr)_minmax(max-content,1fr)]")}>
          {pairs.filter((pair) => !hidden || pair.sourceIndex < ROW_LIMIT).map((pair, index) => pair.header ? (
            <div key={index} data-diff-hunk={pair.header.kind === "hunk" ? "" : undefined} className={cn("col-span-2 px-3 py-0.5 whitespace-pre-wrap break-all", ROW_STYLE[pair.header.kind])}>{pair.header.text}</div>
          ) : (
            <div key={index} className="contents">
              <SplitCell row={pair.left} other={pair.right} side="old" width={numberWidth} wrap={wrap} />
              <SplitCell row={pair.right} other={pair.left} side="new" width={numberWidth} wrap={wrap} />
            </div>
          ))}
        </div>
      ) : shown.map((row, index) => (
        <div key={index} data-diff-hunk={row.kind === "hunk" ? "" : undefined} className={cn("flex min-w-full border-l-2 border-l-transparent", wrap ? "w-full" : "w-max", ROW_STYLE[row.kind])}>
          {numberWidth > 0 ? <Gutter row={row} width={numberWidth} /> : null}
          <span aria-hidden className={cn("w-4 shrink-0 text-center select-none", MARKER_STYLE[row.kind])}>
            {row.marker}
          </span>
          <code className={cn("block min-w-0 flex-1 px-2", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>{row.text || " "}</code>
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

function SplitCell({ row, other, side, width, wrap }: { row?: DiffRow; other?: DiffRow; side: "old" | "new"; width: number; wrap: boolean }): JSX.Element {
  const changed = row && (row.kind === "added" || row.kind === "removed");
  const range = changed && other ? changedRange(row.text, other.text) : undefined;
  return (
    <div className={cn("flex min-w-0 border-l-2 border-l-transparent first:border-r first:border-r-border", row ? ROW_STYLE[row.kind] : "bg-muted/40")}>
      {width > 0 ? <span aria-hidden className="shrink-0 border-r border-border px-1.5 text-right text-muted-foreground/60 select-none" style={{ minWidth: `calc(${width}ch + 0.75rem)` }}>{(side === "old" ? row?.oldNumber : row?.newNumber) ?? ""}</span> : null}
      <code className={cn("block min-w-0 flex-1 px-2", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
        {range && row ? <>{row.text.slice(0, range[0])}<span className={row.kind === "added" ? "bg-success/25" : "bg-destructive/25"}>{row.text.slice(range[0], range[1])}</span>{row.text.slice(range[1])}</> : row?.text || " "}
      </code>
    </div>
  );
}
