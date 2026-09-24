import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { MemorySigma } from "@/components/settings/memory-sigma";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useMemoryLayout, type MemoryLayoutInput } from "@/lib/use-memory-layout";
import { cn } from "@/lib/utils";
import type { MemoryDetail, MemoryGraph, MemoryItem, MemoryRelationView } from "@shared/memory";

/**
 * 设置 → 长期记忆 → 关系图: every memory as a point, every relation as an edge, drawn
 * with Sigma. Clicking a point opens it in full beside the graph. The canvas owns pan,
 * zoom and dragging; a worker runs the force layout and hands back stable coordinates.
 * That layout sees every edge, whichever views are shown, so toggling a view never
 * moves a point.
 */

const VIEWS: MemoryRelationView[] = ["semantic", "temporal", "causal", "entity"];
const ROLES: Array<MemoryItem["role"]> = ["user", "assistant", "summary"];
const ALL_PROJECTS = "__all__";

function roleColor(role: MemoryItem["role"]): string {
  if (role === "user") return "var(--info)";
  if (role === "assistant") return "var(--success)";
  if (role === "summary") return "var(--warning)";
  return "var(--muted-foreground)";
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

  const layoutInput = useMemo<MemoryLayoutInput | null>(() => (graph ? {
    nodeIds: graph.nodes.map((node) => node.id),
    edges: graph.edges.map((edge) => ({ sourceId: edge.sourceId, targetId: edge.targetId })),
  } : null), [graph]);
  const positions = useMemoryLayout(layoutInput);
  const edges = useMemo(() => (graph?.edges ?? []).filter((edge) => !hidden.has(edge.view)), [graph, hidden]);
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
            ) : !positions ? (
              <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">{t("memory.graphLayout")}</div>
            ) : (
              <MemorySigma
                nodes={graph.nodes}
                edges={edges}
                positions={positions}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
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
