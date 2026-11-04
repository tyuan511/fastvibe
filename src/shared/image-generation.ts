/** Image generation is independent of the chat SDK's streaming model registry. */
export const IMAGE_PROTOCOLS = ["openai", "gemini", "grok"] as const;
export type ImageProtocol = (typeof IMAGE_PROTOCOLS)[number];
export type ImageOptions = {
  aspectRatio?: string;
  size?: string;
  quality?: string;
  count?: number;
};
export type ImageModel = {
  id: string;
  name: string;
  model: string;
  protocol: ImageProtocol;
  /** Owning entry in the unified provider/model catalog. */
  providerId?: string;
  baseUrl: string;
  enabled: boolean;
  hasKey: boolean;
};
export type ImageConfig = { models: ImageModel[]; defaultModelId?: string };
export type ImageReference = { path: string; name?: string };
export type ImageReferenceInput = ImageReference | { data: string; mimeType: string; name: string };
export type ImageSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  modelId?: string;
  options?: ImageOptions;
  sourceConversationId?: string;
};
export type GeneratedImage = {
  id: string;
  /** Stable zero-based output slot, including while other outputs are still pending. */
  index?: number;
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
};
export type ImageTaskStatus = "generating" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
export type ImageTask = {
  id: string;
  requestId: string;
  sessionId: string;
  createdAt: number;
  completedAt?: number;
  status: ImageTaskStatus;
  prompt: string;
  model: ImageModel;
  options: ImageOptions;
  references: ImageReference[];
  images: GeneratedImage[];
  error?: string;
  text?: string;
};
export type ImageGenerateRequest = {
  requestId: string;
  sessionId?: string;
  sourceConversationId?: string;
  prompt: string;
  modelId?: string;
  options?: ImageOptions;
  references?: ImageReferenceInput[];
};
export type ImageSnapshot = { revision: number; sessions: ImageSession[]; tasks: ImageTask[] };
export type ImagesChanged = { revision: number; sessionId?: string };
export type ImagesApi = {
  getConfig(): Promise<ImageConfig>;
  snapshot(sessionId?: string): Promise<ImageSnapshot>;
  createSession(title?: string): Promise<ImageSession>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  generate(request: ImageGenerateRequest): Promise<ImageTask>;
  cancel(taskId: string): Promise<void>;
  onChanged(listener: (event: ImagesChanged) => void): () => void;
};
