import { memo, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Copy01Icon, Delete02Icon, PencilEdit02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import type { ImageTask } from "@shared/image-generation";
import { inlineSrc } from "@shared/inline-media";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ImageResultsGrid } from "./image-results-grid";
export { imageAspectRatio } from "./image-results-grid";

export const ImageTaskCard = memo(function ImageTaskCard({ task, onEdit, onRegenerate, onCancel, onPreview, onDelete }: {
  task: ImageTask;
  onDelete: (task: ImageTask) => void;
  onEdit: (task: ImageTask) => void;
  onRegenerate: (task: ImageTask) => void;
  onCancel: (task: ImageTask) => void;
  onPreview: (task: ImageTask, index: number) => void;
}): JSX.Element {
  const { t, i18n } = useTranslation("images");
  const generating = task.status === "generating";
  const time = new Intl.DateTimeFormat(i18n.language, { hour: "2-digit", minute: "2-digit" }).format(task.createdAt);
  const actions = [
    { id: "edit", label: t("timeline.edit"), icon: PencilEdit02Icon, onClick: () => onEdit(task) },
    { id: "generate", label: t(generating ? "timeline.cancel" : "timeline.regenerate"), icon: generating ? Cancel01Icon : RefreshIcon, onClick: () => generating ? onCancel(task) : onRegenerate(task) },
    { id: "delete", label: t("actions.delete"), icon: Delete02Icon, onClick: () => onDelete(task) },
    { id: "copy", label: t("timeline.copyPrompt"), icon: Copy01Icon, onClick: () => { void navigator.clipboard.writeText(task.prompt).then(() => toast.success(t("timeline.copied"))).catch(() => toast.error(t("timeline.copyFailed"))); } },
  ];
  return <article className="group/image-task space-y-3" data-image-task={task.id} data-status={task.status}>
    <div className="space-y-1.5">
      <p className="whitespace-pre-wrap text-sm leading-6 wrap-anywhere">{task.prompt}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{task.model.name}</span><span aria-hidden>·</span><span>{task.options.aspectRatio ?? "1:1"}</span>
        {task.options.size ? <><span aria-hidden>·</span><span>{task.options.size}</span></> : null}
        <span aria-hidden>·</span><time dateTime={new Date(task.createdAt).toISOString()}>{time}</time>
        {task.status !== "succeeded" ? <span className={cn("ml-1", task.status === "failed" ? "text-destructive" : "text-foreground")}>{t(`status.${task.status}`)}</span> : null}
      </div>
      {task.references.length ? <div className="flex flex-wrap gap-1.5 pt-1">{task.references.map((reference, index) => <img key={reference.path} src={inlineSrc({ ref: reference.path })} alt={t("composer.referenceNumber", { number: index + 1 })} loading="lazy" decoding="async" className="size-10 rounded-md border border-border object-cover" />)}</div> : null}
    </div>
    <ImageResultsGrid task={task} onPreview={(images, index) => onPreview({ ...task, images }, index)} />
    {task.text ? <p className="text-sm leading-6 whitespace-pre-wrap wrap-anywhere">{task.text}</p> : null}
    {task.error ? <p role="alert" className="max-w-2xl text-sm leading-5 text-destructive wrap-anywhere">{task.error}</p> : null}
    <div data-image-task-actions className="pointer-events-none flex items-center gap-1 opacity-0 transition-opacity group-hover/image-task:pointer-events-auto group-hover/image-task:opacity-100 group-focus-within/image-task:pointer-events-auto group-focus-within/image-task:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100">
      {actions.map((action) => <Tooltip key={action.id}>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={action.label} onClick={action.onClick} />}><HugeiconsIcon icon={action.icon} /></TooltipTrigger>
        <TooltipContent>{action.label}</TooltipContent>
      </Tooltip>)}
    </div>
  </article>;
});
