import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import Graph from "graphology";
import Sigma from "sigma";
import type { EdgeProgramType } from "sigma/rendering";
import { HugeiconsIcon } from "@hugeicons/react";
import { FitToScreenIcon, ZoomInAreaIcon, ZoomOutAreaIcon } from "@hugeicons/core-free-icons";
import { EntityEdgeProgram, TemporalEdgeProgram } from "@/components/settings/memory-graph-edges";
import type { LayoutPoint } from "@/lib/memory-graph-layout";
import type { MemoryGraphEdge, MemoryGraphNode, MemoryItem, MemoryRelationView } from "@shared/memory";

/**
 * 设置 → 长期记忆 → 关系图, drawn as points.
 *
 * Every memory is a disc coloured by who wrote it. Relation kinds keep their
 * chart colour; temporal and entity edges are dashed, the others solid, and
 * every edge ends in an arrow. Labels stay hidden until the camera is close
 * enough that a disc renders larger than the threshold — Sigma scales screen
 * sizes by the inverse square root of the camera ratio — while the hovered and
 * selected nodes always name themselves. The detail panel still carries the
 * full text.
 */

const NODE_SIZE = 5;
const SELECTED_SIZE = 9;
/** At the fitted camera (ratio 1) a size-5 disc stays under Sigma's label threshold. */
const LABEL_THRESHOLD = 6;

type Palette = {
  user: string;
  assistant: string;
  summary: string;
  muted: string;
  label: string;
  card: string;
  border: string;
  semantic: string;
  temporal: string;
  causal: string;
  entity: string;
};

type NodeAttributes = { x: number; y: number; size: number; color: string; label: string };
type EdgeAttributes = { size: number; color: string; type: string };
type MemoryGraphology = Graph<NodeAttributes, EdgeAttributes>;

type View = {
  selectedId: string | null;
  neighbors: Set<string>;
  palette: Palette;
};

function tokenColor(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const channels = resolved.match(/[\d.]+/g);
  if (!channels || channels.length < 3) return "#888888";
  const hex = (channel: string): string => Math.max(0, Math.min(255, Math.round(Number(channel)))).toString(16).padStart(2, "0");
  return `#${hex(channels[0])}${hex(channels[1])}${hex(channels[2])}`;
}

function readPalette(): Palette {
  return {
    user: tokenColor("--info"),
    assistant: tokenColor("--success"),
    summary: tokenColor("--warning"),
    muted: tokenColor("--muted-foreground"),
    label: tokenColor("--foreground"),
    card: tokenColor("--card"),
    border: tokenColor("--border"),
    semantic: tokenColor("--chart-1"),
    temporal: tokenColor("--chart-2"),
    causal: tokenColor("--chart-3"),
    entity: tokenColor("--chart-4"),
  };
}

function samePalette(left: Palette, right: Palette): boolean {
  return (Object.keys(left) as Array<keyof Palette>).every((key) => left[key] === right[key]);
}

function useGraphPalette(): Palette {
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    let frame = 0;
    const update = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setPalette((current) => {
          const next = readPalette();
          return samePalette(current, next) ? current : next;
        });
      });
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return palette;
}

function fade(hex: string, alpha: number): string {
  const channel = Math.max(0, Math.min(255, Math.round(alpha * 255))).toString(16).padStart(2, "0");
  return `${hex.slice(0, 7)}${channel}`;
}

function roleColor(palette: Palette, role: MemoryItem["role"]): string {
  if (role === "user") return palette.user;
  if (role === "assistant") return palette.assistant;
  if (role === "summary") return palette.summary;
  return palette.muted;
}

function viewColor(palette: Palette, view: MemoryRelationView): string {
  if (view === "semantic") return palette.semantic;
  if (view === "temporal") return palette.temporal;
  if (view === "causal") return palette.causal;
  return palette.entity;
}

function edgeType(view: MemoryRelationView): string {
  if (view === "temporal") return "temporal";
  if (view === "entity") return "entity";
  return "arrow";
}

function shortLabel(preview: string): string {
  const flat = preview.replace(/\s+/g, " ").trim();
  if (flat.length <= 42) return flat;
  return `${flat.slice(0, 41)}…`;
}

export function MemorySigma({
  nodes,
  edges,
  positions,
  selectedId,
  onSelect,
}: {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, LayoutPoint>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const palette = useGraphPalette();
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma<NodeAttributes, EdgeAttributes> | null>(null);
  const graphRef = useRef<MemoryGraphology | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const neighbors = useMemo(() => {
    const next = new Set<string>();
    if (!selectedId) return next;
    for (const edge of edges) {
      if (edge.sourceId === selectedId) next.add(edge.targetId);
      if (edge.targetId === selectedId) next.add(edge.sourceId);
    }
    return next;
  }, [edges, selectedId]);
  const viewRef = useRef<View>({ selectedId, neighbors, palette });
  viewRef.current = { selectedId, neighbors, palette };
  const placed = useRef<Map<string, LayoutPoint> | null>(null);
  const pendingFit = useRef(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const graph: MemoryGraphology = new Graph({ type: "directed", multi: true });
    const renderer = new Sigma<NodeAttributes, EdgeAttributes>(graph, container, {
      allowInvalidContainer: true,
      defaultNodeType: "circle",
      defaultEdgeType: "arrow",
      labelFont: "Geist Variable, sans-serif",
      labelSize: 12,
      labelWeight: "500",
      labelColor: { color: viewRef.current.palette.label },
      labelDensity: 0.4,
      labelGridCellSize: 80,
      labelRenderedSizeThreshold: LABEL_THRESHOLD,
      minCameraRatio: 0.05,
      maxCameraRatio: 1.6,
      minEdgeThickness: 0.6,
      stagePadding: 28,
      zIndex: true,
      enableCameraRotation: false,
      edgeProgramClasses: {
        temporal: TemporalEdgeProgram as unknown as EdgeProgramType<NodeAttributes, EdgeAttributes>,
        entity: EntityEdgeProgram as unknown as EdgeProgramType<NodeAttributes, EdgeAttributes>,
      },
      nodeReducer: (node, data) => {
        const view = viewRef.current;
        if (!view.selectedId) return data;
        const chosen = node === view.selectedId;
        if (chosen || view.neighbors.has(node)) {
          return { ...data, size: chosen ? SELECTED_SIZE : data.size, forceLabel: chosen, zIndex: 1 };
        }
        return { ...data, color: fade(data.color, 0.28), zIndex: 0, forceLabel: false };
      },
      edgeReducer: (edge, data) => {
        const view = viewRef.current;
        const current = graphRef.current;
        if (!view.selectedId || !current?.hasEdge(edge)) return data;
        const [source, target] = current.extremities(edge);
        if (source === view.selectedId || target === view.selectedId) {
          return { ...data, color: data.color.slice(0, 7), size: Math.max(data.size, 1.6), zIndex: 1 };
        }
        return { ...data, hidden: true };
      },
      defaultDrawNodeHover: (context, data, settings) => {
        const label = data.label;
        if (!label) return;
        const { card, border, label: ink } = viewRef.current.palette;
        const size = settings.labelSize;
        context.font = `${settings.labelWeight} ${size}px ${settings.labelFont}`;
        const width = Math.ceil(context.measureText(label).width) + 12;
        const height = size + 8;
        const x = data.x + data.size + 8;
        const y = data.y - height / 2;
        context.beginPath();
        context.roundRect(x, y, width, height, 6);
        context.fillStyle = card;
        context.strokeStyle = border;
        context.lineWidth = 1;
        context.fill();
        context.stroke();
        context.fillStyle = ink;
        context.textBaseline = "middle";
        context.fillText(label, x + 6, data.y);
      },
    });
    graphRef.current = graph;
    sigmaRef.current = renderer;

    renderer.on("enterNode", () => { container.classList.add("is-point"); });
    renderer.on("leaveNode", () => { container.classList.remove("is-point"); });
    renderer.on("clickNode", ({ node }) => onSelectRef.current(node));
    renderer.on("clickStage", () => onSelectRef.current(null));

    let dragged: string | null = null;
    renderer.on("downNode", ({ node }) => {
      dragged = node;
      renderer.getCamera().disable();
    });
    renderer.getMouseCaptor().on("mousemovebody", (event) => {
      if (!dragged) return;
      const point = renderer.viewportToGraph(event);
      graph.setNodeAttribute(dragged, "x", point.x);
      graph.setNodeAttribute(dragged, "y", point.y);
      event.preventSigmaDefault();
    });
    renderer.getMouseCaptor().on("mouseup", () => {
      if (!dragged) return;
      dragged = null;
      renderer.getCamera().enable();
    });

    const observer = new ResizeObserver(() => {
      renderer.resize();
      renderer.scheduleRefresh();
      if (!pendingFit.current) return;
      const { width, height } = renderer.getDimensions();
      if (width <= 2 || height <= 2) return;
      pendingFit.current = false;
      void renderer.getCamera().animatedReset({ duration: 200 });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      renderer.kill();
      graphRef.current = null;
      sigmaRef.current = null;
      // StrictMode runs the effect twice. The placement guard has to forget the
      // graph that was just destroyed, or the second pass treats it as already
      // placed and leaves the new canvas empty.
      placed.current = null;
      pendingFit.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const graph = graphRef.current;
    const renderer = sigmaRef.current;
    if (!graph || !renderer) return;
    const refit = placed.current !== positions;
    const seen = new Set<string>();
    for (const node of nodes) {
      const point = positions.get(node.id);
      if (!point) continue;
      seen.add(node.id);
      const attributes: NodeAttributes = {
        x: point.x,
        y: point.y,
        size: NODE_SIZE,
        color: roleColor(palette, node.role),
        label: shortLabel(node.preview),
      };
      if (!graph.hasNode(node.id)) graph.addNode(node.id, attributes);
      else if (refit) graph.mergeNodeAttributes(node.id, attributes);
      else graph.mergeNodeAttributes(node.id, { size: attributes.size, color: attributes.color, label: attributes.label });
    }
    const stale: string[] = [];
    graph.forEachNode((id) => {
      if (!seen.has(id)) stale.push(id);
    });
    for (const id of stale) graph.dropNode(id);
    graph.clearEdges();
    for (const edge of edges) {
      if (edge.sourceId === edge.targetId) continue;
      if (!graph.hasNode(edge.sourceId) || !graph.hasNode(edge.targetId)) continue;
      graph.addEdge(edge.sourceId, edge.targetId, {
        size: 0.55 + edge.weight * 0.65,
        color: fade(viewColor(palette, edge.view), 0.38),
        type: edgeType(edge.view),
      });
    }
    renderer.setSetting("labelColor", { color: palette.label });
    if (!refit) return;
    placed.current = positions;
    const { width, height } = renderer.getDimensions();
    if (width > 2 && height > 2) void renderer.getCamera().animatedReset({ duration: 200 });
    else pendingFit.current = true;
  }, [nodes, edges, positions, palette]);

  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [selectedId, neighbors, palette]);

  const zoom = (direction: "in" | "out" | "fit"): void => {
    const camera = sigmaRef.current?.getCamera();
    if (!camera) return;
    if (direction === "in") void camera.animatedZoom({ duration: 200 });
    else if (direction === "out") void camera.animatedUnzoom({ duration: 200 });
    else void camera.animatedReset({ duration: 200 });
  };

  return (
    <>
      <div ref={containerRef} className="memory-sigma absolute inset-0" role="application" aria-label={t("memory.graphTitle")} />
      <div className="absolute bottom-3 left-3 z-10 flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm">
        <button type="button" className="grid size-8 place-items-center border-b text-foreground hover:bg-muted" aria-label={t("memory.graphZoomIn")} onClick={() => zoom("in")}>
          <HugeiconsIcon icon={ZoomInAreaIcon} strokeWidth={2} className="size-4" />
        </button>
        <button type="button" className="grid size-8 place-items-center border-b text-foreground hover:bg-muted" aria-label={t("memory.graphZoomOut")} onClick={() => zoom("out")}>
          <HugeiconsIcon icon={ZoomOutAreaIcon} strokeWidth={2} className="size-4" />
        </button>
        <button type="button" className="grid size-8 place-items-center text-foreground hover:bg-muted" aria-label={t("memory.graphFit")} onClick={() => zoom("fit")}>
          <HugeiconsIcon icon={FitToScreenIcon} strokeWidth={2} className="size-4" />
        </button>
      </div>
    </>
  );
}
