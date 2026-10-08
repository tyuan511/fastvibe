/** One host-side submission, with the send decision captured by the composer. */
export type SubmitPromptRequest = {
  conversationId: string;
  text: string;
  enqueue: boolean;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
};
