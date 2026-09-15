import { useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download01Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAppUpdate } from "@/lib/use-app-update";

export function UpdateBanner(): JSX.Element | null {
  const update = useAppUpdate();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (update?.status !== "downloaded" || !update.availableVersion) return null;
  if (dismissed === update.availableVersion) return null;

  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-6">
      <Alert className="has-data-[slot=alert-action]:pr-40">
        <HugeiconsIcon strokeWidth={2} icon={Download01Icon} />
        <AlertTitle>新版本已就绪</AlertTitle>
        <AlertDescription>FastVibe {update.availableVersion} 已下载，安装需要重启应用。</AlertDescription>
        <AlertAction>
          <div className="flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={() => setDismissed(update.availableVersion ?? null)}>
              稍后
            </Button>
            <Button size="xs" onClick={() => void window.fastvibe.updater.install()}>
              立即安装
            </Button>
          </div>
        </AlertAction>
      </Alert>
    </div>
  );
}
