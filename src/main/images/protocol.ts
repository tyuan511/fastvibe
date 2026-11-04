import { hasFixedImageSizes, IMAGE_ASPECT_RATIOS, imageDimensions, parseImageSize } from "../../shared/image-options.ts";
import type { ImageModel, ImageOptions } from "../../shared/image-generation.ts";
import { uiText } from "../engine/ui-text.ts";
import { assertActive, decodeImage, inspectImage, MAX_IMAGE_BYTES, readBounded, type ImageBytes, type PreparedReference } from "./assets.ts";

export type ImageProtocolRequest = {
  model: ImageModel;
  key: string;
  prompt: string;
  options: ImageOptions;
  references: PreparedReference[];
  signal: AbortSignal;
  fetch: typeof fetch;
};
export type ImageProtocolResult = { image: ImageBytes; text?: string };
type Json = Record<string, unknown>;
const JSON_LIMIT = 40 * 1024 * 1024;

/** One image per call, so independent outputs can publish as soon as each is ready. */
export async function generateProtocolImage(input: ImageProtocolRequest): Promise<ImageProtocolResult> {
  const { model, key, prompt, options, references, signal } = input;
  assertActive(signal);
  let url: string;
  let body: BodyInit;
  let headers: Record<string, string>;
  if (model.protocol === "gemini") {
    const root = model.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "/v1beta");
    const base = /\/v1(?:beta)?$/.test(root) ? root : `${root}/v1beta`;
    url = `${base}/models/${encodeURIComponent(model.model.replace(/^models\//, ""))}:generateContent`;
    headers = { "Content-Type": "application/json", "x-goog-api-key": key };
    const imageConfig: Json = {};
    if (options.aspectRatio && options.aspectRatio !== "auto") imageConfig.aspectRatio = options.aspectRatio;
    if (options.size && options.size !== "auto") imageConfig.imageSize = options.size;
    body = JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: prompt },
        ...references.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.bytes.toString("base64") } })),
      ] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
    });
  } else if (model.protocol === "openai" && references.length > 0) {
    url = `${model.baseUrl}/images/edits`;
    headers = { Authorization: `Bearer ${key}` };
    const form = new FormData();
    form.set("model", model.model); form.set("prompt", prompt); form.set("n", "1");
    const size = openAiSize(options, model);
    if (size) form.set("size", size);
    if (options.quality && options.quality !== "auto") form.set("quality", options.quality);
    for (const [index, image] of references.entries()) {
      form.append(references.length === 1 ? "image" : "image[]", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `reference-${index + 1}.${image.mimeType.split("/")[1]}`);
    }
    body = form;
  } else {
    const grok = model.protocol === "grok";
    url = `${model.baseUrl}/images/${references.length ? "edits" : "generations"}`;
    headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const payload: Json = { model: model.model, prompt, n: 1 };
    if (grok) {
      payload.response_format = "b64_json";
      if (options.aspectRatio && options.aspectRatio !== "auto") payload.aspect_ratio = options.aspectRatio;
      if (options.size && options.size !== "auto") payload.resolution = options.size.toLowerCase();
      if (references.length === 1) payload.image = { url: dataUri(references[0]!) };
      if (references.length > 1) payload.images = references.map((image) => ({ url: dataUri(image) }));
    } else {
      const size = openAiSize(options, model);
      if (size) payload.size = size;
      if (options.quality && options.quality !== "auto") payload.quality = options.quality;
    }
    body = JSON.stringify(payload);
  }
  const response = await input.fetch(url, { method: "POST", headers, body, signal, redirect: "error" });
  assertActive(signal);
  const bytes = await readBounded(response, response.ok ? JSON_LIMIT : 64 * 1024, signal);
  let parsed: Json;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JSON object");
    parsed = value as Json;
  }
  catch {
    throw new Error(uiText(`图片服务返回了无法识别的响应（HTTP ${response.status}）。`, `The image service returned an unreadable response (HTTP ${response.status}).`));
  }
  if (!response.ok) {
    const error = object(parsed.error);
    const detail = typeof error.message === "string" ? error.message : typeof parsed.message === "string" ? parsed.message : "";
    const safe = redact(detail, key).slice(0, 500);
    throw new Error(uiText(`图片生成失败（HTTP ${response.status}）${safe ? `：${safe}` : "。"}`, `Image generation failed (HTTP ${response.status})${safe ? `: ${safe}` : "."}`));
  }
  if (model.protocol === "gemini") {
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const texts: string[] = [];
    let image: ImageBytes | undefined;
    for (const candidate of candidates) {
      const parts = object(object(candidate).content).parts;
      if (!Array.isArray(parts)) continue;
      for (const item of parts) {
        const part = object(item);
        // Thinking preview images are not deliverables.
        if (part.thought === true) continue;
        if (typeof part.text === "string") texts.push(part.text);
        const inline = object(part.inlineData ?? part.inline_data);
        if (!image && typeof inline.data === "string") image = decodeImage(inline.data, String(inline.mimeType ?? inline.mime_type ?? ""));
      }
    }
    if (!image) {
      const reason = object(parsed.promptFeedback).blockReason;
      const finish = object(candidates[0]).finishReason;
      throw new Error(uiText(`服务未返回图片${reason || finish ? `（${String(reason ?? finish).slice(0, 100)}）` : ""}。`, `The service returned no image${reason || finish ? ` (${String(reason ?? finish).slice(0, 100)})` : ""}.`));
    }
    return { image, ...(texts.length ? { text: texts.join("\n").slice(0, 12_000) } : {}) };
  }
  const data = Array.isArray(parsed.data) ? parsed.data : [];
  const first = object(data[0]);
  if (typeof first.b64_json === "string") return { image: decodeImage(first.b64_json), ...(typeof first.revised_prompt === "string" ? { text: first.revised_prompt.slice(0, 12_000) } : {}) };
  if (typeof first.url === "string") {
    if (first.url.startsWith("data:")) {
      const match = /^data:(image\/[a-zA-Z+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(first.url);
      if (match) return { image: decodeImage(match[2], match[1]) };
    }
    let imageUrl: URL;
    try { imageUrl = new URL(first.url); } catch { throw new Error(uiText("图片下载地址无效。", "Invalid image download URL.")); }
    if (!["http:", "https:"].includes(imageUrl.protocol) || imageUrl.username || imageUrl.password) throw new Error(uiText("图片下载地址无效。", "Invalid image download URL."));
    // Do not forward the model credential to an image CDN, including after redirects.
    const downloaded = await input.fetch(imageUrl.toString(), { signal, redirect: "error" });
    if (!downloaded.ok) {
      await downloaded.body?.cancel().catch(() => undefined);
      throw new Error(uiText(`图片下载失败（HTTP ${downloaded.status}）。`, `Image download failed (HTTP ${downloaded.status}).`));
    }
    const content = await readBounded(downloaded, MAX_IMAGE_BYTES, signal);
    return { image: inspectImage(content, downloaded.headers.get("content-type") ?? undefined) };
  }
  throw new Error(uiText("服务未返回图片。", "The service returned no image."));
}

function dataUri(image: PreparedReference): string { return `data:${image.mimeType};base64,${image.bytes.toString("base64")}`; }
function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
export function normalizeOpenAiOptions(options: ImageOptions, model?: ImageModel): ImageOptions {
  const customSizes = model && !hasFixedImageSizes(model);
  if (customSizes) {
    const ratio = options.aspectRatio;
    if (ratio && ratio !== "auto" && !IMAGE_ASPECT_RATIOS.includes(ratio as (typeof IMAGE_ASPECT_RATIOS)[number])) {
      throw new Error(uiText("请选择有效的图片比例。", "Choose a valid image aspect ratio."));
    }
    if (!options.size || options.size === "auto") return options;
    const dimensions = parseImageSize(options.size);
    if (!dimensions) throw new Error(uiText("图片尺寸须为宽x高。", "Image size must use widthxheight."));
    const { width, height } = dimensions;
    const pixels = width * height;
    if (width % 16 || height % 16 || Math.max(width, height) > 3840 || Math.max(width / height, height / width) > 3 || pixels < 655360 || pixels > 8294400) {
      throw new Error(uiText("图片宽高须为 16 的倍数，最长边不超过 3840，比例不超过 3:1，总像素为 655360–8294400。", "Image dimensions must be multiples of 16, with a maximum edge of 3840, a maximum aspect ratio of 3:1 and 655360–8294400 total pixels."));
    }
    // Presets and linked fields align to 16px, so allow one alignment step of rounding.
    if (ratio && ratio !== "auto") {
      const [w, h] = ratio.split(":").map(Number);
      if (Math.min(Math.abs(width - height * w / h), Math.abs(height - width * h / w)) > 16) {
        throw new Error(uiText("图片尺寸与所选比例不一致，请调整尺寸或比例。", "The image size does not match the selected aspect ratio. Adjust the size or ratio."));
      }
      return options;
    }
    const inferred = IMAGE_ASPECT_RATIOS.find((value) => { const [w, h] = value.split(":").map(Number); return Math.abs(width / height - w / h) < 0.02; });
    return { ...options, ...(inferred ? { aspectRatio: inferred } : {}) };
  }
  const ratio = options.aspectRatio;
  if (ratio && !["auto", "1:1", "3:2", "2:3"].includes(ratio)) {
    throw new Error(uiText("OpenAI 图片仅支持 auto、1:1、3:2 或 2:3 比例，请重新选择。", "OpenAI images support only auto, 1:1, 3:2 or 2:3 aspect ratios. Choose another ratio."));
  }
  if (!options.size || options.size === "auto") return options;
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(options.size);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  const actualRatio = width === height ? "1:1" : width * 2 === height * 3 ? "3:2" : width * 3 === height * 2 ? "2:3" : undefined;
  if (!match || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !actualRatio) {
    throw new Error(uiText("OpenAI 图片尺寸须为宽x高，且比例为 1:1、3:2 或 2:3。", "OpenAI image sizes must use widthxheight with a 1:1, 3:2 or 2:3 aspect ratio."));
  }
  if (ratio && ratio !== "auto" && ratio !== actualRatio) {
    throw new Error(uiText("图片尺寸与所选比例不一致，请调整尺寸或比例。", "The image size does not match the selected aspect ratio. Adjust the size or ratio."));
  }
  return { ...options, aspectRatio: actualRatio };
}

function openAiSize(options: ImageOptions, model: ImageModel): string | undefined {
  const normalized = normalizeOpenAiOptions(options, model);
  if (normalized.size && normalized.size !== "auto") return normalized.size;
  if (normalized.aspectRatio === "1:1") return "1024x1024";
  if (normalized.aspectRatio === "3:2") return "1536x1024";
  if (normalized.aspectRatio === "2:3") return "1024x1536";
  if (normalized.aspectRatio && normalized.aspectRatio !== "auto" && !hasFixedImageSizes(model)) {
    const { width, height } = imageDimensions(normalized.aspectRatio, "1K");
    return `${width}x${height}`;
  }
  return undefined;
}

export function redact(value: string, key: string): string {
  return (key ? value.split(key).join("[REDACTED]") : value).replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]");
}
