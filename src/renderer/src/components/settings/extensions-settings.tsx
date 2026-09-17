import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Delete02Icon,
  Download01Icon,
  File01Icon,
  GithubIcon,
  Loading03Icon,
  NpmIcon,
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
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IconButton } from "@/components/icon-button";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type {
  ExtensionInfo,
  ExtensionPackage,
  MarketPackage,
  MarketPackagePage,
  MarketPackageQuery,
} from "@shared/types";

const TYPE_KEYS = ["extension", "skill", "theme", "prompt", "package"] as const;
const TYPE_LABEL_KEYS: Record<string, string> = {
  extension: "extensions.kindExtension",
  skill: "extensions.kindSkill",
  theme: "extensions.kindTheme",
  prompt: "extensions.kindPrompt",
  package: "extensions.kindPackage",
};
const TYPE_FILTER_KEYS = ["", "extension", "skill", "theme", "prompt"] as const;
const SORT_FILTER_KEYS = ["downloads", "recent", "name"] as const;
const SORT_LABEL_KEYS: Record<string, string> = {
  downloads: "extensions.sortDownloads",
  recent: "extensions.sortRecent",
  name: "extensions.sortName",
};

function typeLabel(type: string): string {
  const key = TYPE_LABEL_KEYS[type];
  return key ? (i18n.t(`settings:${key}`) as string) : type;
}

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
 * Plugins are pi packages from pi.dev's catalog, installed into FastVibe's
 * isolated agentDir — never the user's `~/.pi`.
 */
export function ExtensionsSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const typeFilters = Object.fromEntries(
    TYPE_FILTER_KEYS.map((key) => [key, key ? t(TYPE_LABEL_KEYS[key]) : t("extensions.allTypes")]),
  );
  const sortFilters = Object.fromEntries(SORT_FILTER_KEYS.map((key) => [key, t(SORT_LABEL_KEYS[key])]));
  const [tab, setTab] = useState<"installed" | "market">("installed");
  const [packages, setPackages] = useState<ExtensionPackage[]>([]);
  const [loaded, setLoaded] = useState<ExtensionInfo[]>([]);
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
      const [next, extensions] = await Promise.all([
        window.fastvibe.engine.listExtensionPackages(),
        window.fastvibe.engine.getExtensions(),
      ]);
      setPackages(next);
      setLoaded(extensions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("extensions.listFailed"));
    } finally {
      setInstalledBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  // Debounce the search box so typing does not fire a catalog request per key.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setPageIndex(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (tab !== "market") return;
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
        setError(err instanceof Error ? err.message : t("extensions.catalogFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, search, type, sort, pageIndex]);

  async function installFromMarket(item: MarketPackage): Promise<void> {
    if (pending || installedNames.has(item.name)) return;
    setPending(item.name);
    try {
      setPackages(await window.fastvibe.engine.installExtensionPackage(`npm:${item.name}`));
      setError(null);
      await refreshInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("extensions.installFailed"));
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
      await refreshInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("extensions.removeFailed"));
    } finally {
      setPending(null);
    }
  }

  const total = page?.total;
  const busy = Boolean(pending) || installedBusy;

  return (
    <div className="space-y-4">
      <p className="text-xs leading-5 text-muted-foreground">
        {t("extensions.introBefore")} <code>~/.pi</code>
        {t("extensions.introAfter")}
      </p>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as "installed" | "market")}
      >
        <div className="flex items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="installed" className="px-3">
              {packages.length ? t("extensions.installedCount", { count: packages.length }) : t("extensions.installed")}
            </TabsTrigger>
            <TabsTrigger value="market" className="px-3">
              {t("extensions.marketplace")}
            </TabsTrigger>
          </TabsList>
          {tab === "installed" ? (
            <IconButton
              label={t("extensions.refresh")}
              size="icon-sm"
              variant="outline"
              disabled={installedBusy}
              onClick={() => void refreshInstalled()}
            >
              <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} className="size-3.5" />
            </IconButton>
          ) : null}
        </div>

        <TabsContent value="installed" className="flex flex-col gap-3">
          <InstalledList
            packages={packages}
            loaded={loaded}
            pending={pending}
            busy={busy}
            onRemove={(item) => void remove(item)}
          />
        </TabsContent>

        <TabsContent value="market" className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <HugeiconsIcon
                strokeWidth={2}
                icon={Search01Icon}
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                placeholder={t("extensions.search")}
                className="pl-8"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Select
              items={typeFilters}
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
                {Object.entries(typeFilters).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={sortFilters}
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
                {Object.entries(sortFilters).map(([value, label]) => (
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
            onInstall={(item) => void installFromMarket(item)}
          />

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total ? t("extensions.total", { count: total.toLocaleString() }) : page ? t("extensions.results", { count: page.packages.length }) : ""}
            </span>
            <div className="flex items-center gap-1">
              <IconButton
                label={t("extensions.prev")}
                size="icon-xs"
                variant="ghost"
                disabled={loading || pageIndex <= 1}
                onClick={() => setPageIndex((value) => Math.max(1, value - 1))}
              >
                <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} className="size-3.5" />
              </IconButton>
              <span>{pageIndex}</span>
              <IconButton
                label={t("extensions.next")}
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
    </div>
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
      <HugeiconsIcon strokeWidth={1.8} icon={TYPE_ICONS[primary] ?? PackageIcon} className="size-4.5" />
    </span>
  );
}

function TypeBadge({ type }: { type: string }): JSX.Element {
  return (
    <Badge variant="secondary" className="h-4.5 rounded-md px-1.5 text-xs font-normal">
      {typeLabel(type)}
    </Badge>
  );
}

function MetaLink({
  label,
  href,
  icon,
}: {
  label: string;
  href: string;
  icon: typeof NpmIcon;
}): JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
      onClick={(event) => {
        event.stopPropagation();
        window.open(href, "_blank");
      }}
    >
      <HugeiconsIcon strokeWidth={2} icon={icon} className="size-3.5" />
      {label}
    </button>
  );
}

function InstalledList({
  packages,
  loaded,
  pending,
  busy,
  onRemove,
}: {
  packages: ExtensionPackage[];
  loaded: ExtensionInfo[];
  pending: string | null;
  busy: boolean;
  onRemove: (item: ExtensionPackage) => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  if (packages.length === 0) {
    return (
      <Empty className="border border-dashed border-border py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon strokeWidth={2} icon={PackageIcon} />
          </EmptyMedia>
          <EmptyTitle>{t("extensions.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("extensions.emptyDesc")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {packages.map((item) => {
        // The loader reports the extension file path, which lives under the
        // package's own node_modules directory, so match on the path not name.
        const state = loaded.find((entry) => entry.path.includes(packageName(item.source)));
        return (
          <Card key={item.source} size="sm">
            <CardHeader>
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    item.builtin ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                  )}
                >
                  <HugeiconsIcon strokeWidth={1.8} icon={PackageIcon} className="size-4.5" />
                </span>
                <div className="min-w-0">
                  <CardTitle
                    title={packageName(item.source)}
                    className="line-clamp-2 break-words text-base leading-5"
                  >
                    {packageName(item.source)}
                  </CardTitle>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.builtin ? t("extensions.builtinWithApp") : item.source}
                  </p>
                </div>
              </div>
              <CardAction className="flex items-center gap-1.5">
                {item.builtin ? (
                  <Badge variant="secondary" className="h-4.5 rounded-md px-1.5 text-xs font-normal">
                    {t("extensions.builtin")}
                  </Badge>
                ) : null}
                {state?.error ? (
                  <Badge variant="destructive" className="h-4.5 rounded-md px-1.5 text-xs font-normal">
                    {t("extensions.loadFailed")}
                  </Badge>
                ) : state ? (
                  <Badge variant="secondary" className="h-4.5 rounded-md px-1.5 text-xs font-normal">
                    {t("extensions.loaded")}
                  </Badge>
                ) : null}
                {item.builtin ? null : (
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
                    {t("extensions.uninstall")}
                  </Button>
                )}
              </CardAction>
            </CardHeader>
            {state?.error ? (
              <CardContent>
                <p className="line-clamp-2 text-xs text-destructive">{state.error}</p>
              </CardContent>
            ) : null}
          </Card>
        );
      })}
    </div>
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
  const { t } = useTranslation("settings");
  if (loading && !page) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-5 animate-spin" />
      </div>
    );
  }
  if (page && page.packages.length === 0) {
    return (
      <Empty className="border border-dashed border-border py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon strokeWidth={2} icon={Store01Icon} />
          </EmptyMedia>
          <EmptyTitle>{t("extensions.noneTitle")}</EmptyTitle>
          <EmptyDescription>{t("extensions.noneDesc")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className={cn("grid gap-2.5 sm:grid-cols-2", loading && "opacity-60")}>
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
                    className="line-clamp-2 break-words text-base leading-5"
                  >
                    {item.name}
                  </CardTitle>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {item.types.slice(0, 2).map((entry) => (
                      <TypeBadge key={entry} type={entry} />
                    ))}
                    {item.version ? (
                      <span className="text-xs text-muted-foreground">v{item.version}</span>
                    ) : null}
                  </div>
                </div>
              </div>
              <CardAction>
                {isInstalled ? (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <HugeiconsIcon strokeWidth={2} icon={CheckmarkCircle02Icon} className="size-3.5 text-success" />
                    {t("extensions.alreadyInstalled")}
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
                    {t("extensions.install")}
                  </Button>
                )}
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <p className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
                {item.description}
              </p>
              <div className="flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground">
                {item.author ? (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <HugeiconsIcon strokeWidth={2} icon={UserIcon} className="size-3 shrink-0" />
                    <span className="truncate">{item.author}</span>
                  </span>
                ) : null}
                {downloads ? (
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <HugeiconsIcon strokeWidth={2} icon={Download01Icon} className="size-3" />
                    {downloads}
                  </span>
                ) : null}
                {item.updatedAt ? (
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <HugeiconsIcon strokeWidth={2} icon={Clock01Icon} className="size-3" />
                    {formatRelativeTime(item.updatedAt)}
                  </span>
                ) : null}
              </div>
            </CardContent>
            {item.npmUrl || item.repoUrl ? (
              <CardFooter className="gap-0.5 py-2">
                {item.npmUrl ? <MetaLink label="npm" href={item.npmUrl} icon={NpmIcon} /> : null}
                {item.repoUrl ? <MetaLink label={t("extensions.repo")} href={item.repoUrl} icon={GithubIcon} /> : null}
              </CardFooter>
            ) : null}
          </Card>
        );
      })}
    </div>
  );
}
