import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAppUpdate } from "@/lib/use-app-update";

/**
 * Sits at the right of the sidebar's 设置 row. A version the background check found
 * stays one click away from anywhere in the app: it downloads on click, tracks its
 * own progress, and turns into the restart action once the download is done.
 */
export function SidebarUpdateButton(): JSX.Element | null {
  const { t } = useTranslation("app");
  const update = useAppUpdate();
  const status = update?.status;

  if (status === "downloading") {
    // Before the first progress tick there is no percentage to show, but the click still
    // has to register — a spinner and 「下载中」 are what say the download started.
    const percent = update?.progress?.percent;
    return (
      <Button size="xs" className="shrink-0" disabled>
        <Spinner className="size-3" />
        {percent === undefined ? t("update.sidebarDownloading") : `${Math.round(percent)}%`}
      </Button>
    );
  }

  if (status === "downloaded") {
    return (
      <Button
        size="xs"
        className="shrink-0"
        title={t("update.sidebarRestartTitle", { version: update?.availableVersion })}
        onClick={() => void window.fastvibe.updater.install()}
      >
        <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} className="size-3" />
        {t("update.sidebarRestart")}
      </Button>
    );
  }

  if (status === "available") {
    return (
      <Button
        size="xs"
        className="shrink-0"
        title={t("update.sidebarUpdateTitle", { version: update?.availableVersion })}
        onClick={() => void window.fastvibe.updater.download()}
      >
        <HugeiconsIcon strokeWidth={2} icon={Download01Icon} className="size-3" />
        {t("update.sidebarUpdate")}
      </Button>
    );
  }

  return null;
}
