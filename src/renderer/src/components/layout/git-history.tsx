import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, CloudIcon, Copy01Icon, GitBranchIcon, GitCommitIcon, RefreshIcon, Tag01Icon, Target01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { layoutGitGraph, type GitGraphRow } from "@/lib/git-graph";
import type { GitHistoryEntry, GitHistoryScope, GitReference } from "@shared/ipc";

const COLORS = ["var(--info)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--primary)"];
const ROW_HEIGHT = 28;

function GraphCell({ row, columns }: { row: GitGraphRow; columns: number }): JSX.Element {
  const step = columns > 6 ? 14 : 18;
  const x = (column: number): number => 11 + column * step;
  const width = 22 + (columns - 1) * step;
  const radius = row.commit.isHead ? 6 : 4;
  // The lanes end at the commit's centre, so the ring used to hide them by filling
  // itself with `--background`. That colour is translucent under 玻璃效果, which left
  // the line showing through the ring. Masking the lanes away around the commit needs
  // no opaque background and so holds in every theme; the clearance is a hair over the
  // ring's own outline, whose stroke stays 2px at any 界面字号 while the radius scales.
  const mask = useId();
  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden
      // Button sizes descendant SVGs as icons unless they have a size-* class.
      // Match h-7 in rem so adjacent cells also meet when the UI font size changes.
      className="size-auto block shrink-0 overflow-visible"
      style={{ width: `${width / 16}rem`, height: `${ROW_HEIGHT / 16}rem` }}
    >
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={ROW_HEIGHT}>
          <rect x="0" y="0" width={width} height={ROW_HEIGHT} fill="#fff" />
          <circle cx={x(row.column)} cy="14" r={row.commit.isHead ? radius + 1.2 : 0} fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
      {row.edges.map((edge, i) => {
        const from = x(edge.from);
        const to = x(edge.to);
        const path = edge.kind === "in" ? `M${from} 0V14`
          : edge.kind === "through" ? `M${from} 0C${from} 14 ${to} 14 ${to} 28`
          : `M${from} 14C${from} 23 ${to} 20 ${to} 28`;
        return <path key={i} d={path} stroke={COLORS[edge.color % COLORS.length]} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" fill="none" />;
      })}
      </g>
      <circle cx={x(row.column)} cy="14" r={radius} fill={row.commit.isHead ? "none" : COLORS[row.color % COLORS.length]} stroke={COLORS[row.color % COLORS.length]} strokeWidth={row.commit.isHead ? 2.25 : 1.5} vectorEffect="non-scaling-stroke" />
      {row.commit.parents.length > 1 ? <circle cx={x(row.column)} cy="14" r="1.6" fill={row.commit.isHead ? COLORS[row.color % COLORS.length] : "var(--background)"} /> : null}
    </svg>
  );
}

export function GitRefBadges({ refs, head = false, limit = 2, compact = true }: { refs: GitReference[]; head?: boolean; limit?: number; compact?: boolean }): JSX.Element {
  const sorted = [...refs].sort((a, b) => Number(!!b.current) - Number(!!a.current) || ({ local: 0, remote: 1, tag: 2 }[a.kind] - { local: 0, remote: 1, tag: 2 }[b.kind]));
  return <span className="flex min-w-0 shrink-0 items-center gap-1">
    {head && !refs.some((ref) => ref.current) ? <span className="rounded bg-primary/15 px-1 text-xs font-medium text-primary">HEAD</span> : null}
    {sorted.slice(0, limit).map((ref) => <span key={`${ref.kind}:${ref.name}`} title={ref.current ? `HEAD → ${ref.name}` : ref.name} className={cn("inline-flex max-w-28 items-center gap-0.5 rounded px-1 py-0.5 text-xs leading-none", ref.current ? "bg-info text-white" : ref.kind === "remote" ? "bg-chart-2/15 text-chart-2" : ref.kind === "tag" ? "bg-warning/15 text-warning" : "bg-info/10 text-info")}>
      <HugeiconsIcon icon={ref.current ? Target01Icon : ref.kind === "remote" ? CloudIcon : ref.kind === "tag" ? Tag01Icon : GitBranchIcon} className="size-[1em] shrink-0" strokeWidth={2} />
      <span className={compact && ref.kind === "remote" && refs.some((local) => local.kind === "local" && ref.name.endsWith(`/${local.name}`)) ? "sr-only" : "truncate"}>{ref.name}</span>
    </span>)}
    {sorted.length > limit ? <span className="text-xs text-muted-foreground" title={sorted.slice(limit).map((ref) => ref.name).join("\n")}>+{sorted.length - limit}</span> : null}
  </span>;
}

export function GitHistoryPanel({ cwd, epoch, selected, open, onOpenChange, onSelect, scope, onScopeChange }: {
  cwd: string; epoch: number; selected?: string; scope: GitHistoryScope; onScopeChange: (scope: GitHistoryScope) => void; open: boolean; onOpenChange: (open: boolean) => void; onSelect: (commit: GitHistoryEntry) => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [commits, setCommits] = useState<GitHistoryEntry[]>([]);
  const [branch, setBranch] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [locateHead, setLocateHead] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const loadingRef = useRef(false);
  const tips = useRef<string[] | undefined>(undefined);
  const graph = useMemo(() => layoutGitGraph(commits), [commits]);

  async function load(skip: number, version: number): Promise<void> {
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await window.fastvibe.workspace.gitHistory(cwd, skip, scope, skip ? tips.current : undefined);
      if (version !== generation.current) return;
      tips.current = page.tips;
      setBranch(page.branch);
      setCommits((old) => skip ? [...old, ...page.commits.filter((entry) => !old.some((item) => item.hash === entry.hash))] : page.commits);
      setMore(page.hasMore);
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : t("git.historyFailed"));
    } finally {
      if (version === generation.current) { setLoading(false); loadingRef.current = false; }
    }
  }
  useEffect(() => {
    if (!open) return;
    const version = ++generation.current;
    setCommits([]);
    setMore(false);
    tips.current = undefined;
    void load(0, version);
    return () => { generation.current++; };
  }, [cwd, epoch, scope, refresh, open]);
  useEffect(() => {
    if (!locateHead || loading) return;
    const head = root.current?.querySelector<HTMLButtonElement>('[data-head="true"]');
    head?.scrollIntoView({ block: "nearest" });
    head?.focus({ preventScroll: true });
    setLocateHead(false);
  }, [locateHead, loading, commits]);

  return <div ref={root} className="@container/history flex min-h-0 flex-1 flex-col">
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border/40 bg-muted px-1.5">
      <Button size="xs" variant="ghost" className="h-7 min-w-0 flex-1 justify-start gap-1 rounded-none bg-transparent px-0.5 text-xs font-medium hover:bg-transparent aria-expanded:bg-transparent dark:hover:bg-transparent" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} className="size-3" />{t("git.history")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="xs" variant="ghost" className="h-6 max-w-28 gap-1 px-1 text-[11px] font-normal" aria-label={t("git.historyScope")} />}>
          <HugeiconsIcon icon={GitBranchIcon} className="size-3" /><span className="truncate">{scope === "all" ? t("git.allBranches") : branch ?? t("git.currentBranch")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {(["all", "current"] as const).map((value) => <DropdownMenuItem key={value} onClick={() => { onScopeChange(value); onOpenChange(true); }}>
            <HugeiconsIcon icon={value === scope ? Tick02Icon : GitBranchIcon} />{t(value === "all" ? "git.allBranches" : "git.currentBranch")}
          </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton size="icon-xs" variant="ghost" className="size-6" label={t("git.locateHead")} onClick={() => { onScopeChange("current"); setLocateHead(true); onOpenChange(true); }}><HugeiconsIcon icon={Target01Icon} size={14} /></IconButton>
      <IconButton size="icon-xs" variant="ghost" className="size-6" label={t("git.refreshHistory")} disabled={loading && open} onClick={() => { setRefresh((n) => n + 1); onOpenChange(true); }}><HugeiconsIcon icon={RefreshIcon} size={14} className={cn(loading && open && "animate-spin")} /></IconButton>
    </div>
    {open ? <ScrollArea className="min-h-0 flex-1">
      <div className="min-w-0 pb-1">
        {graph.rows.map((row) => {
          const commit = row.commit;
          return <Button key={commit.hash} variant="ghost" data-head={commit.isHead} aria-label={`${commit.subject} · ${commit.hash.slice(0, 7)}`} aria-pressed={selected === commit.hash} title={`${commit.subject}\n${commit.author} · ${new Date(commit.date).toLocaleString()}\n${commit.hash}${commit.refs.length ? `\n${commit.refs.map((ref) => ref.name).join(", ")}` : ""}`} className={cn("flex h-7 w-full justify-start gap-1 rounded-none border-y-0 border-r-0 border-l-2 border-l-transparent py-0 pr-2 pl-1 text-xs font-normal hover:bg-foreground/5 active:translate-y-0", selected === commit.hash && "border-l-primary bg-primary/10")} onClick={() => onSelect(commit)}>
            <GraphCell row={row} columns={graph.columns} />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"><span className={cn("truncate", commit.isHead && "font-medium")}>{commit.subject}</span><span className={cn("max-w-16 shrink-0 truncate text-[11px] text-muted-foreground/70", commit.refs.length > 0 && "hidden @min-[26rem]/history:inline")}>{commit.author}</span></span>
            <GitRefBadges refs={commit.refs} head={commit.isHead} />
          </Button>;
        })}
        {!commits.length && !loading && !error ? <p className="p-3 text-xs text-muted-foreground">{t("git.historyEmpty")}</p> : null}
        {error ? <div role="alert" className="p-2 text-xs text-destructive">{error}<Button size="xs" variant="ghost" onClick={() => void load(commits.length, generation.current)}>{t("git.refresh")}</Button></div> : null}
        {loading ? <div className="flex justify-center p-3"><Spinner /></div> : more ? <Button size="xs" variant="ghost" className="w-full rounded-none" onClick={() => { if (!loadingRef.current) void load(commits.length, generation.current); }}>{t("git.historyMore")}</Button> : null}
      </div>
    </ScrollArea> : null}
  </div>;
}

export function GitCommitDetails({ commit, count }: { commit: GitHistoryEntry; count?: number }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [expanded, setExpanded] = useState(false);
  const body = commit.body.startsWith(commit.subject) ? commit.body.slice(commit.subject.length).trim() : commit.body;
  return <div className="shrink-0 space-y-2 border-b border-border bg-muted/20 px-3 py-2.5">
    <div className="flex flex-wrap items-center gap-2"><HugeiconsIcon icon={GitCommitIcon} className="size-4 shrink-0 text-muted-foreground" /><p className="min-w-0 flex-1 text-sm font-medium">{commit.subject}</p><GitRefBadges refs={commit.refs} head={commit.isHead} limit={6} compact={false} /></div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>{commit.author}</span><time dateTime={commit.date}>{new Date(commit.date).toLocaleString()}</time>
      <Button size="xs" variant="ghost" className="h-5 gap-1 px-0 font-mono text-[11px]" title={commit.hash} onClick={() => void navigator.clipboard.writeText(commit.hash).then(() => toast.success(t("git.hashCopied"))).catch(() => toast.error(t("resources.copyFailed")))}>{commit.hash.slice(0, 8)}<HugeiconsIcon icon={Copy01Icon} className="size-3" /></Button>
      {count !== undefined ? <span>{t("git.changedCount", { count })}</span> : null}
      {commit.parents.length > 1 ? <span title={commit.parents.join("\n")}>{t("git.mergeComparison")}</span> : null}
    </div>
    {body ? <div><Button size="xs" variant="ghost" className="h-5 px-0 text-[11px]" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><HugeiconsIcon icon={expanded ? ArrowDown01Icon : ArrowRight01Icon} className="size-3" />{t("git.commitBody")}</Button>{expanded ? <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{body}</p> : null}</div> : null}
  </div>;
}
