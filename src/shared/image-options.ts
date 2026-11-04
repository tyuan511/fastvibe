import type { ImageModel, ImageOptions } from "./image-generation.ts";

export const IMAGE_ASPECT_RATIOS = ["1:1", "3:4", "16:9", "4:3", "9:16", "2:3", "3:2", "21:9"] as const;
export const LEGACY_IMAGE_RATIOS = ["1:1", "3:2", "2:3"] as const;
export const IMAGE_RESOLUTIONS = ["1K", "2K", "4K"] as const;
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];
export type ImageDimensions = { width: number; height: number };

/** Older GPT models have a fixed size enum; compatible/new models accept pixel dimensions. */
export function hasFixedImageSizes(model: Pick<ImageModel, "protocol" | "model">): boolean {
  return model.protocol === "openai" && /^(?:gpt-image-1(?:[.-]|$)|chatgpt-image-latest$|dall-e-)/i.test(model.model);
}

export function imageRatios(model?: Pick<ImageModel, "protocol" | "model">): readonly string[] {
  return model && hasFixedImageSizes(model) ? LEGACY_IMAGE_RATIOS : IMAGE_ASPECT_RATIOS;
}

export function imageResolutions(model?: Pick<ImageModel, "protocol" | "model">): readonly ImageResolution[] {
  if (model && hasFixedImageSizes(model)) return ["1K"];
  return model?.protocol === "grok" ? ["1K", "2K"] : IMAGE_RESOLUTIONS;
}

export function parseImageSize(size?: string): ImageDimensions | undefined {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(size ?? "");
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) ? { width, height } : undefined;
}

/** Presets target pixel area, then respect the GPT endpoint's edge and total-pixel ceilings. */
export function imageDimensions(ratio: string, resolution: ImageResolution): ImageDimensions {
  const [w, h] = ratio.split(":").map(Number);
  const aspect = w > 0 && h > 0 ? w / h : 1;
  const pixels = resolution === "4K" ? 8_294_400 : resolution === "2K" ? 4_194_304 : 1_048_576;
  const width = Math.sqrt(pixels * aspect);
  const height = Math.sqrt(pixels / aspect);
  const scale = Math.min(1, 3840 / Math.max(width, height));
  return { width: Math.floor(width * scale / 16) * 16, height: Math.floor(height * scale / 16) * 16 };
}

export function imageResolution(options: ImageOptions): ImageResolution {
  if (IMAGE_RESOLUTIONS.includes(options.size?.toUpperCase() as ImageResolution)) return options.size!.toUpperCase() as ImageResolution;
  const size = parseImageSize(options.size);
  if (!size) return "1K";
  return size.width * size.height > 4_194_304 ? "4K" : size.width * size.height > 1_572_864 ? "2K" : "1K";
}

export function imageOptionsForResolution(model: ImageModel | undefined, options: ImageOptions, ratio: string, resolution: ImageResolution): ImageOptions {
  if (model && hasFixedImageSizes(model)) {
    return { ...options, aspectRatio: ratio, size: ratio === "3:2" ? "1536x1024" : ratio === "2:3" ? "1024x1536" : "1024x1024" };
  }
  const { width, height } = imageDimensions(ratio, resolution);
  return { ...options, aspectRatio: ratio, size: model?.protocol === "openai" ? `${width}x${height}` : resolution };
}
