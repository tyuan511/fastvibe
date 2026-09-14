import { memo, type JSX } from "react";
import { cn } from "@/lib/utils";

type DiffLine = {
  kind: "added" | "removed" | "hunk" | "meta" | "context";
  marker: string;
  text: string;
};

/** Classify a unified-diff line the way zcode's lightweight preview does. */
function classify(line: string): DiffLine {
  if (line.startsWith("@@")) return { kind: "hunk", marker: "", text: line };
  if (line.startsWith("+++") || line.startsWith("---")) return { kind: "meta", marker: "", text: line };
  if (line.startsWith("+")) return { kind: "added", marker: "+", text: line.slice(1) };
  if (line.startsWith("-")) return { kind: "removed", marker: "-", text: line.slice(1) };
  if (line.startsWith(" ")) return { kind: "context", marker: " ", text: line.slice(1) };
  return { kind: "context", marker: "", text: line };
}

const ROW_STYLE: Record<DiffLine["kind"], string> = {
  added: "border-l-success bg-success/10",
  removed: "border-l-destructive bg-destructive/10",
  hunk: "border-l-transparent text-info",
  meta: "border-l-transparent text-muted-foreground/70",
  context: "border-l-transparent",
};

/** Line-numbered diff with a left colour bar, standing in for a full editor view. */
export const DiffView = memo(function DiffView({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className="mt-1.5 max-h-80 overflow-auto rounded-md border border-border bg-background font-mono text-[11px] leading-5 select-text">
      {lines.map((line, index) => {
        const { kind, marker, text: body } = classify(line);
        return (
          <div key={`${index}-${kind}`} className={cn("flex min-w-full border-l-2", ROW_STYLE[kind])}>
            <span
              aria-hidden
              className="w-10 shrink-0 border-r border-border px-1.5 text-right tabular-nums text-muted-foreground/50 select-none"
            >
              {kind === "hunk" || kind === "meta" ? "" : index + 1}
            </span>
            <span className="w-4 shrink-0 text-center text-muted-foreground/60 select-none">{marker}</span>
            <code className="block flex-1 whitespace-pre px-2">{body || " "}</code>
          </div>
        );
      })}
    </div>
  );
});
