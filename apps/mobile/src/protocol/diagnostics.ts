import type { ConnectionError, DisconnectDetail } from "./client.ts";

type Diagnostic = {
  event: "connecting" | "connected" | "disconnected" | "connect-failed" | "network" | "app-state";
  serverId?: string;
  attempt?: number;
  elapsedMs?: number;
  appState?: string;
  networkType?: string;
  connected?: boolean;
  detail?: DisconnectDetail;
  failure?: ConnectionError["code"] | "restore-failed";
};

const entries: Array<Diagnostic & { at: string }> = [];

/** Current-run diagnostics only: never record tokens, URLs, passwords, or RPC payloads. */
export function recordConnectionDiagnostic(entry: Diagnostic): void {
  entries.push({ ...entry, at: new Date().toISOString() });
  if (entries.length > 100) entries.shift();
}

export function connectionDiagnostics(version: string): string {
  return JSON.stringify({ version, entries }, null, 2);
}
