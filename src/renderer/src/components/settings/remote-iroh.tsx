import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, CheckmarkCircle02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { IrohRemoteState } from "@shared/iroh-remote";
import { SettingsGroup, SettingsRow } from "./settings-group";

export function RemoteIroh({ state, busy, onRetry }: { state: IrohRemoteState; busy: boolean; onRetry: () => void }): JSX.Element {
  const { t } = useTranslation("settings");
  const status = state.status === "error" ? <span className="text-destructive">{state.error}</span> : state.status === "connecting" ? t("remote.iroh.connecting") : state.status === "online" ? t("remote.iroh.online") : t("remote.iroh.signedOut");
  const statusIcon = state.status === "connecting" ? (
    <Spinner className="size-4 text-muted-foreground" />
  ) : (
    <HugeiconsIcon
      strokeWidth={2}
      icon={state.status === "online" ? CheckmarkCircle02Icon : state.status === "error" ? Alert02Icon : InformationCircleIcon}
      className={`size-4 ${state.status === "online" ? "text-success" : state.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
    />
  );
  return <>
    <SettingsGroup>
      <SettingsRow
        title={t("remote.iroh.transport")}
        description={status}
        control={
          <div className="flex items-center gap-2">
            {state.status === "error" ? <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>{t("remote.iroh.retry")}</Button> : null}
            <span aria-hidden="true" className="inline-flex shrink-0">{statusIcon}</span>
          </div>
        }
      />
    </SettingsGroup>
    <SettingsGroup title={t("remote.iroh.peers")}>
      {state.peers.length === 0 ? <p className="px-4 py-3 text-xs text-muted-foreground">{t("remote.iroh.noPeers")}</p> : state.peers.map((peer) => <div key={peer.id} className="flex items-center justify-between gap-3 px-4 py-2.5"><span className="truncate text-sm">{peer.label}</span><Badge variant={peer.path === "relay" ? "outline" : "secondary"}>{t(`remote.iroh.path.${peer.path}`)}</Badge></div>)}
    </SettingsGroup>
    {state.usage ? <SettingsGroup title={t("remote.iroh.usage")}><SettingsRow title={t("remote.iroh.remaining")} description={t("remote.iroh.usageDesc")} control={<span className="text-sm tabular-nums">{formatBytes(state.usage.remainingBytes)}</span>} /></SettingsGroup> : null}
  </>;
}

function formatBytes(bytes: number): string { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
