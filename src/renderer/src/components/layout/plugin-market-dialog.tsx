import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Delete02Icon,
  Download01Icon,
  File01Icon,
  Loading03Icon,
  PackageIcon,
  PaintBrushIcon,
  PuzzleIcon,
  RefreshIcon,
  Search01Icon,
  SparklesIcon,
  Store01Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IconButton } from "@/components/icon-button";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type {
  ExtensionPackage,
  MarketPackage,
  MarketPackagePage,
  MarketPackageQuery,
} from "@shared/types";

const TYPE_LABELS: Record<string, string> = {
  extension: "扩展",
  skill: "技能",
  theme: "主题",
  prompt: "提示词",
  package: "插件",
};

const TYPE_FILTERS: Record<string, string> = {
  "": "全部类型",
  extension: "扩展",
  skill: "技能",
  theme: "主题",
  prompt: "提示词",
};

const SORT_FILTERS: Record<string, string> = {
  downloads: "下载最多",
  recent: "最近发布",
  name: "按名称",
};

/** `npm:@scope/name@1.0` → `@scope/name`; `npm:name` → `name`. */
function packageName(source: string): string {
  const withoutScheme = source.replace(/^(npm|git):/, "");
  const withoutVersion = withoutScheme.replace(/@[\d^~>=][^/]*$/, "");
  return withoutVersion.split("/").slice(-2).join("/");
}

function formatDownloads(value?: number): string | null {
  if (!value || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M/mo`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K/mo`;
  return `${value}/mo`;
}

/**
 * The plugin market: pi packages published to npm, read from pi.dev's catalog.
 * Installed packages live in FastVibe's isolated agentDir; bundled ones cannot be
 * removed because they are owned by `package.json`, not by the user.
 */
export function PluginMarketDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element | null {
  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [packages, setPackages] = useState<ExtensionPackage[]>([]);
  const [installedBusy, setInstalledBusy] = useState(false);
  const [page, setPage] = useState<MarketPackagePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<NonNullable<MarketPackageQuery["sort"]>>("downloads");
  const [pageIndex, setPageIndex] = useState(1);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const installedNames = useMemo(
    () => new Set(packages.map((item) => packageName(item.source))),
    [packages],
  );

  const refreshInstalled = useCallback(async (): Promise<void> => {
    setInstalledBusy(true);
    try {
      setPackages(await window.fastvibe.engine.listExtensionPackages());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取已安装插件");
    } finally {
      setInstalledBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshInstalled();
  }, [open, refreshInstalled]);

  // Debounce the search box so typing does not fire a catalog request per key.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setPageIndex(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open || tab !== "market") return;
    let cancelled = false;
    setLoading(true);
    void window.fastvibe.engine
      .listMarketPackages({ query: search, type, sort, page: pageIndex })
      .then((result) => {
        if (cancelled) return;
        setPage(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "无法加载插件市场");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, search, type, sort, pageIndex]);

  async function install(item: MarketPackage): Promise<void> {
    if (pending || installedNames.has(item.name)) return;
    setPending(item.name);
    try {
      setPackages(await window.fastvibe.engine.installExtensionPackage(`npm:${item.name}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "安装失败，请检查网络后重试");
    } finally {
      setPending(null);
    }
  }

  async function remove(item: ExtensionPackage): Promise<void> {
    if (pending || item.builtin) return;
    setPending(item.source);
    try {
      setPackages(await window.fastvibe.engine.removeExtensionPackage(item.source));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "卸载失败，请重试");
    } finally {
      setPending(null);
    }
  }

  if (!open) return null;

  const total = page?.total;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] max-h-[640px] flex-col gap-3 overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon strokeWidth={2} icon={Store01Icon} className="size-4" />
            插件市场
          </DialogTitle>
          <DialogDescription>
            来自 pi.dev 的插件目录，安装到 FastVibe 独立的数据目录，不写入你自己的 <code>~/.pi</code>。
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "installed" | "market")}
          className="min-h-0 flex-1"
        >
          <div className="flex items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="installed" className="px-3">
                已安装{packages.length ? ` ${packages.length}` : ""}
              </TabsTrigger>
              <TabsTrigger value="market" className="px-3">
                官方市场
              </TabsTrigger>
            </TabsList>
            {tab === "installed" ? (
              <IconButton
                label="刷新"
                size="icon-sm"
                variant="outline"
                disabled={installedBusy}
                onClick={() => void refreshInstalled()}
              >
                <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} className="size-3.5" />
              </IconButton>
            ) : null}
          </div>

          <TabsContent value="installed" className="flex min-h-0 flex-col">
            <InstalledList
              packages={packages}
              pending={pending}
              busy={installedBusy}
              onRemove={(item) => void remove(item)}
            />
          </TabsContent>

          <TabsContent value="market" className="flex min-h-0 flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <HugeiconsIcon
                  strokeWidth={2}
                  icon={Search01Icon}
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={query}
                  placeholder="搜索插件名称或作者"
                  className="pl-8"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Select
                items={TYPE_FILTERS}
                value={type}
                onValueChange={(value) => {
                  setType(value as string);
                  setPageIndex(1);
                }}
              >
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_FILTERS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                items={SORT_FILTERS}
                value={sort}
                onValueChange={(value) => {
                  setSort(value as NonNullable<MarketPackageQuery["sort"]>);
                  setPageIndex(1);
                }}
              >
                <SelectTrigger size="sm" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SORT_FILTERS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <MarketList
              page={page}
              loading={loading}
              pending={pending}
              installed={installedNames}
              onInstall={(item) => void install(item)}
            />

            <div className="flex items-center justify-between text-[12px] text-muted-foreground">
              <span>
                {total ? `共 ${total.toLocaleString()} 个插件` : page ? `${page.packages.length} 个结果` : ""}
              </span>
              <div className="flex items-center gap-1">
                <IconButton
                  label="上一页"
                  size="icon-xs"
                  variant="ghost"
                  disabled={loading || pageIndex <= 1}
                  onClick={() => setPageIndex((value) => Math.max(1, value - 1))}
                >
                  <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} className="size-3.5" />
                </IconButton>
                <span>{pageIndex}</span>
                <IconButton
                  label="下一页"
                  size="icon-xs"
                  variant="ghost"
                  disabled={loading || !page?.totalPages || pageIndex >= page.totalPages}
                  onClick={() => setPageIndex((value) => value + 1)}
                >
                  <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} className="size-3.5" />
                </IconButton>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </DialogContent>
    </Dialog>
  );
}

const TYPE_ICONS: Record<string, typeof PackageIcon> = {
  extension: PuzzleIcon,
  skill: SparklesIcon,
  theme: PaintBrushIcon,
  prompt: File01Icon,
  package: PackageIcon,
};

const TYPE_TONES: Record<string, string> = {
  extension: "bg-info/10 text-info",
  skill: "bg-warning/10 text-warning",
  theme: "bg-success/10 text-success",
  prompt: "bg-primary/10 text-primary",
  package: "bg-muted text-muted-foreground",
};

/** Type-tinted avatar so a card's kind reads before its text does. */
function PackageAvatar({ types }: { types: string[] }): JSX.Element {
  const primary = types[0] ?? "package";
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg",
        TYPE_TONES[primary] ?? "bg-muted text-muted-foreground",
      )}
    >
      <HugeiconsIcon strokeWidth={1.8} icon={TYPE_ICONS[primary] ?? PackageIcon} className="size-[18px]" />
    </span>
  );
}

function TypeBadge({ type }: { type: string }): JSX.Element {
  return (
    <Badge variant="secondary" className="h-[18px] rounded-md px-1.5 text-[10.5px] font-normal">
      {TYPE_LABELS[type] ?? type}
    </Badge>
  );
}

function MetaLink({ label, href }: { label: string; href: string }): JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-0.5 transition-colors hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        window.open(href, "_blank");
      }}
    >
      {label}
      <HugeiconsIcon strokeWidth={2} icon={ArrowUpRight01Icon} className="size-3" />
    </button>
  );
}

function InstalledList({
  packages,
  pending,
  busy,
  onRemove,
}: {
  packages: ExtensionPackage[];
  pending: string | null;
  busy: boolean;
  onRemove: (item: ExtensionPackage) => void;
}): JSX.Element {
  if (packages.length === 0) {
    return (
      <Empty className="min-h-0 flex-1 border border-dashed border-border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon strokeWidth={2} icon={PackageIcon} />
          </EmptyMedia>
          <EmptyTitle>尚未安装插件</EmptyTitle>
          <EmptyDescription>切换到「官方市场」浏览并安装</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="grid gap-2.5 pt-px pr-3 pb-2 pl-px sm:grid-cols-2">
        {packages.map((item) => (
          <Card key={item.source} size="sm">
            <CardHeader>
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    item.builtin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                  )}
                >
                  <HugeiconsIcon strokeWidth={1.8} icon={PackageIcon} className="size-[18px]" />
                </span>
                <div className="min-w-0">
                  <CardTitle
                    title={packageName(item.source)}
                    className="line-clamp-2 break-words text-[13px] leading-5"
                  >
                    {packageName(item.source)}
                  </CardTitle>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {item.builtin ? "随应用内置" : item.source}
                  </p>
                </div>
              </div>
              <CardAction>
                {item.builtin ? (
                  <Badge variant="secondary" className="h-[18px] rounded-md px-1.5 text-[10.5px] font-normal">
                    内置
                  </Badge>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy || pending === item.source}
                    onClick={() => onRemove(item)}
                  >
                    {pending === item.source ? (
                      <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" />
                    ) : (
                      <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
                    )}
                    卸载
                  </Button>
                )}
              </CardAction>
            </CardHeader>
          </Card>
        ))}
      </div>
    </ScrollArea>
  );
}

function MarketList({
  page,
  loading,
  pending,
  installed,
  onInstall,
}: {
  page: MarketPackagePage | null;
  loading: boolean;
  pending: string | null;
  installed: Set<string>;
  onInstall: (item: MarketPackage) => void;
}): JSX.Element {
  if (loading && !page) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-5 animate-spin" />
      </div>
    );
  }
  if (page && page.packages.length === 0) {
    return (
      <Empty className="min-h-0 flex-1 border border-dashed border-border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon strokeWidth={2} icon={Store01Icon} />
          </EmptyMedia>
          <EmptyTitle>没有匹配的插件</EmptyTitle>
          <EmptyDescription>换个关键词或类型试试</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    // Remount when the result set changes (page / query / type / sort) so the
    // scroll position resets to the top instead of staying at the old offset.
    <ScrollArea
      key={page ? `${page.query}|${page.type}|${page.sort}|${page.page}` : "loading"}
      className={cn("min-h-0 flex-1", loading && "opacity-60")}
    >
      <div className="grid gap-2.5 pt-px pr-3 pb-2 pl-px sm:grid-cols-2">
        {page?.packages.map((item) => {
          const isInstalled = installed.has(item.name);
          const isPending = pending === item.name;
          const downloads = formatDownloads(item.downloads);
          return (
            <Card key={item.name} size="sm">
              <CardHeader>
                <div className="flex min-w-0 items-start gap-2.5">
                  <PackageAvatar types={item.types} />
                  <div className="min-w-0 flex-1">
                    <CardTitle
                      title={item.name}
                      className="line-clamp-2 break-words text-[13px] leading-5"
                    >
                      {item.name}
                    </CardTitle>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {item.types.slice(0, 2).map((entry) => (
                        <TypeBadge key={entry} type={entry} />
                      ))}
                      {item.version ? (
                        <span className="text-[10.5px] text-muted-foreground">v{item.version}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <CardAction>
                  {isInstalled ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <HugeiconsIcon strokeWidth={2} icon={CheckmarkCircle02Icon} className="size-3.5 text-success" />
                      已安装
                    </span>
                  ) : (
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={pending !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        onInstall(item);
                      }}
                    >
                      {isPending ? (
                        <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" />
                      ) : (
                        <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />
                      )}
                      安装
                    </Button>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent>
                <p className="line-clamp-2 min-h-10 text-[12px] leading-5 text-muted-foreground">
                  {item.description}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
                  {item.author ? (
                    <span className="inline-flex items-center gap-1">
                      <HugeiconsIcon strokeWidth={2} icon={UserIcon} className="size-3" />
                      {item.author}
                    </span>
                  ) : null}
                  {downloads ? (
                    <span className="inline-flex items-center gap-1">
                      <HugeiconsIcon strokeWidth={2} icon={Download01Icon} className="size-3" />
                      {downloads}
                    </span>
                  ) : null}
                  {item.updatedAt ? (
                    <span className="inline-flex items-center gap-1">
                      <HugeiconsIcon strokeWidth={2} icon={Clock01Icon} className="size-3" />
                      {formatRelativeTime(item.updatedAt)}
                    </span>
                  ) : null}
                  {item.npmUrl ? <MetaLink label="npm" href={item.npmUrl} /> : null}
                  {item.repoUrl ? <MetaLink label="仓库" href={item.repoUrl} /> : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </ScrollArea>
  );
}
