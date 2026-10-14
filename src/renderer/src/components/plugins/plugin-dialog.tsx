import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Clock01Icon,
  Delete02Icon,
  Download01Icon,
  Loading03Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatRelativeTime } from "@/lib/time";
import { formatDownloads, packageName, PluginMark, typeLabel } from "@/components/plugins/plugin-card";
import type { ExtensionInfo, ExtensionPackage, MarketPackage } from "@shared/types";

export type PluginDialogTarget =
  | { kind: "installed"; item: ExtensionPackage; state?: ExtensionInfo }
  | { kind: "market"; item: MarketPackage };

export function PluginDialog({
  target,
  installed,
  pending,
  onClose,
  onInstall,
  onRemove,
}: {
  target: PluginDialogTarget | null;
  /** The installed package matching a market card, when one exists. */
  installed?: ExtensionPackage;
  pending: string | null;
  onClose: () => void;
  onInstall: (item: MarketPackage) => void;
  onRemove: (item: ExtensionPackage) => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const market = target?.kind === "market" ? target.item : null;
  const installedItem = target?.kind === "installed" ? target.item : installed;
  const state = target?.kind === "installed" ? target.state : undefined;
  const name = market?.name ?? (installedItem ? packageName(installedItem.source) : "");
  const types = market?.types ?? ["package"];
  const description = market?.description || state?.error || "";
  const busy = pending !== null;
  const installing = market ? pending === market.name : false;
  const removing = installedItem ? pending === installedItem.source : false;
  const commands = state?.commands ?? installedItem?.commands;
  const tools = state?.tools ?? installedItem?.tools;

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex max-h-[88vh] min-h-0 flex-col gap-4 overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <PluginMark types={types} className="size-10" />
            <div className="min-w-0">
              <DialogTitle className="truncate">{name}</DialogTitle>
              {market?.author ? <DialogDescription>{market.author}</DialogDescription> : null}
            </div>
          </div>
        </DialogHeader>

        {target ? (
          <div className="-mx-1 grid min-h-0 gap-4 overflow-y-auto px-1 text-sm">
            {description ? <p className={state?.error ? "leading-6 text-destructive" : "leading-6"}>{description}</p> : null}
            <div className="flex flex-wrap items-center gap-1.5">
              {types.map((type) => (
                <Badge key={type} variant="secondary">{typeLabel(type)}</Badge>
              ))}
              {market?.version ? <Badge variant="outline">v{market.version}</Badge> : null}
              {state?.error ? <Badge variant="destructive">{t("extensions.loadFailed")}</Badge> : state ? <Badge variant="outline">{t("extensions.loaded")}</Badge> : null}
              {installedItem ? (
                <Badge variant="outline">{installedItem.scope === "project" ? t("extensions.scopeProject") : t("extensions.scopeUser")}</Badge>
              ) : null}
              {commands ? <span className="rounded-md bg-muted/70 px-1.5 py-0.5 text-xs text-muted-foreground">{t("extensions.commands", { count: commands })}</span> : null}
              {tools ? <span className="rounded-md bg-muted/70 px-1.5 py-0.5 text-xs text-muted-foreground">{t("extensions.tools", { count: tools })}</span> : null}
            </div>
            {market?.author || formatDownloads(market?.downloads) || market?.updatedAt ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                {market?.author ? <span className="inline-flex items-center gap-1"><HugeiconsIcon strokeWidth={2} icon={UserIcon} className="size-3.5" />{market.author}</span> : null}
                {formatDownloads(market?.downloads) ? <span className="inline-flex items-center gap-1"><HugeiconsIcon strokeWidth={2} icon={Download01Icon} className="size-3.5" />{formatDownloads(market?.downloads)}</span> : null}
                {market?.updatedAt ? <span className="inline-flex items-center gap-1"><HugeiconsIcon strokeWidth={2} icon={Clock01Icon} className="size-3.5" />{formatRelativeTime(market.updatedAt)}</span> : null}
              </div>
            ) : null}
            {installedItem ? <p className="break-all text-xs text-muted-foreground">{t("extensions.source")}: {installedItem.source}</p> : null}
            {market?.npmUrl || market?.repoUrl ? (
              <div className="flex flex-wrap gap-3 text-sm">
                {market.npmUrl ? <a className="text-primary underline-offset-3 hover:underline" href={market.npmUrl} target="_blank" rel="noreferrer">{t("extensions.npm")}</a> : null}
                {market.repoUrl ? <a className="text-primary underline-offset-3 hover:underline" href={market.repoUrl} target="_blank" rel="noreferrer">{t("extensions.repo")}</a> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {installedItem ? (
            <Button variant="outline" disabled={busy} onClick={() => onRemove(installedItem)}>
              {removing ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />}
              {t("extensions.uninstall")}
            </Button>
          ) : null}
          {market && !installedItem ? (
            <Button disabled={busy} onClick={() => onInstall(market)}>
              {installing ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />}
              {t("extensions.install")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
