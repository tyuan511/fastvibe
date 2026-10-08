import { useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, ArrowDown01Icon, RefreshIcon, StopIcon, ViewIcon } from "@hugeicons/core-free-icons";
import { MarkdownView } from "@/components/chat/markdown-view";
import { DagStatusIcon } from "@/components/dag-status-icon";
import { Button } from "@/components/ui/button";
import { abortSubagent } from "@/lib/engine-client";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { DAG_READONLY_TOOLS, dagNodeFinished, type DagNode } from "@shared/dag";
import { useNow } from "./dag-canvas";

/**
 * Everything about one node's state — what it was told, who it is, what it produced or why it
 * failed — and the ways into it: its run, stop, retry. Read live from the graph by the caller, so
 * it follows the node through a run, a retry or a resume.
 */
export function DagNodeDetail({
  node,
  nodes,
  conversationId,
  onSelectNode,
  onOpenRun,
}: {
  node: DagNode;
  nodes: DagNode[];
  conversationId: string;
  /** Another node picked from the dependency lists. */
  onSelectNode: (id: string) => void;
  /** 查看执行过程: show this node's run. */
  onOpenRun: () => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const now = useNow(!dagNodeFinished(node.status));
  const onSelect = onSelectNode;
  const elapsed = node.startedAt ? (node.endedAt ?? now) - node.startedAt : undefined;
  const downstream = nodes.filter((item) => item.dependsOn.includes(node.id)).map((item) => item.id);
  const tools = node.profile.tools?.length ? node.profile.tools : DAG_READONLY_TOOLS;
  const failure = (error: unknown): void => void toast.error(error instanceof Error ? error.message : String(error));

  return (
    <section className="flex min-w-0 flex-col gap-4 px-4 py-4 text-sm">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <DagStatusIcon status={node.status} label={t(`dag.status.${node.status}`)} />
          <span className="rounded bg-muted px-1.5 font-mono leading-5">{node.id}</span>
          <span>{t(`dag.status.${node.status}`)}</span>
          {node.attempt && node.attempt > 1 ? <span>· {t("dag.attempt", { n: node.attempt })}</span> : null}
          {elapsed !== undefined ? <span className="ml-auto tabular-nums">{formatDuration(elapsed)}</span> : null}
        </div>
        <h2 className="text-lg leading-7 font-semibold wrap-break-word">{node.title}</h2>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {node.runId ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onOpenRun}
          >
            <HugeiconsIcon strokeWidth={2} icon={ViewIcon} data-icon="inline-start" />
            {t("dag.viewRun")}
          </Button>
        ) : null}
        {node.status === "running" && node.runId ? (
          <Button type="button" size="xs" variant="outline" onClick={() => void abortSubagent(node.runId!, conversationId).catch(failure)}>
            <HugeiconsIcon strokeWidth={2} icon={StopIcon} data-icon="inline-start" />
            {t("dag.stop")}
          </Button>
        ) : null}
        {node.status === "failed" || node.status === "cancelled" ? (
          <Button type="button" size="xs" variant="outline" onClick={() => void window.fastvibe.dag.retry(conversationId, node.id).catch(failure)}>
            <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} data-icon="inline-start" />
            {t("dag.retry")}
          </Button>
        ) : null}
      </div>

      {node.error ? (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/8 px-2.5 py-2 text-destructive">
          <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="mt-0.5 size-3.5 shrink-0" />
          <p className="min-w-0 leading-5 wrap-break-word whitespace-pre-wrap">{node.error}</p>
        </div>
      ) : null}

      <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2">
        <Meta label={t("dag.profile")}>
          <span className="font-medium">{node.profile.name}</span>
          {node.profile.description ? <span className="block text-xs leading-5 text-muted-foreground">{node.profile.description}</span> : null}
        </Meta>
        <Meta label={t("dag.tools")}>
          <span className="flex flex-wrap gap-1">
            {tools.map((tool) => (
              <span
                key={tool}
                className={cn(
                  "rounded-md px-1.5 font-mono text-xs leading-5",
                  DAG_READONLY_TOOLS.includes(tool) ? "bg-muted text-muted-foreground" : "bg-warning/12 text-warning",
                )}
              >
                {tool}
              </span>
            ))}
          </span>
        </Meta>
        {node.model ? (
          <Meta label={t("dag.model")}>
            <span className="font-mono text-xs leading-5 break-all text-muted-foreground">{node.model}</span>
          </Meta>
        ) : null}
        <Meta label={t("dag.dependsOn")}>
          <Links ids={node.dependsOn} nodes={nodes} onSelect={onSelect} empty={t("dag.none")} />
        </Meta>
        {downstream.length > 0 ? (
          <Meta label={t("dag.unlocks")}>
            <Links ids={downstream} nodes={nodes} onSelect={onSelect} empty={t("dag.none")} />
          </Meta>
        ) : null}
      </dl>

      <Block label={t("dag.instruction")} clamp>
        <p className="leading-5 wrap-break-word whitespace-pre-wrap text-muted-foreground">{node.instruction}</p>
      </Block>

      {node.output ? (
        <Block label={t("dag.output")}>
          <div className="chat-markdown max-h-80 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 text-sm leading-6">
            <MarkdownView text={node.output} />
          </div>
        </Block>
      ) : null}
    </section>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-xs leading-5 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** A labelled block; `clamp` folds a long one to a few lines with a way to open it. */
function Block({ label, clamp = false, children }: { label: string; clamp?: boolean; children: ReactNode }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className={cn(clamp && !open && "max-h-24 overflow-hidden mask-[linear-gradient(to_bottom,black_60%,transparent)]")}>{children}</div>
      {clamp ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className={cn("size-3 transition-transform", open && "rotate-180")} />
          {open ? t("dag.collapse") : t("dag.expand")}
        </button>
      ) : null}
    </div>
  );
}

function Links({ ids, nodes, onSelect, empty }: { ids: string[]; nodes: DagNode[]; onSelect: (id: string) => void; empty: string }): JSX.Element {
  if (ids.length === 0) return <span className="text-xs leading-5 text-muted-foreground">{empty}</span>;
  return (
    <span className="flex flex-col gap-1">
      {ids.map((id) => {
        const target = nodes.find((item) => item.id === id);
        return (
          <button
            key={id}
            type="button"
            className="flex min-w-0 items-center gap-1.5 rounded-md text-left hover:text-primary"
            onClick={() => onSelect(id)}
          >
            {target ? <DagStatusIcon status={target.status} label={target.status} /> : null}
            <span className="font-mono text-xs text-muted-foreground">{id}</span>
            <span className="min-w-0 truncate">{target?.title}</span>
          </button>
        );
      })}
    </span>
  );
}
