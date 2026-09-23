import { useCallback, useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SettingsRow } from "@/components/settings/settings-group";
import { APP_PLATFORM, IS_REMOTE } from "@/lib/platform";
import { useSettingsStore } from "@/stores/settings";
import type { FullDiskAccessStatus } from "@shared/ipc";

/**
 * macOS cannot be asked for Full Disk Access. The system dialog the user keeps
 * seeing is the per-folder one (Desktop, Documents, Downloads), and it has no
 * "allow every folder". The only one-shot grant is a switch in System Settings,
 * so both surfaces here open that pane instead of pretending a prompt can grant it.
 *
 * Desktop only, and only on a Mac: a browser client has no System Settings of its
 * own, and opening the host's would be the wrong machine.
 */
const APPLIES = APP_PLATFORM === "darwin" && !IS_REMOTE;

function useFullDiskStatus(enabled: boolean): FullDiskAccessStatus | null {
  const [status, setStatus] = useState<FullDiskAccessStatus | null>(null);
  const load = useCallback(() => {
    if (!enabled) return;
    void window.fastvibe.system.fullDiskAccess().then(setStatus).catch(() => undefined);
  }, [enabled]);

  useEffect(() => {
    load();
  }, [load]);

  // The switch is flipped in another application. Coming back is the only signal.
  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = (): void => load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, load]);

  return status;
}

/** Once, at launch, until the grant lands or the user says 以后再说. */
export function FullDiskAccessPrompt(): JSX.Element | null {
  const { t } = useTranslation("settings");
  const dismissed = useSettingsStore((state) => state.settings.fullDiskAccessDismissed === true);
  const update = useSettingsStore((state) => state.update);
  const status = useFullDiskStatus(APPLIES && !dismissed);

  if (!APPLIES || dismissed || !status || status.granted) return null;

  return (
    <AlertDialog
      open
      onOpenChange={(next) => {
        if (!next) update({ fullDiskAccessDismissed: true });
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("fullDisk.promptTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("fullDisk.promptBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">
          {t(status.packaged ? "fullDisk.promptSteps" : "fullDisk.promptStepsDev")}
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("fullDisk.later")}</AlertDialogCancel>
          <Button variant="outline" onClick={() => void window.fastvibe.system.revealApp()}>
            {t("fullDisk.reveal")}
          </Button>
          <Button onClick={() => void window.fastvibe.system.openFullDiskAccess()}>
            {t("fullDisk.open")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** 设置 → 通用, for whoever dismissed the prompt and wants the grant later. */
export function FullDiskAccessRow(): JSX.Element | null {
  const { t } = useTranslation("settings");
  const status = useFullDiskStatus(APPLIES);
  if (!APPLIES) return null;

  return (
    <SettingsRow
      title={t("fullDisk.title")}
      description={t("fullDisk.desc")}
      control={
        !status ? null : status.granted ? (
          <span className="text-sm text-muted-foreground">{t("fullDisk.granted")}</span>
        ) : (
          <div className="flex items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => void window.fastvibe.system.revealApp()}>
              {t("fullDisk.reveal")}
            </Button>
            <Button size="xs" variant="outline" onClick={() => void window.fastvibe.system.openFullDiskAccess()}>
              {t("fullDisk.open")}
            </Button>
          </div>
        )
      }
    />
  );
}
