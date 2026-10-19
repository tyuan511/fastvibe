import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Download01Icon,
  Loading03Icon,
  PanelLeftOpenIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { packageName, PluginCard, typeLabel } from "@/components/plugins/plugin-card";
import { PluginDialog, type PluginDialogTarget } from "@/components/plugins/plugin-dialog";
import { cn } from "@/lib/utils";
import type { ExtensionInfo, ExtensionPackage, MarketPackage, MarketPackagePage, MarketPackageQuery } from "@shared/types";

const TYPE_FILTERS = ["", "extension", "skill", "theme", "prompt"] as const;
const SORT_FILTERS = ["downloads", "recent", "name"] as const;

/**
 * 插件 — the page behind the sidebar entry. Same shell as 智能体: one width, a card
 * grid, and a dialog for the thing you clicked.
 */
export function PluginsPage({
  sidebarCollapsed,
  onExpandSidebar,
}: {
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const { t: tApp } = useTranslation("app");
  const [tab, setTab] = useState<"installed" | "market">("market");
  const [packages, setPackages] = useState<ExtensionPackage[]>([]);
  const [loaded, setLoaded] = useState<ExtensionInfo[]>([]);
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<MarketPackagePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [sort, setSort] = useState<NonNullable<MarketPackageQuery["sort"]>>("downloads");
  const [pageIndex, setPageIndex] = useState(1);
  const [pending, setPending] = useState<string | null>(null);
  const [target, setTarget] = useState<PluginDialogTarget | null>(null);

  const installedNames = useMemo(() => new Set(packages.map((item) => packageName(item.source))), [packages]);

  const refreshInstalled = useCallback(async (): Promise<void> => {
    try {
      const [next, extensions] = await Promise.all([
        window.fastvibe.engine.listExtensionPackages(),
        window.fastvibe.engine.getExtensions(),
      ]);
      // Built-in extensions ship with the app; they are not something the user manages here.
      setPackages(next.filter((item) => !item.builtin));
      setLoaded(extensions);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("extensions.listFailed"));
    } finally {
      setReady(true);
    }
  }, [t]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

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
        if (!cancelled) setPage(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : t("extensions.catalogFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, search, type, sort, pageIndex, t]);

  const visibleInstalled = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return packages;
    return packages.filter((item) => packageName(item.source).toLowerCase().includes(needle) || item.source.toLowerCase().includes(needle));
  }, [packages, query]);

  function stateOf(item: ExtensionPackage): ExtensionInfo | undefined {
    return loaded.find((entry) => entry.path.includes(packageName(item.source)));
  }

  async function installFromMarket(item: MarketPackage): Promise<void> {
    if (pending || installedNames.has(item.name)) return;
    setPending(item.name);
    try {
      setPackages((await window.fastvibe.engine.installExtensionPackage(`npm:${item.name}`)).filter((entry) => !entry.builtin));
      await refreshInstalled();
      toast.success(t("extensions.installDone", { name: item.name }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("extensions.installFailed"));
    } finally {
      setPending(null);
    }
  }

  async function remove(item: ExtensionPackage): Promise<void> {
    if (pending) return;
    setPending(item.source);
    try {
      setPackages((await window.fastvibe.engine.removeExtensionPackage(item.source)).filter((entry) => !entry.builtin));
      await refreshInstalled();
      if (target?.kind === "installed" && target.item.source === item.source) setTarget(null);
      toast.success(t("extensions.removeDone", { name: packageName(item.source) }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("extensions.removeFailed"));
    } finally {
      setPending(null);
    }
  }

  const installedMatch = target?.kind === "market"
    ? packages.find((item) => packageName(item.source) === target.item.name)
    : undefined;
  const total = page?.total;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="drag-region shrink-0 pt-4">
        <div className="mx-auto flex w-full max-w-5xl items-start gap-1 px-6 pb-3">
          {sidebarCollapsed ? (
            <IconButton size="icon-sm" variant="ghost" label={tApp("workspace.expandSidebar")} onClick={onExpandSidebar} className="no-drag mt-0.5">
              <HugeiconsIcon strokeWidth={2} icon={PanelLeftOpenIcon} />
            </IconButton>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-xl font-medium tracking-tight">{tApp("sidebar.plugins")}</h1>
            <p className="text-sm leading-5 text-muted-foreground">{t("extensions.subtitle")}</p>
          </div>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 pb-10 pt-1">
          <div className="relative min-w-48">
            <HugeiconsIcon strokeWidth={2} icon={Search01Icon} className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              className="pl-8"
              value={query}
              placeholder={t("extensions.search")}
              aria-label={t("extensions.search")}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={tab === "market"} onClick={() => setTab("market")}>
              {t("extensions.marketplace")}
            </Chip>
            <Chip active={tab === "installed"} onClick={() => setTab("installed")}>
              {packages.length ? t("extensions.installedCount", { count: packages.length }) : t("extensions.installed")}
            </Chip>
          </div>
          {tab === "market" ? (
            <div className="flex flex-wrap gap-1.5">
              {TYPE_FILTERS.map((key) => (
                <Chip key={key || "all"} active={type === key} onClick={() => { setType(key); setPageIndex(1); }}>
                  {key ? typeLabel(key) : t("extensions.allTypes")}
                </Chip>
              ))}
              {SORT_FILTERS.map((key) => (
                <Chip key={key} active={sort === key} onClick={() => { setSort(key); setPageIndex(1); }}>
                  {t(`extensions.sort${key === "downloads" ? "Downloads" : key === "recent" ? "Recent" : "Name"}`)}
                </Chip>
              ))}
            </div>
          ) : null}

          {tab === "installed" ? (
            !ready ? null : visibleInstalled.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                {packages.length === 0 ? t("extensions.emptyTitle") : t("extensions.noneTitle")}
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
                {visibleInstalled.map((item) => {
                  const state = stateOf(item);
                  const name = packageName(item.source);
                  return (
                    <PluginCard
                      key={item.source}
                      name={name}
                      meta={state?.error ? t("extensions.loadFailed") : state ? t("extensions.loaded") : item.scope === "project" ? t("extensions.scopeProject") : t("extensions.scopeUser")}
                      description={state?.error || item.source}
                      types={["package"]}
                      onOpen={() => setTarget({ kind: "installed", item, state })}
                    />
                  );
                })}
              </div>
            )
          ) : loading && !page ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-5 animate-spin" />
            </div>
          ) : page && page.packages.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">{t("extensions.noneTitle")}</p>
          ) : (
            <>
              <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3", loading && "opacity-60")}>
                {page?.packages.map((item) => {
                  const isInstalled = installedNames.has(item.name);
                  const installing = pending === item.name;
                  return (
                    <PluginCard
                      key={item.name}
                      name={item.name}
                      meta={item.author || (item.types[0] ? typeLabel(item.types[0]) : "")}
                      description={item.description}
                      types={item.types}
                      onOpen={() => setTarget({ kind: "market", item })}
                      action={isInstalled ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <HugeiconsIcon strokeWidth={2} icon={CheckmarkCircle02Icon} className="size-3.5 text-success" />
                          {t("extensions.alreadyInstalled")}
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="pointer-coarse:h-9"
                          disabled={pending !== null}
                          onClick={(event) => {
                            event.stopPropagation();
                            void installFromMarket(item);
                          }}
                        >
                          {installing ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />}
                          {t("extensions.install")}
                        </Button>
                      )}
                    />
                  );
                })}
              </div>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  {total ? t("extensions.total", { count: total.toLocaleString() }) : page ? t("extensions.results", { count: page.packages.length }) : ""}
                </span>
                <div className="flex items-center gap-1">
                  <IconButton label={t("extensions.prev")} size="icon-xs" variant="ghost" disabled={loading || pageIndex <= 1} onClick={() => setPageIndex((value) => Math.max(1, value - 1))}>
                    <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} className="size-3.5" />
                  </IconButton>
                  <span>{pageIndex}</span>
                  <IconButton label={t("extensions.next")} size="icon-xs" variant="ghost" disabled={loading || !page?.totalPages || pageIndex >= page.totalPages} onClick={() => setPageIndex((value) => value + 1)}>
                    <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} className="size-3.5" />
                  </IconButton>
                </div>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
      <PluginDialog
        target={target}
        installed={installedMatch}
        pending={pending}
        onClose={() => setTarget(null)}
        onInstall={(item) => void installFromMarket(item)}
        onRemove={(item) => void remove(item)}
      />
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "h-7 rounded-full border px-3 text-xs pointer-coarse:h-9",
        active ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
