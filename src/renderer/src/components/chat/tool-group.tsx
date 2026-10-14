import { memo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import type { ToolGroup } from "@/lib/group-parts";
import { describeTool } from "@/lib/tool-presentation";
import { liveTool } from "@/lib/tool-run";
import { useWorkspacePath } from "@/stores/session";
import { Spinner } from "@/components/ui/spinner";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";
import { ToolRow } from "./tool-row";
import type { SummaryPiece } from "@/lib/tool-run";

function SummaryLine({ pieces }: { pieces: SummaryPiece[] }): JSX.Element {
  return (
    <>
      {pieces.map((piece, index) =>
        piece.kind === "file" ? (
          <span key={index} className="mx-0.5 truncate rounded-md bg-muted px-1.5 font-mono text-sm text-foreground">
            {piece.name}
          </span>
        ) : (
          <span key={index}>{piece.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Consecutive tools between two stretches of prose, collapsed by default.
 *
 * While a call in the batch is in flight the line is that call's description.
 * Once the batch has settled — the reply has moved on to the next sentence —
 * the line is the count, 「已运行 6 个命令」. The chevron stays visible: the
 * line is a fold, and a hover-only mark reads as static text.
 */
export const ToolGroupRow = memo(function ToolGroupRow({
  group,
  showThinking,
}: {
  group: ToolGroup;
  showThinking: boolean;
}): JSX.Element {
  useTranslation("common");
  const cwd = useWorkspacePath();
  const current = group.running ? liveTool(group.tools) : undefined;
  const view = current ? describeTool(current, cwd) : undefined;

  return (
    <ToolRow
      icon={view ? <Spinner className="size-3" /> : null}
      showIcon={Boolean(view)}
      label={view ? view.label : <SummaryLine pieces={group.pieces} />}
      subject={view?.subject}
      context={view?.context}
      running={Boolean(view)}
      quiet={!view}
      canToggle
      chevron="always"
      persistKey={group.id}
      title={view?.title ? `${view.title} · ${group.summary}` : group.summary}
    >
      {group.items.map((item, index) =>
        item.kind === "thinking" ? (
          showThinking ? (
            <ThinkingBlock
              key={`think-${index}`}
              thinking={item.part.text}
              startedAt={item.part.startedAt}
              endedAt={item.part.endedAt}
              active={false}
            />
          ) : null
        ) : (
          <ToolCard key={item.tool.id} tool={item.tool} />
        ),
      )}
    </ToolRow>
  );
});
