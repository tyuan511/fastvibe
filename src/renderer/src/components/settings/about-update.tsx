import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAppUpdate } from "@/lib/use-app-update";
import { SettingsGroup, SettingsRow } from "./settings-group";
import { UpdateDialog } from "./update-dialog";
import { useSettingsStore } from "@/stores/settings";
import type { AppUpdateState } from "@shared/ipc";

function statusDescription(state: AppUpdateState | null, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (!state || state.status === "idle") return t("update.idle");
  if (state.status === "disabled") return t("update.disabled");
  if (state.status === "checking") return t("update.checking");
  if (state.status === "not-available") return t("update.latest");
  if (state.status === "available") return t("update.available", { version: state.availableVersion });
  if (state.status === "downloading") {
    const percent = Math.round(state.progress?.percent ?? 0);
    return t("update.downloading", { version: state.availableVersion ?? t("update.newVersion"), percent });
  }
  if (state.status === "downloaded") return t("update.ready", { version: state.availableVersion });
  if (state.status === "error") return state.error || t("update.failed");
  return t("update.idle");
}

export function AboutUpdate(): JSX.Element {
  const { t } = useTranslation("settings");
  const update = useAppUpdate();
  const autoCheck = useSettingsStore((state) => state.settings.autoCheckUpdates);
  const save = useSettingsStore((state) => state.update);
  const [dialogOpen, setDialogOpen] = useState(false);
  const disabled = !update || update.status === "disabled";

  return (
    <>
      <SettingsGroup title={t("update.title")}>
        <SettingsRow
          title={t("update.autoCheck")}
          description={t("update.autoCheckDesc")}
          control={
            <Switch
              checked={autoCheck}
              disabled={disabled}
              onCheckedChange={(checked) => save({ autoCheckUpdates: checked })}
            />
          }
        />
        <SettingsRow
          title={t("update.check")}
          description={statusDescription(update, t)}
          control={
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => setDialogOpen(true)}>
              <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
              {t("update.check")}
            </Button>
          }
        />
      </SettingsGroup>
      <UpdateDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
