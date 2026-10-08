import type { ConnectionError, DisconnectDetail } from "./client.ts";

type Diagnostic = {
  event: "connecting" | "connected" | "disconnected" | "connect-failed" | "network" | "app-state" | "metric";
  serverId?: string;
  attempt?: number;
  elapsedMs?: number;
  appState?: string;
  networkType?: string;
  connected?: boolean;
  detail?: DisconnectDetail;
  failure?: ConnectionError["code"] | "restore-failed";
  metric?: "socket" | "auth" | "welcome" | "rtt" | "catalog" | "snapshot" | "history" | "submission" | "rpc" | "resume";
  frameChars?: number;
  outcome?: "ok" | "error" | "timeout" | "replay" | "snapshot";
};

const entries: Array<Diagnostic & { at: string }> = [];
const metrics = new Map<NonNullable<Diagnostic["metric"]>, Array<Diagnostic & { at: string }>>();

/** Current-run diagnostics only: never record tokens, URLs, passwords, or RPC payloads. */
export function recordConnectionDiagnostic(entry: Diagnostic): void {
  const sample = { ...entry, at: new Date().toISOString() };
  if (entry.event === "metric" && entry.metric) {
    const recent = metrics.get(entry.metric) ?? [];
    recent.push(sample);
    if (recent.length > 32) recent.shift();
    metrics.set(entry.metric, recent);
    return; // Frequent RPC samples must not evict disconnects and network changes.
  }
  entries.push(sample);
  if (entries.length > 100) entries.shift();
}

export function connectionDiagnostics(version: string): string {
  const timings = Object.fromEntries([...metrics].map(([metric, samples]) => {
    const durations = samples.flatMap((sample) => typeof sample.elapsedMs === "number" ? [sample.elapsedMs] : []).sort((a, b) => a - b);
    return [metric, {
      samples,
      ...(durations.length ? {
        p50Ms: durations[Math.ceil(durations.length * 0.5) - 1],
        p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
      } : {}),
    }];
  }));
  return JSON.stringify({ version, entries, timings }, null, 2);
}
