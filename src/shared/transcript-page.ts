/** `"summary"` asks for tool calls without their bodies (`shared/tool-summary.ts`). */
export type ToolDetailLevel = "summary";

export type TranscriptReadOptions = {
  /** Soft wire budget. A complete turn is never split to meet it. */
  maxBytes?: number;
  /** Long settled messages and inline pictures are fetched when displayed. */
  preview?: boolean;
};

export type TranscriptPageRequest = {
  conversationId: string;
  beforeEntryId: string;
  turnLimit?: number;
  toolDetail?: ToolDetailLevel;
  readOptions?: TranscriptReadOptions;
};

export type TranscriptPageInfo = { beforeEntryId: string | null };
