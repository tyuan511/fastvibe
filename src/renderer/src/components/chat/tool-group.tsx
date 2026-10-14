import { memo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Layers01Icon } from "@hugeicons/core-free-icons";
import type { ToolGroup } from "@/lib/group-parts";
import { describeTool } from "@/lib/tool-presentation";
import { liveTool } from "@/lib/tool-run";
import { useWorkspacePath } from "@/stores/session";
import { PathLink } from "@/components/path-menu";
import { displayPath } from "@/lib/workspace-path";
import { Spinner } from "@/components/ui/spinner";
import { ToolCard } from "./tool-card";
import { ToolRow } from "./tool-row";
import type { SummaryPiece } from "@/lib/tool-run";

function SummaryLine({ pieces, cwd }: { pieces: SummaryPiece[]; cwd?: string }): JSX.Element {
  return (
    <>
      {pieces.map((piece, index) =>
        piece.kind === "file" ? (
          piece.path ? (
            // The fold row is itself a button. The link stops the click, so previewing
            // the file does not also expand the batch.
            <PathLink
              key={index}
              path={piece.path}
              title={displayPath(piece.path, cwd)}
              className="font-mono"
            >
              {piece.name}
            </PathLink>
          ) : (
            // Inline, so the row's own ellipsis can cut a long query. A flex item
            // here shrinks to nothing and the text paints over the next clause.
            <span key={index} className="mx-0.5 rounded-md bg-muted px-1.5 font-mono text-foreground">
              {piece.name}
            </span>
          )
        ) : (
          <span key={index}>{piece.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Consecutive tools between two stretches of prose or a thought, collapsed by default.
 * A thinking block is not part of this row — it splits the batch and renders on its own.
 *
 * While a call in the batch is in flight the line is that call's description.
 * Once the batch has settled — the reply has moved on to the next sentence —
 * the line is the count, 「已运行 6 个命令」. It keeps a tool-call icon and the
 * same weight as the rows around it; the chevron stays visible because the
 * line is a fold, and a hover-only mark reads as static text.
 */
export const ToolGroupRow = memo(function ToolGroupRow({ group }: { group: ToolGroup }): JSX.Element {
  useTranslation("common");
  const cwd = useWorkspacePath();
  const current = group.running ? liveTool(group.tools) : undefined;
  const view = current ? describeTool(current, cwd) : undefined;

  return (
    <ToolRow
      icon={
        view ? (
          <Spinner className="size-3" />
        ) : (
          <HugeiconsIcon strokeWidth={2} icon={Layers01Icon} />
        )
      }
      label={view ? view.label : <SummaryLine pieces={group.pieces} cwd={cwd} />}
      subject={view?.subject}
      context={view?.context}
      running={Boolean(view)}
      quiet={!view}
      canToggle
      chevron="always"
      persistKey={group.id}
      title={view?.title ? `${view.title} · ${group.summary}` : group.summary}
    >
      {group.tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} />
      ))}
    </ToolRow>
  );
});
