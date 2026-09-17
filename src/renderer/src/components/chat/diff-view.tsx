import { memo, type JSX } from "react";
import { cn } from "@/lib/utils";
import { parseDiff, type DiffRow, type DiffRowKind } from "@/lib/diff";

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
  const { rows, numberWidth } = parseDiff(text);
  return (
    <div
      className={cn(
        "mt-1.5 max-h-80 overflow-auto rounded-md border border-border bg-background font-mono text-sm leading-5 select-text",
        className,
      )}
    >
      {rows.map((row, index) => (
        <div key={index} className={cn("flex min-w-full border-l-2 border-l-transparent", ROW_STYLE[row.kind])}>
          {numberWidth > 0 ? <Gutter row={row} width={numberWidth} /> : null}
          <span aria-hidden className={cn("w-4 shrink-0 text-center select-none", MARKER_STYLE[row.kind])}>
            {row.marker}
          </span>
          <code className="block flex-1 whitespace-pre px-2">{row.text || " "}</code>
        </div>
      ))}
    </div>
  );
});
