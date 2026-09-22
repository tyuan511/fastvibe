/**
 * Configuration shared from the desktop to an SSH Agent.
 *
 * Values are raw file contents rather than parsed objects on purpose: provider
 * credentials, OAuth refresh tokens and SDK-specific model fields must survive a
 * round trip without being normalised by the transport. The App Protocol is carried
 * over the SSH loopback tunnel, so this is an intentional credential transfer.
 */
export const AGENT_CONFIG_FILES = [
  "settings",
  "providers",
  "agentEnv",
  "oauth",
  "models",
  "modelsDev",
  "agentSettings",
  "mcp",
  "subagents",
] as const;

export type AgentConfigFile = (typeof AGENT_CONFIG_FILES)[number];
export type AgentConfigSnapshot = Partial<Record<AgentConfigFile, string | null>>;
export type AgentConfigSyncPayload = AgentConfigSnapshot & { syncToken?: string };
