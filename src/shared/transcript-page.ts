/** `"summary"` asks for tool calls without their bodies (`shared/tool-summary.ts`). */
export type ToolDetailLevel = "summary";

export type TranscriptPageRequest = {
  conversationId: string;
  beforeEntryId: string;
  turnLimit?: number;
  toolDetail?: ToolDetailLevel;
};

export type TranscriptPageInfo = { beforeEntryId: string | null };
