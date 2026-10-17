export type ProviderTestError = "auth" | "protocol" | "rate-limit" | "network" | "timeout" | "model" | "unknown";
export type ProviderTestResult = {
  model: string;
  api: string;
  status: "passed" | "partial" | "failed";
  firstTokenMs?: number;
  elapsedMs: number;
  tools: "passed" | "unconfirmed" | "failed" | "not-tested";
  errorCode?: ProviderTestError;
};
