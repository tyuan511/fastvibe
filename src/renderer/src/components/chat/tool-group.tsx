import { memo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { BrainIcon, Layers01Icon } from "@hugeicons/core-free-icons";
import type { ChatMessage, MessagePart } from "@shared/types";
import type { ToolGroup } from "@/lib/group-parts";
import type { ThinkingPart } from "@/lib/tool-run";
import { useWorkspacePath } from "@/stores/session";
import { PathLink } from "@/components/path-menu";
import { displayPath } from "@/lib/workspace-path";
import { ReasoningTicker, ThinkingBlock, tickerLine } from "./thinking-block";
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
 * One thought the row swallowed, shown in the body when the batch is expanded. It is the
 * ordinary thinking block — collapsed to its 「思考」 line, opened by the reader — so a
 * folded thought looks and behaves like one outside the fold. Not `active`: a live thought
 * is the row's own 「正在思考」 line, and only settled ones are listed here.
 */
function FoldedThought({
  part,
  owner,
}: {
  part: ThinkingPart;
  owner?: ChatMessage;
}): JSX.Element {
  // Same fallback as an unfolded block: the round-trip the thought came from, when no bounds were measured.
  const fallback =
    owner && owner.completedAt !== undefined ? { startedAt: owner.createdAt, endedAt: owner.completedAt } : undefined;
  return (
    <ThinkingBlock
      thinking={part.text}
      startedAt={part.startedAt ?? fallback?.startedAt}
      endedAt={part.endedAt ?? fallback?.endedAt}
      active={false}
    />
  );
}

/**
 * Consecutive **settled** tools (and, with 折叠思考内容, the thoughts among them) between two
 * stretches of prose, collapsed by default.
 *
 * A call in flight is never here: it stands on its own line below the fold, so this row is
 * only ever the count, 「已思考 2 次，已运行 6 个命令」. The one live thing a row can still be
 * writing is a thought the option swallowed — the line then shimmers 「正在思考」 and previews
 * the growing text, exactly as an unfolded thinking block does, because the option folds
 * thinking *into* the row and must not change how a live thought reads.
 *
 * It keeps a tool-call icon and the same weight as the rows around it; the chevron stays
 * visible because the line is a fold, and a hover-only mark reads as static text.
 */
export const ToolGroupRow = memo(function ToolGroupRow({
  group,
  thinkingOwner,
}: {
  group: ToolGroup;
  thinkingOwner?: ReadonlyMap<MessagePart, ChatMessage>;
}): JSX.Element {
  const { t } = useTranslation("chat");
  useTranslation("common");
  const cwd = useWorkspacePath();
  const thought = group.liveThinking;
  const ticker = thought ? tickerLine(thought.text) : null;

  return (
    <ToolRow
      icon={
        thought ? (
          <HugeiconsIcon strokeWidth={2} icon={BrainIcon} />
        ) : (
          <HugeiconsIcon strokeWidth={2} icon={Layers01Icon} />
        )
      }
      label={thought ? t("thinking.running") : <SummaryLine pieces={group.pieces} cwd={cwd} />}
      filler={ticker ? <ReasoningTicker text={ticker} /> : undefined}
      running={thought !== undefined}
      quiet={thought === undefined}
      canToggle
      chevron="always"
      scrollBody
      persistKey={group.id}
      title={group.summary}
    >
      {group.items.map((item, index) =>
        item.kind === "tool" ? (
          <ToolCard key={item.tool.id} tool={item.tool} />
        ) : (
          <FoldedThought key={`thought-${index}`} part={item.part} owner={thinkingOwner?.get(item.part)} />
        ),
      )}
    </ToolRow>
  );
});
