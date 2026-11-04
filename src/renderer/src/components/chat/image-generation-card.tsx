import { useState, type ReactNode, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Image01Icon } from "@hugeicons/core-free-icons";
import type { GeneratedImage } from "@shared/image-generation";
import type { ToolCallBlock } from "@shared/types";
import { ImageResultsGrid } from "@/components/images/image-results-grid";
import { ImageGallery } from "@/components/images/image-gallery";
import { imagePreviewFromTool } from "@/lib/image-tool";
import { ToolRow } from "./tool-row";

/** The studio and Agent transcript render the same stable output slots and animation. */
export function ImageGenerationCard({ tool, showIcon, children }: { tool: ToolCallBlock; showIcon: boolean; children: ReactNode }): JSX.Element {
  const { t } = useTranslation("images");
  const preview = imagePreviewFromTool(tool);
  const [gallery, setGallery] = useState<{ images: GeneratedImage[]; index: number } | null>(null);
  const running = tool.status === "running";
  return <div className="w-full min-w-0 space-y-2" data-image-generation-tool data-status={preview.status}>
    <ToolRow icon={<HugeiconsIcon icon={Image01Icon} className="size-3.5" />} label={t(running ? "status.generating" : "title")} subject={preview.prompt} title={preview.prompt} running={running} showIcon={showIcon} persistKey={tool.id} error={tool.status === "error" ? tool.result : undefined}>{children}</ToolRow>
    {preview.status === "generating" || preview.images.length ? <ImageResultsGrid task={preview} onPreview={(images, index) => setGallery({ images, index })} /> : null}
    {gallery ? <ImageGallery task={{ prompt: preview.prompt, images: gallery.images }} index={gallery.index} onIndex={(index) => setGallery((current) => current ? { ...current, index } : null)} onClose={() => setGallery(null)} /> : null}
  </div>;
}
