import { useEffect, useMemo, useState, type JSX, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { layoutMemoryCards, type LayoutPoint } from "@/lib/memory-graph-layout";
import { cn } from "@/lib/utils";
import type { MemoryDetail, MemoryGraph, MemoryGraphNode, MemoryItem, MemoryRelationView } from "@shared/memory";

/**
 * 设置 → 长期记忆 → 关系图: every memory as a node, every relation as an edge, drawn
 * with React Flow; clicking a card opens it in full beside the graph. The canvas owns
 * pan, zoom and dragging while the pure layout module supplies stable starting points.
 * The layout uses every edge, whichever views are shown, so toggling a view never moves
 * a node.
 */

const VIEWS: MemoryRelationView[] = ["semantic", "temporal", "causal", "entity"];
const ROLES: Array<MemoryItem["role"]> = ["user", "assistant", "summary"];
const ALL_PROJECTS = "__all__";

type Point = MemoryGraphNode & LayoutPoint;

type MemoryNodeData = {
  memory: MemoryGraphNode;
  selectedId: string | null;
  neighbours: Set<string>;
  onSelect: (id: string) => void;
  roleLabel: string;
  fallbackLabel: string;
};
type MemoryFlowNode = Node<MemoryNodeData, "memory">;
type MemoryFlowEdge = Edge<{ view: MemoryRelationView; weight: number }>;

function roleColor(role: MemoryItem["role"]): string {
  if (role === "user") return "var(--info)";
  if (role === "assistant") return "var(--success)";
  if (role === "summary") return "var(--warning)";
  return "var(--muted-foreground)";
}

function viewColor(view: MemoryRelationView): string {
  return `var(--chart-${VIEWS.indexOf(view) + 1})`;
}

export function MemoryGraphDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): JSX.Element {
  const { t } = useTranslation("settings");
  const [project, setProject] = useState(ALL_PROJECTS);
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<MemoryRelationView>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = (): void => {
      void window.fastvibe.memory.graph(project === ALL_PROJECTS ? {} : { project })
        .then((value) => { if (alive) { setGraph(value); setError(null); } })
        .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)); });
    };
    load();
    // A capture or a clear while the view is open redraws it rather than leaving it stale.
    let timer: number | undefined;
    const off = window.fastvibe.memory.onChanged(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 400);
    });
    return () => { alive = false; window.clearTimeout(timer); off(); };
  }, [open, project]);

  const positions = useMemo(() => (graph ? layoutMemoryCards(graph.nodes.map((node) => node.id), graph.edges) : new Map<string, LayoutPoint>()), [graph]);
  const points = useMemo<Point[]>(() => (graph?.nodes ?? []).map((node) => ({ ...node, ...(positions.get(node.id) ?? { x: 0, y: 0 }) })), [graph, positions]);
  const edges = useMemo(() => (graph?.edges ?? []).filter((edge) => !hidden.has(edge.view)), [graph, hidden]);
  const flowNodes = useMemo<MemoryFlowNode[]>(() => points.map((memory) => ({
    id: memory.id,
    type: "memory",
    position: { x: memory.x, y: memory.y },
    data: {
      memory,
      selectedId: null,
      neighbours: new Set<string>(),
      onSelect: setSelectedId,
      roleLabel: t(`memory.role.${memory.role}`),
      fallbackLabel: t("memory.detailFallback"),
    },
  })), [points, t]);
  const flowEdges = useMemo<MemoryFlowEdge[]>(() => edges.map((edge, index) => {
    const touches = selectedId !== null && (edge.sourceId === selectedId || edge.targetId === selectedId);
    return {
      id: `memory-edge-${index}-${edge.sourceId}-${edge.targetId}`,
      source: edge.sourceId,
      target: edge.targetId,
      type: "default",
      data: { view: edge.view, weight: edge.weight },
      markerEnd: { type: MarkerType.ArrowClosed, color: viewColor(edge.view) },
      style: {
        stroke: viewColor(edge.view),
        strokeWidth: touches ? 1.5 + edge.weight : 1 + edge.weight,
        opacity: selectedId === null ? 0.58 : touches ? 1 : 0.1,
        strokeDasharray: edge.view === "temporal" ? "5 4" : edge.view === "entity" ? "2 3" : undefined,
      },
    };
  }), [edges, selectedId]);
  const counts = useMemo(() => {
    const byView: Record<MemoryRelationView, number> = { semantic: 0, temporal: 0, causal: 0, entity: 0 };
    for (const edge of graph?.edges ?? []) byView[edge.view] += 1;
    return byView;
  }, [graph]);

  const toggleView = (view: MemoryRelationView): void => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(view)) next.delete(view);
      else next.add(view);
      return next;
    });
  };

  const projectLabels: Record<string, string> = { [ALL_PROJECTS]: t("memory.graphAllProjects") };
  for (const path of graph?.projects ?? []) projectLabels[path] = projectName(path);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(90vh,54rem)] flex-col gap-3 sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{t("memory.graphTitle")}</DialogTitle>
          <DialogDescription>{t("memory.graphDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={project} items={projectLabels} onValueChange={(value) => { setProject(value ?? ALL_PROJECTS); setSelectedId(null); }}>
            <SelectTrigger className="w-56" aria-label={t("memory.graphProject")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>{projectLabels[ALL_PROJECTS]}</SelectItem>
              {(graph?.projects ?? []).map((path) => <SelectItem key={path} value={path} title={path}>{projectLabels[path]}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("memory.graphViews")}>
            {VIEWS.map((view) => (
              <button
                key={view}
                type="button"
                aria-pressed={!hidden.has(view)}
                onClick={() => toggleView(view)}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors hover:bg-muted",
                  hidden.has(view) ? "text-muted-foreground opacity-60" : "text-foreground",
                )}
              >
                <span className="h-0.5 w-3 rounded-full" style={{ background: `var(--chart-${VIEWS.indexOf(view) + 1})` }} />
                {t(`memory.view.${view}`)}
                <span className="tabular-nums text-muted-foreground">{counts[view]}</span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            {ROLES.map((role) => (
              <span key={role} className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full" style={{ background: roleColor(role) }} />
                {t(`memory.role.${role}`)}
              </span>
            ))}
            {graph ? <span className="tabular-nums">{t("memory.graphCount", { shown: graph.nodes.length, total: graph.total })}</span> : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          <div className="relative min-h-72 flex-1 overflow-hidden rounded-lg border bg-muted/20">
            {error ? (
              <div className="absolute inset-0 grid place-items-center p-4 text-sm text-destructive">{error}</div>
            ) : !graph ? (
              <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">{t("memory.loading")}</div>
            ) : graph.nodes.length === 0 ? (
              <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">{t("memory.graphEmpty")}</div>
            ) : (
              <ReactFlowProvider>
                <MemoryFlowCanvas
                  nodes={flowNodes}
                  edges={flowEdges}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              </ReactFlowProvider>
            )}
          </div>
          <div className="flex min-h-56 shrink-0 flex-col overflow-hidden rounded-lg border md:w-88">
            <MemoryDetailPanel id={selectedId} onSelect={setSelectedId} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const MEMORY_NODE_TYPES = { memory: MemoryFlowNode };

function MemoryFlowCanvas({
  nodes: initialNodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: MemoryFlowNode[];
  edges: MemoryFlowEdge[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}): JSX.Element {
  const [nodes, setNodes, onNodesChange] = useNodesState<MemoryFlowNode>(initialNodes);
  const { fitView } = useReactFlow();

  useEffect(() => {
    setNodes(initialNodes);
    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: 0.16, duration: 220 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialNodes, setNodes, fitView]);

  // The selected neighbourhood is derived from visible edges, so it changes when
  // a relation kind is toggled without rebuilding or moving the cards.
  useEffect(() => {
    const neighbours = new Set<string>();
    if (selectedId) {
      for (const edge of edges) {
        if (edge.source === selectedId) neighbours.add(edge.target);
        if (edge.target === selectedId) neighbours.add(edge.source);
      }
    }
    setNodes((current) => current.map((node) => ({
      ...node,
      selected: node.id === selectedId,
      data: { ...node.data, selectedId, neighbours },
    })));
  }, [edges, initialNodes, selectedId, setNodes]);

  return (
    <ReactFlow
      className="memory-flow"
      nodes={nodes}
      edges={edges}
      nodeTypes={MEMORY_NODE_TYPES}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      nodesConnectable={false}
      nodesDraggable
      elementsSelectable
      panOnScroll
      panOnDrag
      zoomOnScroll
      zoomOnDoubleClick={false}
      minZoom={0.2}
      maxZoom={2.5}
      onlyRenderVisibleElements
      fitView
      fitViewOptions={{ padding: 0.16 }}
    >
      <Background gap={24} size={1} color="var(--border)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

function MemoryFlowNode({ data, selected }: NodeProps<MemoryFlowNode>): JSX.Element {
  const { memory } = data;
  const dimmed = data.selectedId !== null && !selected && !data.neighbours.has(memory.id);
  const select = (): void => data.onSelect(memory.id);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${data.roleLabel}: ${memory.preview}`}
      aria-pressed={selected}
      onClick={select}
      onKeyDown={onKeyDown}
      className={cn(
        "relative h-28 w-56 cursor-pointer overflow-visible rounded-xl border border-border/80 bg-card p-3 text-card-foreground shadow-sm transition-all",
        "hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-foreground/50 shadow-md ring-2 ring-ring/30",
        dimmed && "opacity-30",
      )}
      style={{ borderLeftColor: roleColor(memory.role), borderLeftWidth: "3px" }}
    >
      <Handle type="target" position={Position.Left} className="!size-2 !border-2 !border-background !bg-muted-foreground" />
      <Handle type="source" position={Position.Right} className="!size-2 !border-2 !border-background !bg-muted-foreground" />
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-2 shrink-0 rounded-full" style={{ background: roleColor(memory.role) }} />
        <span className="truncate font-medium text-foreground">{data.roleLabel}</span>
        <span className="ml-auto shrink-0 tabular-nums">{new Date(memory.createdAt).toLocaleDateString()}</span>
      </div>
      <p className="mt-2 line-clamp-3 break-words text-sm leading-5">{memory.preview}</p>
      <div className="absolute inset-x-3 bottom-2 flex items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate">{memory.project ? projectName(memory.project) : ""}</span>
        {memory.fallback ? <span className="ml-auto rounded bg-muted px-1.5 py-0.5">{data.fallbackLabel}</span> : null}
      </div>
    </div>
  );
}

/** The folder name, which is what a project is known by in the sidebar too. */
function projectName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** One memory in full: what was said, how it was typed and extracted, and its relations. */
function MemoryDetailPanel({ id, onSelect }: { id: string | null; onSelect: (id: string) => void }): JSX.Element {
  const { t } = useTranslation("settings");
  const [detail, setDetail] = useState<MemoryDetail | null | undefined>(undefined);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    setDetail(undefined);
    void window.fastvibe.memory.detail(id).then((value) => { if (alive) setDetail(value); }).catch(() => { if (alive) setDetail(null); });
    return () => { alive = false; };
  }, [id]);

  if (!id) return <div className="grid flex-1 place-items-center p-4 text-center text-sm text-muted-foreground">{t("memory.detailEmpty")}</div>;
  if (detail === undefined) return <div className="grid flex-1 place-items-center p-4 text-sm text-muted-foreground">{t("memory.loading")}</div>;
  if (detail === null) return <div className="grid flex-1 place-items-center p-4 text-center text-sm text-muted-foreground">{t("memory.detailGone")}</div>;

  const { item, relations } = detail;
  const metadata = item.metadata ?? {};
  const narrative = typeof metadata.narrative === "string" ? metadata.narrative : undefined;
  const fallback = isRecord(metadata.jevMem) && metadata.jevMem.controller === "magma_fallback";
  const decisions = isRecord(metadata.jevMem) && Array.isArray(metadata.jevMem.consolidation) ? metadata.jevMem.consolidation.filter(isRecord) : [];
  const sources = Array.isArray(metadata.sourceMemoryIds) ? metadata.sourceMemoryIds.filter((value): value is string => typeof value === "string") : [];

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-4 p-3 text-sm">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="gap-1.5">
              <span className="size-2 rounded-full" style={{ background: roleColor(item.role) }} />
              {t(`memory.role.${item.role}`)}
            </Badge>
            {fallback ? <Badge variant="secondary">{t("memory.detailFallback")}</Badge> : null}
            <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
          </div>
          {item.project ? <div className="truncate text-xs text-muted-foreground" title={item.project}>{t("memory.detailProject")}: {item.project}</div> : null}
          {item.conversationId ? <div className="truncate font-mono text-xs text-muted-foreground" title={item.conversationId}>{t("memory.detailConversation")}: {item.conversationId}</div> : null}
        </div>

        <Section title={t("memory.detailContent")}>
          <p className="whitespace-pre-wrap break-words">{item.content}</p>
        </Section>

        {narrative ? (
          <Section title={t("memory.detailNarrative")}>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{narrative}</p>
          </Section>
        ) : null}

        {item.typeScores ? (
          <Section title={t("memory.detailTypeScores")}>
            <div className="space-y-1.5">
              {(["episodic", "semantic", "procedural", "preference"] as const).map((key) => (
                <div key={key} className="grid grid-cols-[5rem_1fr_2.5rem] items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{t(`memory.type.${key}`)}</span>
                  <Progress value={Math.round((item.typeScores?.[key] ?? 0) * 100)} />
                  <span className="text-right tabular-nums">{Math.round((item.typeScores?.[key] ?? 0) * 100)}%</span>
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {item.entities?.length || item.keywords?.length ? (
          <Section title={t("memory.detailEntitiesKeywords")}>
            <div className="flex flex-wrap gap-1">
              {(item.entities ?? []).map((entity) => <Badge key={`e-${entity}`} variant="secondary">{entity}</Badge>)}
              {(item.keywords ?? []).map((keyword) => <Badge key={`k-${keyword}`} variant="outline">{keyword}</Badge>)}
            </div>
          </Section>
        ) : null}

        {sources.length > 0 ? (
          <Section title={t("memory.detailSources")}>
            <div className="flex flex-wrap gap-1">
              {sources.map((source, index) => (
                <button key={source} type="button" className="rounded-md border px-1.5 py-0.5 text-xs hover:bg-muted" onClick={() => onSelect(source)}>
                  {t("memory.detailSource", { index: index + 1 })}
                </button>
              ))}
            </div>
          </Section>
        ) : null}

        {decisions.length > 0 ? (
          <Section title={t("memory.detailConsolidation")}>
            <ul className="space-y-1 text-xs">
              {decisions.map((decision, index) => {
                const choice = isRecord(decision.representation) && typeof decision.representation.choice === "string" ? decision.representation.choice : "";
                const candidate = typeof decision.candidateId === "string" ? decision.candidateId : undefined;
                return (
                  <li key={candidate ?? index}>
                    <button type="button" disabled={!candidate} className="w-full rounded-md px-1.5 py-1 text-left hover:bg-muted" onClick={() => candidate && onSelect(candidate)}>
                      <span className="font-medium">{t(`memory.representation.${choice}`, { defaultValue: choice })}</span>
                      <span className="ml-1.5 text-muted-foreground tabular-nums">
                        {t("memory.detailDecisionScores", {
                          redundant: percent(decision.redundant),
                          contradiction: percent(decision.contradiction),
                          obsolete: percent(decision.obsolete),
                          link: percent(decision.link),
                        })}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        ) : null}

        <Section title={t("memory.detailRelations", { count: relations.length })}>
          {relations.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("memory.detailNoRelations")}</p>
          ) : (
            <ul className="space-y-1">
              {relations.map(({ edge, direction, neighbor }) => (
                <li key={`${edge.sourceId}-${edge.targetId}-${edge.view}-${edge.relation}-${edge.origin}`}>
                  <button type="button" className="w-full rounded-md px-1.5 py-1 text-left hover:bg-muted" onClick={() => onSelect(neighbor.id)}>
                    <div className="flex items-center gap-1.5 text-xs">
                      <HugeiconsIcon icon={direction === "out" ? ArrowRight01Icon : ArrowLeft01Icon} strokeWidth={2} className="size-3.5 text-muted-foreground" />
                      <span className="h-0.5 w-3 rounded-full" style={{ background: `var(--chart-${VIEWS.indexOf(edge.view) + 1})` }} />
                      <span className="font-medium">{t(`memory.relation.${edge.relation}`, { defaultValue: edge.relation })}</span>
                      <span className="text-muted-foreground">· {t(`memory.origin.${edge.origin}`)}</span>
                      <span className="ml-auto tabular-nums text-muted-foreground">{edge.weight.toFixed(2)}</span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 break-words pl-5 text-xs text-muted-foreground">
                      {t(`memory.role.${neighbor.role}`)}: {neighbor.preview}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </ScrollArea>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function percent(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
