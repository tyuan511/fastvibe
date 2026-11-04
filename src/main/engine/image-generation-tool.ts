import { isUsableImageModel } from "../../shared/image-model.ts";
import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { ImageGenerationService } from "../images/service";
import { uiText } from "./ui-text.ts";

/** Keep role allowlists intact when the optional factory registered no image tool. */
export function availableImageTools(tools: string[], registered: boolean): string[] {
  return tools.filter((name) => name !== "generate_image" || registered);
}

/** Shared by normal sessions and explicitly permitted delegated execution roles. */
export function imageGenerationExtension(service: ImageGenerationService, conversationId: string): ExtensionFactory {
  return async (pi) => {
    const config = await service.getConfig();
    const models = config.models.filter(isUsableImageModel);
    if (!models.length) return;
    pi.registerTool({
      name: "generate_image",
      label: "Generate image",
      description: `Generate or edit images. Available model IDs: ${models.map((model) => JSON.stringify(model.id)).join(", ")}. Omit model only when a default image model is configured; otherwise an explicit model ID is required. Each call runs independently and returns saved paths. Reference images are local file paths. Do not present the same files again. Cancellation stops only this task.`,
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1, maxLength: 32000 }),
        reference_images: Type.Optional(Type.Array(Type.String(), { maxItems: 1 })),
        aspect_ratio: Type.Optional(Type.String()),
        size: Type.Optional(Type.String()),
        quality: Type.Optional(Type.String()),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
        model: Type.Optional(Type.String()),
      }),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
        const current = await service.getConfig();
        if (!params.model && !current.defaultModelId) throw new Error(uiText("未设置默认图片模型，请显式指定 model。", "No default image model is configured. Specify model explicitly."));
        const task = await service.generate({
          requestId: `agent:${conversationId}:${toolCallId}`,
          sourceConversationId: conversationId,
          prompt: params.prompt,
          modelId: params.model,
          options: { aspectRatio: params.aspect_ratio, size: params.size, quality: params.quality, count: params.count },
          references: params.reference_images?.map((path) => ({ path: resolve(ctx.cwd, path) })),
        });
        const unsubscribe = service.subscribeTask(task.id, (progress) => {
          onUpdate?.({ content: [{ type: "text", text: uiText("正在生成图片…", "Generating images…") }], details: { taskId: progress.id, sessionId: progress.sessionId, task: progress } });
        });
        const cancel = (): void => { void service.cancel(task.id).catch(() => undefined); };
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          if (signal?.aborted) cancel();
          const result = await service.waitForTask(task.id);
          return {
            isError: result.status !== "succeeded",
            content: [{ type: "text", text: JSON.stringify({ taskId: result.id, sessionId: result.sessionId, status: result.status, images: result.images.map(({ path, mimeType, width, height }) => ({ path, mimeType, width, height })), ...(result.error ? { warning: result.error } : {}) }) }],
            details: { task: result, taskId: result.id, sessionId: result.sessionId, status: result.status, items: result.images.map((image) => ({ ref: image.path, ok: true })) },
          };
        } finally {
          unsubscribe();
          signal?.removeEventListener("abort", cancel);
        }
      },
    });
  };
}
