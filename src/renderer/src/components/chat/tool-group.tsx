import { memo, type JSX } from "react";
import type { ToolGroup } from "@/lib/group-parts";
import { describeTool } from "@/lib/tool-presentation";
import { ToolCard } from "./tool-card";
import { ToolRow } from "./tool-row";

function DiffStat({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-success">+{added}</span> <span className="text-destructive">−{removed}</span>
    </span>
  );
}

/**
 * A folded run of tools (zcode's explore / changes / terminal groups).
 *
 * The group label is the category noun; the line after it is either the aggregate
 * ("3 个搜索, 2 个列表, 5 个文件") once settled, or the live child action while the
 * run is still in flight.
 */
export const ToolGroupRow = memo(function ToolGroupRow({ group }: { group: ToolGroup }): JSX.Element {
  const last = group.tools.at(-1);
  const live = group.running && last ? describeTool(last) : undefined;
  const subject = live ? live.label : group.summary;
  const context = live ? live.subject : undefined;

  return (
    <ToolRow
      icon={group.icon}
      label={group.label}
      subject={subject}
      context={context}
      running={group.running}
      canToggle
      persistKey={group.id}
      title={`${group.label} · ${group.summary}`}
      trailing={group.stat ? <DiffStat added={group.stat.added} removed={group.stat.removed} /> : undefined}
    >
      {group.tools.map((tool) => (
        <ToolCard key={tool.id} tool={tool} showIcon={false} />
      ))}
    </ToolRow>
  );
});
