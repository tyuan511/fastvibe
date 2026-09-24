import type { GatewayKind, NativeProviderConfig, ProviderApi, ProviderModel } from "@shared/types";

export const PROVIDER_API_ITEMS: Record<ProviderApi, string> = {
  "openai-completions": "OpenAI Chat Completions (/chat/completions)",
  "openai-responses": "OpenAI Responses (/responses)",
  "anthropic-messages": "Anthropic Messages (/v1/messages)",
  "google-generative-ai": "Google Gemini (/v1beta)",
};

/** Short label for a model's pinned protocol, where the row is too narrow for the full one. */
export const PROVIDER_API_SHORT: Record<ProviderApi, string> = {
  "openai-completions": "Chat Completions",
  "openai-responses": "Responses",
  "anthropic-messages": "Messages",
  "google-generative-ai": "Gemini",
};

/** `native` = a pi-coding-agent built-in provider configured with an API key or a login. */
export type AddMode = "native" | "custom";

export type AddState = {
  mode: AddMode;
  /** Chosen pi-coding-agent provider id when `mode === "native"`. */
  nativeId: string | null;
  name: string;
  baseUrl: string;
  api: ProviderApi;
  apiKey: string;
  /**
   * What `providers:probe-gateway` reported for the typed Base URL, if anything. Read
   * beside the model fetch and stored on the entry so 供应商详情 knows which balance
   * endpoint applies without probing again.
   */
  gateway?: GatewayKind;
  /**
   * Set once a subscription login for the chosen built-in succeeded. The entry can then
   * be created with no key at all, which is the only way to add a login-only built-in.
   */
  oauthDone: boolean;
  candidates: ProviderModel[] | null;
  selected: Set<string>;
  busy: boolean;
};

export type PickerState = {
  kind: "connect" | "models";
  providerId: string;
  apiKey?: string;
  candidates: ProviderModel[] | null;
  selected: Set<string>;
  busy: boolean;
};

export const EMPTY_ADD: AddState = {
  mode: "native",
  nativeId: null,
  name: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  oauthDone: false,
  candidates: null,
  selected: new Set(),
  busy: false,
};

export type { NativeProviderConfig };
