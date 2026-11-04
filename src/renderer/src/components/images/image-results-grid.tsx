import { memo, useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Image01Icon } from "@hugeicons/core-free-icons";
import type { GeneratedImage, ImageTask } from "@shared/image-generation";
import { inlineSrc } from "@shared/inline-media";
import { cn } from "@/lib/utils";
import { ImageParticles } from "./image-particles";

export type ImageResultTask = Pick<ImageTask, "id" | "prompt" | "options" | "status" | "images">;

export function imageAspectRatio(task: Pick<ImageTask, "options">): string {
  const ratio = task.options.aspectRatio?.split(":").map(Number);
  if (ratio?.length === 2 && ratio.every((n) => Number.isFinite(n) && n > 0)) return `${ratio[0]} / ${ratio[1]}`;
  const dimensions = task.options.size?.split("x").map(Number);
  return dimensions?.length === 2 && dimensions.every((n) => Number.isFinite(n) && n > 0) ? `${dimensions[0]} / ${dimensions[1]}` : "1 / 1";
}

const GeneratedTile = memo(function GeneratedTile({ image, prompt, aspectRatio, onClick }: {
  image: GeneratedImage;
  prompt: string;
  aspectRatio: string;
  onClick: () => void;
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
  return <button type="button" onClick={onClick} aria-label={t("timeline.openImage")} className="group relative block w-full overflow-hidden rounded-xl bg-muted/40 outline-none ring-ring focus-visible:ring-2" style={{ aspectRatio }}>
    {!failed && particlesVisible ? <ImageParticles active={!loaded} seed={image.id.length} className={cn("transition-opacity duration-700 motion-reduce:transition-none", loaded && "opacity-0")} /> : null}
    <img src={inlineSrc({ ref: image.path })} alt={prompt} loading="lazy" decoding="async"
      className={cn("size-full object-contain transition-opacity duration-700 motion-reduce:transition-none", loaded ? "opacity-100" : "opacity-0")}
      onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
    {failed ? <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground"><HugeiconsIcon icon={Image01Icon} className="size-6" />{t("timeline.imageUnavailable")}</span> : null}
    <span className="absolute inset-0 rounded-xl ring-1 ring-inset ring-border/40" />
  </button>;
});

/** One grid owns result sizing, stable output slots and reveal animation in both surfaces. */
export const ImageResultsGrid = memo(function ImageResultsGrid({ task, onPreview }: {
  task: ImageResultTask;
  onPreview: (images: GeneratedImage[], index: number) => void;
}): JSX.Element {
  const { t } = useTranslation("images");
  const generating = task.status === "generating";
  const requestedCount = Number.isInteger(task.options.count) ? Math.min(Math.max(task.options.count!, 1), 4) : 1;
  const count = Math.max(Math.min(task.images.length, 4), requestedCount);
  const ratio = imageAspectRatio(task);
  const indexedImages = task.images.map((image, arrayIndex) => ({ image, index: image.index ?? arrayIndex })).toSorted((a, b) => a.index - b.index);
  const images = indexedImages.map(({ image }) => image);
  const renderImage = (image: GeneratedImage): JSX.Element => <GeneratedTile key={image.id} image={image} prompt={task.prompt} aspectRatio={ratio} onClick={() => onPreview(images, images.findIndex((item) => item.id === image.id))} />;
  return <div className="w-full min-w-0 @container/image-results">
    <div data-image-results className="grid grid-cols-2 gap-2 @min-[40rem]/image-results:grid-cols-4">
      {generating ? Array.from({ length: count }, (_, slot) => {
        const completed = indexedImages.find((item) => item.index === slot)?.image;
        return completed ? renderImage(completed) : <div key={`pending-${slot}`} role="img" aria-label={t("timeline.generatingImage")} className="relative overflow-hidden rounded-xl border border-border/50 bg-muted/20" style={{ aspectRatio: ratio }}>
          <ImageParticles seed={task.id.split("").reduce((sum, char) => sum + char.charCodeAt(0), slot * 23)} />
          <span className="absolute bottom-4 left-4 text-xs text-foreground/70">{t("timeline.creating")}</span>
        </div>;
      }) : images.map(renderImage)}
    </div>
  </div>;
});
