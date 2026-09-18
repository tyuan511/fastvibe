import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { RemoteHostProfile } from "@shared/remote-host";

export type SshConfigHost = RemoteHostProfile & {
  source: "config";
};

type Draft = {
  aliases: string[];
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
};

/**
 * Read the useful, host-like entries from OpenSSH config without invoking ssh.
 *
 * This intentionally handles the portable subset a GUI can present safely. Host
 * aliases containing wildcards or negation are patterns, not destinations, and are
 * omitted. OpenSSH still receives the alias when a tunnel starts, so ProxyJump and
 * other options in the user's config continue to work.
 */
export function readSshConfig(file = join(homedir(), ".ssh", "config")): SshConfigHost[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+)\s+(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = stripQuotes(match[2]);
    if (key === "host") {
      const aliases = value.split(/\s+/).filter((item) => item && !/[*!?]/.test(item));
      current = aliases.length > 0 ? { aliases } : null;
      if (current) drafts.push(current);
      continue;
    }
    if (!current) continue;
    if (key === "hostname" && value) current.hostName = value;
    else if (key === "user" && value) current.user = value;
    else if (key === "port" && /^\d+$/.test(value)) {
      const port = Number(value);
      if (port >= 1 && port <= 65_535) current.port = port;
    } else if (key === "identityfile" && value && !value.startsWith("-") && !value.includes("%")) {
      current.identityFile = expandHome(value);
    }
  }

  const result: SshConfigHost[] = [];
  const seen = new Set<string>();
  for (const draft of drafts) {
    for (const alias of draft.aliases) {
      const id = `ssh:${alias}`;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        label: alias,
        host: alias,
        hostName: draft.hostName,
        source: "config",
        user: draft.user,
        port: draft.port,
        identityFile: draft.identityFile,
      });
    }
  }
  return result;
}

function stripQuotes(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2").trim();
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : value;
}
