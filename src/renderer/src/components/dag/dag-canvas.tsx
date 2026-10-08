import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlayIcon, StopIcon } from "@hugeicons/core-free-icons";
import { DagStatusIcon } from "@/components/dag-status-icon";
import { RunningMark } from "@/components/running-mark";
import { Button } from "@/components/ui/button";
import { DAG_CELL, layoutDag } from "@/lib/dag-layout";
import { formatDuration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { dagGraphState, type DagGraphState, type DagNode, type DagNodeStatus } from "@shared/dag";

/**
 * The pieces every view of a sub-agent task graph is drawn from: the canvas (layered, scaled to
 * fit), its summary line, and the node cards. Shared by the card inline in the conversation and
 * the maximised dialog, so the two cannot drift apart.
 */

/** The accent each state is drawn in: the card's stripe and the progress bar's segment. */
export const STATUS_FILL: Record<DagNodeStatus, string> = {
  pending: "bg-muted-foreground/25",
  running: "bg-warning",
  completed: "bg-success",
  failed: "bg-destructive",
  blocked: "bg-warning",
  skipped: "bg-muted-foreground/40",
  cancelled: "bg-muted-foreground/40",
};

const STATE_TONE: Record<DagGraphState, string> = {
  running: "bg-warning/12 text-warning",
  stopped: "bg-warning/12 text-warning",
  failed: "bg-destructive/10 text-destructive",
  completed: "bg-success/12 text-success",
};


/** A clock that ticks once a second while something is running, so a live node's duration moves. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The canvas's horizontal padding, which the graph must fit inside. */
const CANVAS_PADDING = 32;

/** How far to shrink a graph `width` wide to fit the element: 1 when it fits already, never below `min`. */
function useFitScale(ref: React.RefObject<HTMLDivElement | null>, width: number, min: number): number {
  const [available, setAvailable] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (): void => setAvailable(element.clientWidth - CANVAS_PADDING);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  if (!available || width <= 0 || available >= width) return 1;
  return Math.max(min, available / width);
}

/**
 * The graph: layered top to bottom (`layoutDag`), scaled down to the box's width when wider —
 * never up, and not below `minScale`, past which it scrolls. `className` sizes and pads the box,
 * which is also the scroll container.
 */
export function DagCanvas({
  nodes,
  selectedId,
  onSelect,
  minScale = 0.6,
  className,
}: {
  nodes: DagNode[];
  selectedId?: string | null;
  onSelect: (node: DagNode) => void;
  minScale?: number;
  className?: string;
}): JSX.Element {
  const layout = layoutDag(nodes);
  const ref = useRef<HTMLDivElement>(null);
  const scale = useFitScale(ref, layout.width, minScale);
  const now = useNow(nodes.some((node) => node.status === "running"));
  const selected = nodes.find((node) => node.id === selectedId);
  const neighbours = new Set(selected ? [...selected.dependsOn, ...nodes.filter((node) => node.dependsOn.includes(selected.id)).map((node) => node.id)] : []);

  useEffect(() => {
    if (!selectedId) return;
    ref.current?.querySelector(`[data-node="${selectedId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);

  return (
    <div
      ref={ref}
      className={cn("overflow-auto bg-[radial-gradient(var(--border)_1px,transparent_1px)] px-4 py-5", className)}
      style={{ backgroundSize: "14px 14px" }}
    >
      <div className="mx-auto" style={{ width: layout.width * scale, height: layout.height * scale }}>
        <div className="relative origin-top-left" style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}>
            <svg className="pointer-events-none absolute inset-0 overflow-visible" width={layout.width} height={layout.height} aria-hidden>
              {layout.edges.map((edge) => {
                const from = layout.positions.get(edge.from);
                const to = layout.positions.get(edge.to);
                const source = nodes.find((node) => node.id === edge.from);
                const target = nodes.find((node) => node.id === edge.to);
                if (!from || !to || !source || !target) return null;
                const y1 = from.y + DAG_CELL.height / 2;
                const y2 = to.y - DAG_CELL.height / 2;
                const bend = Math.max(12, (y2 - y1) / 2);
                const hot = selected?.id === edge.from || selected?.id === edge.to;
                // Work is flowing along an edge into a running node; one into a node still waiting is
                // dashed; one whose result was handed over is solid.
                const flowing = target.status === "running";
                const waiting = source.status !== "completed";
                const path = `M${from.x} ${y1} C${from.x} ${y1 + bend} ${to.x} ${y2 - bend} ${to.x} ${y2}`;
                return (
                  <g key={`${edge.from}>${edge.to}`}>
                    <path
                      d={path}
                      fill="none"
                      strokeLinecap="round"
                      strokeWidth={hot ? 2 : 1.5}
                      strokeDasharray={waiting || flowing ? "4 4" : undefined}
                      className={cn(
                        hot ? "stroke-primary/70" : flowing ? "stroke-warning/70" : source.status === "completed" ? "stroke-success/45" : "stroke-border",
                      )}
                    >
                      {flowing ? <animate attributeName="stroke-dashoffset" from="16" to="0" dur="0.9s" repeatCount="indefinite" /> : null}
                    </path>
                    <circle cx={to.x} cy={y2} r={2.5} className={hot ? "fill-primary/70" : flowing ? "fill-warning/70" : "fill-border"} />
                  </g>
                );
              })}
            </svg>
            {nodes.map((node) => {
              const at = layout.positions.get(node.id);
              if (!at) return null;
              return (
                <NodeCard
                  key={node.id}
                  node={node}
                  now={now}
                  selected={selected?.id === node.id}
                  related={neighbours.has(node.id)}
                  style={{ left: at.x - DAG_CELL.width / 2, top: at.y - DAG_CELL.height / 2, width: DAG_CELL.width, height: DAG_CELL.height }}
                  onSelect={() => onSelect(node)}
                />
              );
            })}
        </div>
      </div>
    </div>
  );
}

/** Where the whole graph stands: a state, a bar split by node state, the count, and what can be done. */
export function DagSummary({
  nodes,
  conversationId,
  compact = false,
  trailing,
}: {
  nodes: DagNode[];
  conversationId: string;
  /** One line (the inline card's header): no legend, the bar between the count and the actions. */
  compact?: boolean;
  /** Placed after the actions — the inline card's 最大化. */
  trailing?: ReactNode;
}): JSX.Element {
  const state = dagGraphState(nodes);
  const { t } = useTranslation("sidepane");
  const counts = new Map<DagNodeStatus, number>();
  for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  const order: DagNodeStatus[] = ["completed", "running", "blocked", "failed", "cancelled", "skipped", "pending"];
  const completed = counts.get("completed") ?? 0;
  const failure = (error: unknown): void => void toast.error(error instanceof Error ? error.message : String(error));

  return (
    <div className={cn("flex shrink-0 flex-col gap-2", !compact && "px-4 pt-3 pb-3")}>
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-medium", STATE_TONE[state])}>
          {state === "running" ? <RunningMark className="text-warning" label={t("dag.state.running")} /> : null}
          {t(`dag.state.${state}`)}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{t("dag.progress", { done: completed, total: nodes.length })}</span>
        {compact ? <Bar nodes={nodes} counts={counts} order={order} className="mx-1 min-w-12 flex-1" label={t("dag.progress", { done: completed, total: nodes.length })} /> : null}
        <span className={cn("flex shrink-0 items-center gap-1", !compact && "ml-auto")}>
          {state === "running" ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => void window.fastvibe.dag.cancel(conversationId).catch(failure)}
            >
              <HugeiconsIcon strokeWidth={2} icon={StopIcon} data-icon="inline-start" />
              {t("dag.cancelAll")}
            </Button>
          ) : null}
          {state === "stopped" ? (
            // Stopped, not lost: what finished stays finished, and this carries on from there.
            <Button type="button" size="xs" onClick={() => void window.fastvibe.dag.resume(conversationId).catch(failure)}>
              <HugeiconsIcon strokeWidth={2} icon={PlayIcon} data-icon="inline-start" />
              {t("dag.resume")}
            </Button>
          ) : null}
          {trailing}
        </span>
      </div>
      {compact ? null : <Bar nodes={nodes} counts={counts} order={order} className="w-full" label={t("dag.progress", { done: completed, total: nodes.length })} />}
      {compact ? null : (
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {order.map((status) => {
          const count = counts.get(status) ?? 0;
          if (count === 0) return null;
          return (
            <span key={status} className="inline-flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", STATUS_FILL[status])} aria-hidden />
              {t(`dag.status.${status}`)} {count}
            </span>
          );
        })}
      </div>
      )}
    </div>
  );
}

/** The progress bar, one segment per finished or running state. */
function Bar({
  nodes,
  counts,
  order,
  className,
  label,
}: {
  nodes: DagNode[];
  counts: Map<DagNodeStatus, number>;
  order: DagNodeStatus[];
  className?: string;
  label: string;
}): JSX.Element {
  return (
    <div className={cn("flex h-1.5 gap-px overflow-hidden rounded-full bg-muted", className)} role="img" aria-label={label}>
      {order.map((status) => {
        const count = counts.get(status) ?? 0;
        if (count === 0 || status === "pending") return null;
        return <span key={status} className={cn("h-full transition-[width] duration-300", STATUS_FILL[status])} style={{ width: `${(count / nodes.length) * 100}%` }} />;
      })}
    </div>
  );
}


function NodeCard({
  node,
  now,
  selected,
  related,
  style,
  onSelect,
}: {
  node: DagNode;
  now: number;
  selected: boolean;
  related: boolean;
  style: React.CSSProperties;
  onSelect: () => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const elapsed = node.startedAt ? (node.endedAt ?? now) - node.startedAt : undefined;
  const faded = node.status === "skipped" || node.status === "cancelled" || node.status === "pending";
  return (
    <button
      type="button"
      data-node={node.id}
      data-status={node.status}
      onClick={onSelect}
      title={`${node.id} ${node.title}`}
      className={cn(
        "group/node absolute flex overflow-hidden rounded-lg border bg-card text-left shadow-xs transition-[border-color,box-shadow,opacity]",
        "hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
        selected ? "border-primary/60 shadow-sm ring-2 ring-primary/20" : related ? "border-primary/30" : "border-border",
        faded && !selected && "opacity-70",
      )}
      style={style}
    >
      <span className={cn("w-1 shrink-0", STATUS_FILL[node.status], node.status === "running" && "animate-pulse")} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-2.5">
        <span className="flex items-center gap-1.5 text-xs">
          <DagStatusIcon status={node.status} label={t(`dag.status.${node.status}`)} />
          <span className="font-mono text-muted-foreground">{node.id}</span>
          {elapsed !== undefined && node.status !== "pending" ? (
            <span className="ml-auto text-muted-foreground tabular-nums">{formatDuration(elapsed)}</span>
          ) : null}
        </span>
        <span className={cn("truncate text-sm leading-4 font-medium", node.status === "skipped" || node.status === "cancelled" ? "text-muted-foreground line-through decoration-muted-foreground/50" : "")}>
          {node.title}
        </span>
        <span className="truncate text-xs leading-4 text-muted-foreground">{node.profile.name}</span>
      </span>
    </button>
  );
}
