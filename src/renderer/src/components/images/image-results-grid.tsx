import { memo, useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Image01Icon, Link01Icon } from "@hugeicons/core-free-icons";
import type { GeneratedImage, ImageTask } from "@shared/image-generation";
import { inlineSrc } from "@shared/inline-media";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ImageParticles } from "./image-particles";

export type ImageResultTask = Pick<ImageTask, "id" | "prompt" | "options" | "status" | "images">;

export function imageAspectRatio(task: Pick<ImageTask, "options">): string {
  const ratio = task.options.aspectRatio?.split(":").map(Number);
  if (ratio?.length === 2 && ratio.every((n) => Number.isFinite(n) && n > 0)) return `${ratio[0]} / ${ratio[1]}`;
  const dimensions = task.options.size?.split("x").map(Number);
  return dimensions?.length === 2 && dimensions.every((n) => Number.isFinite(n) && n > 0) ? `${dimensions[0]} / ${dimensions[1]}` : "1 / 1";
}

const GeneratedTile = memo(function GeneratedTile({ image, prompt, aspectRatio, onClick, onUseReference }: {
  image: GeneratedImage;
  prompt: string;
  aspectRatio: string;
  onClick: () => void;
  onUseReference?: (image: GeneratedImage) => void;
}): JSX.Element {
  const { t } = useTranslation("images");
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [particlesVisible, setParticlesVisible] = useState(true);
  useEffect(() => {
    if (!loaded) return;
    const timeout = window.setTimeout(() => setParticlesVisible(false), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 720);
    return () => window.clearTimeout(timeout);
  }, [loaded]);
  const referenceLabel = t("timeline.useReference");
  return <div className="group relative w-full overflow-hidden rounded-xl bg-muted/40" style={{ aspectRatio }}>
    <button type="button" onClick={onClick} aria-label={t("timeline.openImage")} className="absolute inset-0 block size-full rounded-xl outline-none ring-ring focus-visible:ring-2">
      {!failed && particlesVisible ? <ImageParticles active={!loaded} className={cn("transition-opacity duration-700 motion-reduce:transition-none", loaded && "opacity-0")} /> : null}
      <img src={inlineSrc({ ref: image.path })} alt={prompt} loading="lazy" decoding="async"
        className={cn("size-full object-contain transition-opacity duration-700 motion-reduce:transition-none", loaded ? "opacity-100" : "opacity-0")}
        onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      {failed ? <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground"><HugeiconsIcon icon={Image01Icon} className="size-6" />{t("timeline.imageUnavailable")}</span> : null}
      <span className="absolute inset-0 rounded-xl ring-1 ring-inset ring-border/40" />
    </button>
    {onUseReference ? <Tooltip>
      <TooltipTrigger render={<button type="button" aria-label={referenceLabel} onClick={() => onUseReference(image)}
        className="absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-lg bg-black/55 text-white opacity-0 backdrop-blur-sm transition-opacity hover:bg-black/75 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none" />}>
        <HugeiconsIcon icon={Link01Icon} className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{referenceLabel}</TooltipContent>
    </Tooltip> : null}
  </div>;
});

/** One grid owns result sizing, stable output slots and reveal animation in both surfaces. */
export const ImageResultsGrid = memo(function ImageResultsGrid({ task, onPreview, onUseReference }: {
  task: ImageResultTask;
  onPreview: (images: GeneratedImage[], index: number) => void;
  onUseReference?: (image: GeneratedImage) => void;
}): JSX.Element {
  const { t } = useTranslation("images");
  const generating = task.status === "generating";
  const requestedCount = Number.isInteger(task.options.count) ? Math.min(Math.max(task.options.count!, 1), 4) : 1;
  const count = Math.max(Math.min(task.images.length, 4), requestedCount);
  const ratio = imageAspectRatio(task);
  const indexedImages = task.images.map((image, arrayIndex) => ({ image, index: image.index ?? arrayIndex })).toSorted((a, b) => a.index - b.index);
  const images = indexedImages.map(({ image }) => image);
  const renderImage = (image: GeneratedImage): JSX.Element => <GeneratedTile key={image.id} image={image} prompt={task.prompt} aspectRatio={ratio} onClick={() => onPreview(images, images.findIndex((item) => item.id === image.id))} onUseReference={onUseReference} />;
  return <div className="w-full min-w-0 @container/image-results">
    <div data-image-results className="grid grid-cols-2 gap-2 @min-[40rem]/image-results:grid-cols-4">
      {generating ? Array.from({ length: count }, (_, slot) => {
        const completed = indexedImages.find((item) => item.index === slot)?.image;
        return completed ? renderImage(completed) : <div key={`pending-${slot}`} role="img" aria-label={t("timeline.generatingImage")} className="relative overflow-hidden rounded-xl border border-border/50 bg-muted/60" style={{ aspectRatio: ratio }}>
          <ImageParticles />
        </div>;
      }) : images.map(renderImage)}
    </div>
  </div>;
});
