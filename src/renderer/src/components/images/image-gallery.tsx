import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { GeneratedImage, ImageTask } from "@shared/image-generation";
import type { InlinePreview } from "@shared/inline-media";
import { Button } from "@/components/ui/button";
import { Viewer } from "@/components/chat/inline-preview";

/** Generated images share the transcript's full-screen viewer and navigation. */
export function ImageGallery({ task, index, onIndex, onClose, onUseReference }: {
  task: Pick<ImageTask, "prompt" | "images">;
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onUseReference?: (image: GeneratedImage) => void;
}): JSX.Element | null {
  const { t } = useTranslation("images");
  const current = task.images[index];
  if (!current) return null;
  const items: InlinePreview[] = task.images.map((image) => ({ key: image.id, kind: "image", ref: image.path, title: task.prompt, explicit: true }));
  return <Viewer items={items} index={index} onIndex={onIndex} onClose={onClose} sidePreview={false}
    extraActions={onUseReference ? <Button type="button" size="sm" variant="ghost" className="text-white hover:bg-white/15 hover:text-white" onClick={() => onUseReference(current)}>{t("gallery.useReference")}</Button> : undefined}
  />;
}
