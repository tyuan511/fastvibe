export type TranscriptPageRequest = {
  conversationId: string;
  beforeEntryId: string;
  turnLimit?: number;
};

export type TranscriptPageInfo = { beforeEntryId: string | null };
