import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useAppUpdate } from "@/lib/use-app-update";
import { useSettingsStore } from "@/stores/settings";
import type { AppUpdateState } from "@shared/ipc";

function Row({
  title,
  description,
  control,
}: {
  title: string;
  description?: string;
  control: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3">
      <div className="min-w-0">
        <Label className="text-sm font-medium">{title}</Label>
        {description ? <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function statusDescription(state: AppUpdateState | null): string {
  if (!state || state.status === "idle") return "从已发布的版本检查更新";
  if (state.status === "disabled") return "开发构建不会检查更新";
  if (state.status === "checking") return "正在检查…";
  if (state.status === "not-available") return "已是最新版本";
  if (state.status === "available") return `发现 ${state.availableVersion}，准备下载`;
  if (state.status === "downloading") {
    const percent = Math.round(state.progress?.percent ?? 0);
    return `正在下载 ${state.availableVersion ?? "新版本"} · ${percent}%`;
  }
  if (state.status === "downloaded") return `${state.availableVersion} 已就绪，安装需要重启`;
  if (state.status === "error") return state.error || "检查更新失败";
  return "从已发布的版本检查更新";
}

export function AboutUpdate(): JSX.Element {
  const update = useAppUpdate();
  const autoCheck = useSettingsStore((state) => state.settings.autoCheckUpdates);
  const save = useSettingsStore((state) => state.update);
  const busy = update?.status === "checking" || update?.status === "downloading";
  const disabled = !update || update.status === "disabled";
  const ready = update?.status === "downloaded";

  return (
    <section className="space-y-2">
      <h3 className="px-1 text-sm font-medium">更新</h3>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        <Row
          title="自动检查更新"
          description="启动后检查新版本并在后台下载"
          control={
            <Switch
              checked={autoCheck}
              disabled={disabled}
              onCheckedChange={(checked) => save({ autoCheckUpdates: checked })}
            />
          }
        />
        <Row
          title="检查更新"
          description={statusDescription(update)}
          control={
            <Button
              size="xs"
              variant={ready ? "default" : "outline"}
              disabled={disabled || busy}
              onClick={() => {
                if (ready) void window.fastvibe.updater.install();
                else void window.fastvibe.updater.check();
              }}
            >
              {busy ? <Spinner className="size-3" /> : <HugeiconsIcon strokeWidth={2} icon={ready ? Download01Icon : RefreshIcon} />}
              {ready ? "立即安装并重启" : "检查更新"}
            </Button>
          }
        />
        {update?.status === "downloading" ? (
          <div className="px-4 py-3">
            <Progress value={update.progress?.percent ?? 0} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
