import { memo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { BrainIcon, Layers01Icon } from "@hugeicons/core-free-icons";
import type { ToolGroup } from "@/lib/group-parts";
import { describeTool } from "@/lib/tool-presentation";
import { liveTool } from "@/lib/tool-run";
import type { ThinkingPart } from "@/lib/tool-run";
import { useWorkspacePath } from "@/stores/session";
import { PathLink } from "@/components/path-menu";
import { displayPath } from "@/lib/workspace-path";
import { Spinner } from "@/components/ui/spinner";
import { ReasoningTicker, tickerLine } from "./thinking-block";
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
 * One thought the row swallowed, shown in the body when the batch is expanded. The row
 * itself is the fold, so the text carries no second chevron — but it does keep a 「思考」
 * mark, because between two call cards a bare paragraph reads as one more tool's output.
 */
function FoldedThought({ part }: { part: ThinkingPart }): JSX.Element {
  const { t } = useTranslation("chat");
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70">
        <HugeiconsIcon strokeWidth={2} icon={BrainIcon} className="size-3 shrink-0" />
        {t("thinking.done")}
      </span>
      <div className="max-h-60 overflow-auto border-l border-border pl-3.5 text-sm leading-5 whitespace-pre-wrap break-words text-muted-foreground/80 select-text">
        {part.text}
      </div>
    </div>
  );
}

/**
 * Consecutive tools (and, with 折叠思考内容, the thoughts among them) between two stretches
 * of prose, collapsed by default.
 *
 * While a call in the batch is in flight the line is that call's description. While a
 * swallowed thought is still being written the line shimmers 「正在思考」 and previews the
 * growing text, exactly as an unfolded thinking block does — the fold changes where the
 * thought lives, not how its live state reads. Once the batch has settled — the reply has
 * moved on to the next sentence — the line is the count, 「已思考 2 次，已运行 6 个命令」.
 * It keeps a tool-call icon and the same weight as the rows around it; the chevron stays
 * visible because the line is a fold, and a hover-only mark reads as static text.
 */
export const ToolGroupRow = memo(function ToolGroupRow({ group }: { group: ToolGroup }): JSX.Element {
  const { t } = useTranslation("chat");
  useTranslation("common");
  const cwd = useWorkspacePath();
  const thought = group.liveThinking;
  const current = thought === undefined && group.running ? liveTool(group.tools) : undefined;
  const view = current ? describeTool(current, cwd) : undefined;
  const ticker = thought ? tickerLine(thought.text) : null;

  return (
    <ToolRow
      icon={
        thought ? (
          <HugeiconsIcon strokeWidth={2} icon={BrainIcon} />
        ) : view ? (
          <Spinner className="size-3" />
        ) : (
          <HugeiconsIcon strokeWidth={2} icon={Layers01Icon} />
        )
      }
      label={thought ? t("thinking.running") : view ? view.label : <SummaryLine pieces={group.pieces} cwd={cwd} />}
      filler={ticker ? <ReasoningTicker text={ticker} /> : undefined}
      subject={view?.subject}
      context={view?.context}
      running={Boolean(view) || thought !== undefined}
      quiet={!view && thought === undefined}
      canToggle
      chevron="always"
      persistKey={group.id}
      title={view?.title ? `${view.title} · ${group.summary}` : group.summary}
    >
      {group.items.map((item, index) =>
        item.kind === "tool" ? (
          <ToolCard key={item.tool.id} tool={item.tool} />
        ) : (
          <FoldedThought key={`thought-${index}`} part={item.part} />
        ),
      )}
    </ToolRow>
  );
});
