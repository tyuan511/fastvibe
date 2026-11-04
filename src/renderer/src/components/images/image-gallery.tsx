import { useEffect, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, Copy01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import type { GeneratedImage, ImageTask } from "@shared/image-generation";
import { inlineSrc } from "@shared/inline-media";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { cleanError } from "@/lib/ipc-error";

/** The transcript Viewer is private; compose the same dialog primitives for a controlled batch. */
export function ImageGallery({ task, index, onIndex, onClose, onUseReference }: {
  task: Pick<ImageTask, "prompt" | "images">;
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onUseReference?: (image: GeneratedImage) => void;
}): JSX.Element {
  const { t } = useTranslation("images");
  const current = task.images[index];
  const count = task.images.length;
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || count < 2) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        onIndex((index + (event.key === "ArrowRight" ? 1 : count - 1)) % count);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [count, index, onIndex]);
  return <Dialog open={Boolean(current)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex h-[90vh] max-w-[calc(100%-2rem)] flex-col gap-3 p-4 sm:max-w-[min(calc(100%-2rem),90rem)]">
      <DialogTitle className="pr-8 text-sm font-medium truncate">{task.prompt}</DialogTitle>
      <DialogDescription className="sr-only">{t("gallery.description")}</DialogDescription>
      {current ? <img key={current.id} src={inlineSrc({ ref: current.path })} alt={task.prompt} decoding="async" className="min-h-0 w-full flex-1 object-contain" /> : null}
      <div className="flex flex-wrap items-center justify-center gap-2" role="toolbar" aria-label={t("gallery.actions")}>
        <Button variant="ghost" size="icon-sm" disabled={count < 2} aria-label={t("gallery.previous")} onClick={() => onIndex((index + count - 1) % count)}><HugeiconsIcon icon={ArrowLeft01Icon} /></Button>
        <span className="shrink-0 px-1 text-xs tabular-nums">{t("gallery.position", { index: index + 1, count })}</span>
        <Button variant="ghost" size="icon-sm" disabled={count < 2} aria-label={t("gallery.next")} onClick={() => onIndex((index + 1) % count)}><HugeiconsIcon icon={ArrowRight01Icon} /></Button>
        {current ? <>
          {onUseReference ? <Button variant="outline" size="sm" onClick={() => onUseReference(current)}>{t("gallery.useReference")}</Button> : null}
          <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard.writeText(current.path).then(() => toast.success(t("timeline.copied"))).catch(() => toast.error(t("timeline.copyFailed"))); }}><HugeiconsIcon icon={Copy01Icon} />{t("gallery.copyPath")}</Button>
          {!current.path.startsWith("remote:") && !current.path.startsWith("data:") && !/^https?:/.test(current.path) ? <Button variant="ghost" size="sm" onClick={() => { void window.fastvibe.workspace.reveal(current.path).then((result) => { if (result?.ok === false) toast.error(t("timeline.imageUnavailable")); }).catch((cause) => toast.error(cleanError(cause))); }}><HugeiconsIcon icon={Folder01Icon} />{t("gallery.reveal")}</Button> : null}
        </> : null}
      </div>
    </DialogContent>
  </Dialog>;
}
