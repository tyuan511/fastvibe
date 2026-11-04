import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Link01Icon } from "@hugeicons/core-free-icons";
import type { ImageModel, ImageOptions } from "@shared/image-generation";
import { hasFixedImageSizes, imageDimensions, imageOptionsForResolution, imageRatios, imageResolution, imageResolutions, parseImageSize, type ImageResolution } from "@shared/image-options";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** A thin-stroke outline at the ratio's shape; compact in the trigger, larger in the menu. */
function RatioGlyph({ ratio, boxClassName = "size-4", maxRem = 0.875 }: { ratio: string; boxClassName?: string; maxRem?: number }): JSX.Element {
  const parts = ratio.split(":").map(Number);
  const [width, height] = parts.length === 2 && parts.every((value) => value > 0) ? parts : [1, 1];
  return <span className={`flex shrink-0 items-center justify-center ${boxClassName}`} aria-hidden><span className="rounded-[3px] border border-current" style={{ width: `${maxRem * Math.min(1, width / height)}rem`, height: `${maxRem * Math.min(1, height / width)}rem` }} /></span>;
}

/** Ratio, resolution and batch size stay together while the reader compares options. */
export function ImageOptionsPicker({ model, options, onChange }: {
  model?: ImageModel;
  options: ImageOptions;
  onChange: (options: ImageOptions) => void;
}): JSX.Element {
  const { t } = useTranslation("images");
  const ratio = options.aspectRatio ?? "1:1";
  const resolution = imageResolution(options);
  const dimensions = parseImageSize(options.size) ?? (model && hasFixedImageSizes(model)
    ? parseImageSize(imageOptionsForResolution(model, options, ratio, resolution).size)!
    : imageDimensions(ratio, resolution));
  const editable = model?.protocol === "openai" && !hasFixedImageSizes(model);
  const choose = (nextRatio: string, nextResolution: ImageResolution): void => onChange(imageOptionsForResolution(model, options, nextRatio, nextResolution));
  const changeDimension = (axis: "width" | "height", value: string): void => {
    const edge = Number(value);
    if (!Number.isFinite(edge) || edge < 16 || edge > 3840) return;
    const aligned = Math.round(edge / 16) * 16;
    const [w, h] = ratio.split(":").map(Number);
    const next = axis === "width" ? { width: aligned, height: Math.round(aligned * h / w / 16) * 16 } : { width: Math.round(aligned * w / h / 16) * 16, height: aligned };
    if (next.width < 16 || next.height < 16 || Math.max(next.width, next.height) > 3840) return;
    onChange({ ...options, size: `${next.width}x${next.height}` });
  };
  return <Popover>
    <PopoverTrigger render={<Button type="button" variant="ghost" className="border-transparent bg-muted/40 dark:bg-input/30 pr-2 pl-2.5 text-xs font-normal" aria-label={t("composer.imageOptions")} />}>{/* Same shape as the model Select: h-8 rounded-lg muted pill (dark: input/30), 16px chevron. */}
      <RatioGlyph ratio={ratio} /><span>{ratio}</span><span className="text-muted-foreground">·</span><span>{resolution}</span><span className="text-muted-foreground">·</span><span>{t("composer.countLabel", { count: options.count ?? 1 })}</span><HugeiconsIcon icon={ArrowDown01Icon} className="size-4 text-muted-foreground" />
    </PopoverTrigger>
    <PopoverContent side="top" align="start" className="max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] gap-3 overflow-y-auto rounded-xl border border-border p-3">
      <fieldset className="min-w-0 space-y-1.5"><legend className="text-xs text-muted-foreground">{t("composer.aspectRatio")}</legend>
        <div className="grid grid-cols-4 gap-1 rounded-xl bg-muted/60 p-1 sm:grid-cols-8">{imageRatios(model).map((value) => <Button key={value} type="button" variant="ghost" aria-pressed={ratio === value} className="h-auto flex-col gap-0.5 px-1 py-1.5 text-xs font-normal aria-pressed:bg-background aria-pressed:shadow-xs aria-pressed:ring-1 aria-pressed:ring-border" onClick={() => choose(value, resolution)}><RatioGlyph ratio={value} boxClassName="size-6" maxRem={1} />{value}</Button>)}</div>
      </fieldset>
      <fieldset className="space-y-1.5"><legend className="text-xs text-muted-foreground">{t("composer.size")}</legend>
        <div className="flex gap-1 rounded-xl bg-muted/60 p-1">{imageResolutions(model).map((value) => <Button key={value} type="button" variant="ghost" aria-pressed={resolution === value} className="h-7 flex-1 text-xs font-normal aria-pressed:bg-background aria-pressed:shadow-xs aria-pressed:ring-1 aria-pressed:ring-border" onClick={() => choose(ratio, value)}>{value}</Button>)}</div>
      </fieldset>
      <fieldset className="space-y-1.5"><legend className="text-xs text-muted-foreground">{t("composer.count")}</legend>
        <div className="flex gap-1 rounded-xl bg-muted/60 p-1">{[1, 2, 3, 4].map((count) => <Button key={count} type="button" variant="ghost" aria-pressed={(options.count ?? 1) === count} className="h-7 flex-1 text-xs font-normal aria-pressed:bg-background aria-pressed:shadow-xs aria-pressed:ring-1 aria-pressed:ring-border" onClick={() => onChange({ ...options, count })}>{count}</Button>)}</div>
      </fieldset>
      {model?.protocol === "openai" ? <fieldset className="space-y-1.5"><legend className="text-xs text-muted-foreground">{t("composer.dimensions")}</legend>
        <div className="flex items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2"><span className="text-xs text-muted-foreground">W</span><Input key={`w-${dimensions.width}`} type="number" min={16} max={3840} step={16} disabled={!editable} aria-label={t("composer.width")} defaultValue={dimensions.width} className="h-7 px-2 text-xs" onBlur={(event) => changeDimension("width", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
          <HugeiconsIcon icon={Link01Icon} className="size-4 shrink-0 text-muted-foreground" />
          <label className="flex min-w-0 flex-1 items-center gap-2"><span className="text-xs text-muted-foreground">H</span><Input key={`h-${dimensions.height}`} type="number" min={16} max={3840} step={16} disabled={!editable} aria-label={t("composer.height")} defaultValue={dimensions.height} className="h-7 px-2 text-xs" onBlur={(event) => changeDimension("height", event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
          <span className="text-xs text-muted-foreground">PX</span>
        </div>
        {editable ? <p className="text-xs text-muted-foreground">{t("composer.dimensionHint")}</p> : null}
      </fieldset> : null}
    </PopoverContent>
  </Popover>;
}
