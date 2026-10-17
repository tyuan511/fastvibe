import type { ChatMessage } from "./types.ts";

/** Only opt-in readers receive previews. The source transcript is never changed. */
export function previewTranscript(messages: ChatMessage[], maxChars = 12_000, running = false): ChatMessage[] {
  let liveTail: string | undefined;
  if (running) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "assistant") { liveTail = messages[index].id; break; }
    }
  }
  return messages.map((message) => {
    if (message.id === liveTail || message.id.startsWith("running:") || message.tools.some((tool) => tool.status === "running")) return message;
    const largeText = message.text.length + (message.thinking?.length ?? 0) > maxChars
      || (message.parts?.reduce((size, part) => size + ("text" in part ? part.text.length : 0), 0) ?? 0) > maxChars;
    const inlineImages = message.attachments?.some((attachment) => attachment.dataUrl?.startsWith("data:"));
    if (!largeText && !inlineImages) return message;
    const text = largeText ? message.text.slice(-maxChars) : message.text;
    return {
      ...message,
      deferredContent: true,
      text,
      ...(largeText ? { thinking: undefined, parts: [{ kind: "text" as const, text }] } : {}),
      attachments: message.attachments?.map(({ dataUrl, ...attachment }) =>
        dataUrl?.startsWith("data:") ? attachment : { ...attachment, dataUrl }),
    };
  });
}
