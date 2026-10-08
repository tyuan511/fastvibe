import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveConfigValue } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";
import { escapePiConfigSecret, writePiAgentConfig, type PiSyncRequest } from "../src/main/engine/pi-global-sync.ts";

/**
 * Syncing into the global pi directory is a merge, not a takeover: a provider the
 * CLI already has and FastVibe does not must survive, and a secret must come back
 * out of pi's config parser as the same string. A leading `!` is otherwise a shell
 * command, which is the failure this file exists to keep from shipping.
 */

function agentDir(): string {
  return mkdtempSync(join(tmpdir(), "fv-pi-sync-"));
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
}

const custom = (apiKey: string) => ({
  id: "custom-demo",
  kind: "custom" as const,
  models: {
    name: "Demo",
    baseUrl: "https://example.test/v1",
    api: "openai-completions",
    apiKey,
    authHeader: true,
    models: [{ id: "m1", name: "M", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100 }],
  },
});

test("a secret round-trips through pi's config parser", () => {
  for (const secret of ["sk-plain", "sk-$HOME", "sk-${HOME}", "!echo pwned", "$!already", ""]) {
    if (!secret) continue;
    assert.equal(resolveConfigValue(escapePiConfigSecret(secret), {}), secret);
  }
  // The unescaped form is the bug: pi would run it.
  assert.equal(resolveConfigValue("!echo pwned", {}), "pwned");
});

test("custom providers replace the same id and keep the ones pi already had", () => {
  const dir = agentDir();
  writeJson(dir, "models.json", {
    providers: {
      yunwu: { baseUrl: "https://yunwu.test", apiKey: "keep-me", models: [{ id: "haiku" }] },
      "custom-demo": { name: "Old", apiKey: "old-key", models: [{ id: "gone" }] },
    },
  });
  writeJson(dir, "settings.json", { theme: "dark", packages: ["some-extension"], lastChangelogVersion: "1.1.0" });

  const request: PiSyncRequest = {
    providers: [custom("sk-$HOME")],
    skipped: ["未连接"],
    defaultModel: { provider: "custom-demo", id: "m1" },
    thinkingLevel: "high",
    autoCompact: false,
    mcp: [],
  };
  const report = writePiAgentConfig(dir, request);
  assert.equal(report.unchanged, false);
  assert.ok(report.backupDir);
  assert.deepEqual(report.providersWritten, ["custom-demo"]);
  assert.deepEqual(report.providersKept, ["yunwu"]);
  assert.deepEqual(report.providersSkipped, ["未连接"]);
  assert.deepEqual(report.settingsUpdated.sort(), ["compaction.enabled", "defaultModel", "defaultProvider", "defaultThinkingLevel"].sort());

  const models = readJson(dir, "models.json");
  const providers = models.providers as Record<string, { apiKey?: string; name?: string }>;
  assert.equal(providers.yunwu?.apiKey, "keep-me");
  assert.equal(resolveConfigValue(providers["custom-demo"]?.apiKey ?? "", {}), "sk-$HOME");
  assert.equal(providers["custom-demo"]?.name, "Demo");

  const settings = readJson(dir, "settings.json");
  assert.equal(settings.theme, "dark");
  assert.deepEqual(settings.packages, ["some-extension"]);
  assert.equal(settings.lastChangelogVersion, "1.1.0");
  assert.equal(settings.defaultProvider, "custom-demo");
  assert.equal(settings.defaultModel, "m1");
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.equal((settings.compaction as { enabled: boolean }).enabled, false);

  const backedUp = JSON.parse(readFileSync(join(report.backupDir!, "models.json"), "utf8")) as {
    providers: Record<string, { apiKey?: string }>;
  };
  assert.equal(backedUp.providers["custom-demo"]?.apiKey, "old-key");
  assert.equal(statSync(join(dir, "models.json")).mode & 0o777, 0o600);
});

test("a native provider's key goes to auth.json and does not clobber the CLI entry", () => {
  const dir = agentDir();
  writeJson(dir, "models.json", { providers: { deepseek: { apiKey: "$KEY", models: [{ id: "chat" }] } } });
  writeJson(dir, "auth.json", { other: { type: "api_key", key: "leave-me" } });

  const report = writePiAgentConfig(dir, {
    providers: [{
      id: "deepseek",
      kind: "native",
      models: { modelOverrides: { chat: { name: "Chat" } } },
      credential: { type: "api_key", key: "!echo pwned" },
    }],
    skipped: [],
    mcp: [],
  });
  assert.deepEqual(report.authWritten, ["deepseek"]);
  assert.deepEqual(report.providersWritten, ["deepseek"]);

  const models = readJson(dir, "models.json");
  const deepseek = (models.providers as Record<string, { apiKey: string; modelOverrides: unknown }>).deepseek!;
  assert.equal(deepseek.apiKey, "$KEY");
  assert.deepEqual(deepseek.modelOverrides, { chat: { name: "Chat" } });

  const auth = readJson(dir, "auth.json");
  assert.equal((auth.other as { key: string }).key, "leave-me");
  const stored = auth.deepseek as { type: string; key: string };
  assert.equal(stored.type, "api_key");
  assert.equal(resolveConfigValue(stored.key, {}), "!echo pwned");

  // A second sync must not escape the CLI's existing `$KEY` a second time.
  const again = writePiAgentConfig(dir, {
    providers: [{
      id: "deepseek",
      kind: "native",
      models: { modelOverrides: { chat: { name: "Chat" } } },
      credential: { type: "api_key", key: "!echo pwned" },
    }],
    skipped: [],
    mcp: [],
  });
  assert.equal(again.unchanged, true);
  assert.equal(again.backupDir, undefined);
  assert.equal((readJson(dir, "models.json").providers as Record<string, { apiKey: string }>).deepseek?.apiKey, "$KEY");
});

test("an oauth credential is stored in pi's flat auth file", () => {
  const dir = agentDir();
  const report = writePiAgentConfig(dir, {
    providers: [{
      id: "anthropic",
      kind: "native",
      credential: { type: "oauth", access: "a", refresh: "r", expires: 10 },
    }],
    skipped: [],
    defaultModel: { provider: "anthropic", id: "claude" },
    mcp: [],
  });
  assert.deepEqual(report.authWritten, ["anthropic"]);
  assert.deepEqual(report.settingsUpdated.sort(), ["defaultModel", "defaultProvider"].sort());
  assert.equal(readJson(dir, "auth.json").anthropic && (readJson(dir, "auth.json").anthropic as { type: string }).type, "oauth");
  assert.equal(existsSyncModels(dir), false);
});

test("a default model whose provider was not synced is left alone", () => {
  const dir = agentDir();
  writeJson(dir, "settings.json", { defaultProvider: "yunwu", defaultModel: "haiku", theme: "dark" });
  const report = writePiAgentConfig(dir, {
    providers: [],
    skipped: [],
    defaultModel: { provider: "missing", id: "nope" },
    thinkingLevel: "auto",
    autoCompact: true,
    mcp: [],
  });
  assert.equal(report.unchanged, true);
  assert.equal(readJson(dir, "settings.json").defaultProvider, "yunwu");
});

test("replace drops providers, credentials and MCP servers that exist only in pi", () => {
  const dir = agentDir();
  writeJson(dir, "models.json", {
    providers: {
      yunwu: { apiKey: "keep-me", models: [{ id: "haiku" }] },
      "custom-demo": { name: "Old", apiKey: "old-key", models: [{ id: "gone" }] },
    },
  });
  writeJson(dir, "auth.json", { other: { type: "api_key", key: "leave-me" } });
  writeJson(dir, "mcp.json", { mcpServers: { docs: { url: "https://docs.example/mcp" } } });

  const report = writePiAgentConfig(dir, {
    providers: [{
      ...custom("sk-plain"),
      credential: { type: "api_key", key: "sk-plain" },
    }],
    skipped: [],
    mcp: [{ name: "fs", id: "fs", enabled: true, transport: "stdio", command: "npx" }],
    mode: "replace",
  });
  assert.equal(report.unchanged, false);
  assert.deepEqual(report.providersKept, []);
  assert.deepEqual(report.mcpKept, []);
  const providers = readJson(dir, "models.json").providers as Record<string, unknown>;
  assert.equal(providers.yunwu, undefined);
  assert.equal(typeof providers["custom-demo"], "object");
  const auth = readJson(dir, "auth.json");
  assert.equal(auth.other, undefined);
  assert.equal((auth["custom-demo"] as { type: string }).type, "api_key");
  const servers = readJson(dir, "mcp.json").mcpServers as Record<string, unknown>;
  assert.equal(servers.docs, undefined);
  assert.equal(typeof servers.fs, "object");
});

test("mcp servers are translated, and pi-only servers stay", () => {
  const dir = agentDir();
  writeJson(dir, "mcp.json", {
    autoEnableCodemode: false,
    mcpServers: { docs: { url: "https://docs.example/mcp" } },
  });
  const report = writePiAgentConfig(dir, {
    providers: [],
    skipped: [],
    mcp: [
      { name: "文件系统", id: "fs_local", enabled: true, transport: "stdio", command: "npx", args: ["srv"], env: { TOKEN: "a$b" } },
      { name: "fs_local", id: "other", enabled: false, transport: "stdio", command: "npx" },
      { name: "broken", id: "broken", enabled: true, transport: "http", url: "not a url" },
    ],
  });
  assert.deepEqual(report.mcpWritten, ["fs_local", "fs_local-2"]);
  assert.deepEqual(report.mcpKept, ["docs"]);
  assert.deepEqual(report.mcpSkipped, ["broken"]);
  const mcp = readJson(dir, "mcp.json");
  assert.equal(mcp.autoEnableCodemode, false);
  const servers = mcp.mcpServers as Record<string, { command?: string; enabled?: boolean; env?: Record<string, string>; url?: string }>;
  assert.equal(servers.docs?.url, "https://docs.example/mcp");
  assert.equal(resolveConfigValue(servers.fs_local?.env?.TOKEN ?? "", {}), "a$b");
  assert.equal(servers["fs_local-2"]?.enabled, false);
  assert.equal(statSync(join(dir, "mcp.json")).mode & 0o777, 0o600);
});

test("a file that is not valid JSON stops the sync before anything is written", () => {
  const dir = agentDir();
  writeFileSync(join(dir, "models.json"), "{");
  writeJson(dir, "settings.json", { theme: "dark" });
  assert.throws(() => writePiAgentConfig(dir, {
    providers: [custom("sk")],
    skipped: [],
    defaultModel: { provider: "custom-demo", id: "m1" },
    autoCompact: false,
    mcp: [],
  }), /models\.json/);
  assert.equal(readFileSync(join(dir, "models.json"), "utf8"), "{");
  assert.equal(readJson(dir, "settings.json").theme, "dark");
  assert.equal(readJson(dir, "settings.json").defaultModel, undefined);
});

test("refuses to write into FastVibe's own agent directory", () => {
  const dir = agentDir();
  assert.throws(() => writePiAgentConfig(dir, { providers: [], skipped: [], mcp: [] }, dir), /runtime|运行目录/);
});

function existsSyncModels(dir: string): boolean {
  try {
    readFileSync(join(dir, "models.json"));
    return true;
  } catch {
    return false;
  }
}
