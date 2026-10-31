import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { McpServerConfig } from "../../shared/types.ts";
import { serverFromEntry } from "../../shared/mcp-config.ts";

export function readMcpFile(file: string): McpServerConfig[] {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { return []; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const root = value as Record<string, unknown>;
  const servers = root.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  const output: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    try {
      const parsed = serverFromEntry(name, entry, { lenient: true });
      if ("server" in parsed) output.push(parsed.server);
    } catch { /* one malformed server does not block the rest */ }
  }
  return output;
}

export function writeMcpFile(file: string, configs: McpServerConfig[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(configs, null, 2)}\n`, { mode: 0o600 });
}
