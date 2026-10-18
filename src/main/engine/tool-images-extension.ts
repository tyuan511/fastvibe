import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { prepareRequestToolImages } from "./context-images.ts";
import {
  locateToolImage,
  referenceToolResultImages,
  resolveToolImageRef,
  shrinkToolResultImages,
  type ImageResizer,
  type ToolImageReader,
} from "./tool-images.ts";

/**
 * `fastvibe-tool-images`, the hidden extension every conversation loads: what becomes of a
 * picture a tool returns.
 *
 * As the result arrives the full-size picture is saved for the chat to show, a smaller copy is
 * made for the model (`shrinkToolResultImages`) and written beside it, and the history keeps a
 * reference to that copy instead of its bytes (`referenceToolResultImages`). Before each request
 * the newest pictures, within `MAX_KEPT_IMAGE_CHARS`, are read back into the images the model
 * sees and the rest are left out with a note naming their file (`prepareRequestToolImages`).
 * Kept in its own module so `test/tool-images-session.test.ts` runs this very wiring on the SDK.
 */
export function toolImagesExtension(options: {
  dir: string;
  conversationId: string;
  resize: ImageResizer;
  reader: ToolImageReader;
}): ExtensionFactory {
  const { dir, conversationId, resize, reader } = options;
  return (pi) => {
    pi.on("tool_result", async (event) => {
      const shrunk = await shrinkToolResultImages(event.content, dir, conversationId, event.toolCallId, resize);
      const content = referenceToolResultImages(shrunk ?? event.content, dir, conversationId, event.toolCallId) ?? shrunk;
      return content ? { content: content as unknown as typeof event.content } : undefined;
    });
    pi.on("context", async (event) => {
      const prepared = await prepareRequestToolImages(event.messages, {
        locate: (message, index, block) => locateToolImage(dir, conversationId, String(message.toolCallId ?? ""), index, block),
        load: (ref) => reader.read(resolveToolImageRef(dir, conversationId, ref)),
      });
      return prepared === event.messages ? undefined : { messages: prepared as typeof event.messages };
    });
  };
}
