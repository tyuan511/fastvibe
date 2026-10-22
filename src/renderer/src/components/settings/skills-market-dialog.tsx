import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Download01Icon,
  InformationCircleIcon,
  Search01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/icon-button";
import { cn } from "@/lib/utils";
import type { SkillInfo, SkillMarketEntry, SkillMarketInstallResult } from "@shared/types";

/**
 * The skills.sh browser, in the pane that already owns skills.
 *
 * It is a dialog rather than a second list in the pane because the two things it is for
 * — looking for something, and keeping what you have — want different tools: this one
 * needs its own search field and its own empty state, and the installed list keeps its
 * refresh / 新建 / 删除 row untouched.
 *
 * What a row costs: one search per query (the index answers with slug, source and install
 * count only), one page fetch for a description when the reader asks for it, and one
 * repository download when they install. Nothing is fetched for the thirty rows up front.
 */
export function SkillsMarketDialog({
  open,
  onClose,
  installed,
  onInstalled,
}: {
  open: boolean;
  onClose: () => void;
  installed: SkillInfo[];
  onInstalled: (result: SkillMarketInstallResult) => void;
}): JSX.Element {
  const { t, i18n } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [entries, setEntries] = useState<SkillMarketEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => setSearch(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const id = ++request.current;
    if (search.length < 2) {
      setEntries(null);
      setLoading(false);
      setFailure("");
      return;
    }
    setLoading(true);
    setFailure("");
    void window.fastvibe.engine
      .searchSkillMarket(search, nonce > 0)
      .then((result) => {
        if (request.current === id) setEntries(result);
      })
      .catch((error: unknown) => {
        if (request.current !== id) return;
        setEntries(null);
        setFailure(error instanceof Error ? error.message : t("skills.marketFailed"));
      })
      .finally(() => {
        if (request.current === id) setLoading(false);
      });
  }, [open, search, nonce, t]);

  const installedByName = useMemo(() => {
    const map = new Map<string, SkillInfo>();
    for (const skill of installed) map.set(skill.name, skill);
    return map;
  }, [installed]);

  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }), [i18n.language]);

  async function toggleDetail(entry: SkillMarketEntry): Promise<void> {
    if (expanded === entry.id) {
      setExpanded(null);
      return;
    }
    setExpanded(entry.id);
    if (descriptions[entry.id] !== undefined) return;
    try {
      const detail = await window.fastvibe.engine.skillMarketDetail({ source: entry.source, skillId: entry.skillId });
      setDescriptions((current) => ({ ...current, [entry.id]: detail.description }));
    } catch {
      // The description is a courtesy; the row is still installable without it.
      setDescriptions((current) => ({ ...current, [entry.id]: "" }));
    }
  }

  async function install(entry: SkillMarketEntry, overwrite: boolean): Promise<void> {
    setPending(entry.id);
    try {
      const result = await window.fastvibe.engine.installMarketSkill({
        source: entry.source,
        skillId: entry.skillId,
        overwrite,
      });
      onInstalled(result);
      toast.success(t("skills.marketInstallDone", { name: result.installed.name, files: result.installed.files }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("skills.marketInstallFailed"));
    } finally {
      setPending(null);
    }
  }

  const searching = loading && !entries;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("skills.marketTitle")}</DialogTitle>
          <DialogDescription>{t("skills.marketDesc")}</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <HugeiconsIcon
            strokeWidth={2}
            icon={Search01Icon}
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("skills.marketSearch")}
            aria-label={t("skills.marketSearch")}
            className="h-9 rounded-full pl-8"
          />
          {loading ? (
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
              <Spinner className="size-3.5" />
            </span>
          ) : null}
        </div>

        <div className={cn("min-h-24 max-h-[min(26rem,45dvh)] overflow-y-auto", "px-0.5")}>
          {searching ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner className="size-3.5" />
              {t("skills.marketSearching")}
            </div>
          ) : failure ? (
            <p className="py-8 text-sm text-muted-foreground">{failure}</p>
          ) : !entries ? (
            <div className="space-y-2 py-6 text-sm text-muted-foreground">
              <p>{t("skills.marketHint")}</p>
              <div className="flex flex-wrap gap-1.5">
                {["react", "testing", "deploy", "pdf", "design"].map((sample) => (
                  <Button key={sample} size="xs" variant="outline" onClick={() => setQuery(sample)}>
                    {sample}
                  </Button>
                ))}
              </div>
            </div>
          ) : entries.length === 0 ? (
            <p className="py-8 text-sm text-muted-foreground">{t("skills.marketNone")}</p>
          ) : (
            <div className="grid gap-2">
              {entries.map((entry) => {
                const known = installedByName.get(entry.name) ?? installedByName.get(entry.skillId);
                const installing = pending === entry.id;
                const busy = pending !== null && !installing;
                const canReplace = Boolean(known?.removable);
                const description = descriptions[entry.id];
                return (
                  <Item
                    key={entry.id}
                    variant="outline"
                    size="sm"
                    className={cn("items-start gap-3 p-3 transition-colors hover:bg-muted/20", loading && "opacity-60")}
                  >
                    <ItemContent className="min-w-0 gap-1.5">
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => void toggleDetail(entry)}
                        title={t("skills.marketDetail")}
                      >
                        <ItemTitle className="min-w-0 truncate text-base">{entry.name}</ItemTitle>
                      </button>
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge variant="secondary" className="shrink-0 font-mono">
                          {numbers.format(entry.installs)}
                        </Badge>
                        <ItemDescription className="min-w-0 truncate font-mono text-xs">{entry.source}</ItemDescription>
                      </div>
                      {expanded === entry.id ? (
                        <p className="text-xs leading-5 text-muted-foreground">
                          {description === undefined ? t("skills.marketDetailLoading") : description || t("skills.marketNoDetail")}
                        </p>
                      ) : null}
                    </ItemContent>
                    <ItemActions className="ml-auto shrink-0 self-center">
                      {!entry.installable ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <HugeiconsIcon strokeWidth={2} icon={InformationCircleIcon} className="size-3.5" />
                          {t("skills.marketOutside")}
                        </span>
                      ) : known ? (
                        canReplace ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="pointer-coarse:h-9"
                            disabled={busy}
                            onClick={() => void install(entry, true)}
                          >
                            {installing ? <Spinner className="size-3.5" /> : <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />}
                            {t("skills.marketReplace")}
                          </Button>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <HugeiconsIcon strokeWidth={2} icon={CheckmarkCircle02Icon} className="size-3.5 text-success" />
                            {t("skills.marketInstalled")}
                          </span>
                        )
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="pointer-coarse:h-9"
                          disabled={busy}
                          onClick={() => void install(entry, false)}
                        >
                          {installing ? <Spinner className="size-3.5" /> : <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />}
                          {t("skills.marketInstall")}
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" render={<a href="https://skills.sh" target="_blank" rel="noreferrer" />}>
            {t("skills.marketBrowse")}
            <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} className="size-3.5" />
          </Button>
          <div className="flex items-center gap-2">
            {search.length >= 2 ? (
              <IconButton
                label={t("skills.marketRefresh")}
                size="icon-sm"
                variant="outline"
                disabled={loading}
                onClick={() => setNonce((current) => current + 1)}
              >
                <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
              </IconButton>
            ) : null}
            <Button variant="outline" onClick={onClose}>
              {t("skills.cancel")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
