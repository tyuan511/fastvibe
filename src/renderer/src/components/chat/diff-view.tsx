import { memo, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { parseDiff, type DiffRow, type DiffRowKind } from "@/lib/diff";

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
}: {
  text: string;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  const { rows, numberWidth } = useMemo(() => parseDiff(text), [text]);
  const hidden = expanded ? 0 : Math.max(0, rows.length - ROW_LIMIT);
  const shown = hidden > 0 ? rows.slice(0, ROW_LIMIT) : rows;
  return (
    <div
      className={cn(
        "mt-1.5 max-h-80 overflow-auto rounded-md border border-border bg-background font-mono text-xs leading-5 select-text",
        className,
      )}
    >
      {shown.map((row, index) => (
        <div key={index} className={cn("flex w-max min-w-full border-l-2 border-l-transparent", ROW_STYLE[row.kind])}>
          {numberWidth > 0 ? <Gutter row={row} width={numberWidth} /> : null}
          <span aria-hidden className={cn("w-4 shrink-0 text-center select-none", MARKER_STYLE[row.kind])}>
            {row.marker}
          </span>
          <code className="block flex-1 whitespace-pre px-2">{row.text || " "}</code>
        </div>
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          className="sticky bottom-0 block w-full border-t border-border bg-muted/60 px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          {t("diff.more", { count: hidden })}
        </button>
      ) : null}
    </div>
  );
});
