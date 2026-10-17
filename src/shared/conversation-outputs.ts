import type { ChatMessage } from "./types";
import { collectInlinePreviews } from "./inline-media.ts";

export type ConversationOutput = { path: string; entryId: string; touchedAt: number; title?: string };

/** Derive outputs from successful tools, preserving the most recent producing message.
 * Paths are resolved by the caller, including the owning host for SSH conversations. */
export function conversationOutputs(messages: readonly ChatMessage[], resolve: (path: string) => string): ConversationOutput[] {
  const files = new Map<string, ConversationOutput>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const add = (path: string, title?: string): void => {
      if (!path || /^(https?:|data:)/i.test(path)) return;
      const resolved = resolve(path);
      files.set(resolved, { path: resolved, entryId: message.id, touchedAt: message.createdAt, title });
    };
    for (const tool of message.tools) {
      if (tool.status !== "done" || !/^(write|write_file|writefile|create_file|createfile|create|edit|edit_file|editfile|str_replace|strreplace)$/i.test(tool.name)) continue;
      const args = tool.args;
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      for (const key of ["path", "file_path", "filePath", "filename", "file", "target_file", "target"]) {
        const value = (args as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim()) { add(value); break; }
      }
    }
    for (const previews of collectInlinePreviews(message.tools).values()) {
      for (const preview of previews) if (preview.explicit) add(preview.ref, preview.title);
    }
  }
  return [...files.values()].sort((a, b) => b.touchedAt - a.touchedAt || a.path.localeCompare(b.path));
}
