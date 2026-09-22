import { homedir } from "node:os";
import { globSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

type ParseState = {
  drafts: Draft[];
  current: Draft | null;
};

const MAX_INCLUDE_DEPTH = 32;

/**
 * Read the useful, host-like entries from OpenSSH config without invoking ssh.
 *
 * This intentionally handles the portable subset a GUI can present safely. Host
 * aliases containing wildcards or negation are patterns, not destinations, and are
 * omitted. OpenSSH still receives the alias when a tunnel starts, so ProxyJump and
 * other options in the user's config continue to work.
 */
export function readSshConfig(file = join(homedir(), ".ssh", "config")): SshConfigHost[] {
  const state: ParseState = { drafts: [], current: null };
  const rootFile = resolve(file);
  parseFile(rootFile, dirname(rootFile), state, new Set(), 0);

  const result: SshConfigHost[] = [];
  const seen = new Set<string>();
  for (const draft of state.drafts) {
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

function parseFile(file: string, includeBase: string, state: ParseState, activeFiles: Set<string>, depth: number): void {
  if (depth >= MAX_INCLUDE_DEPTH || activeFiles.has(file)) return;

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }

  activeFiles.add(file);
  try {
    for (const raw of text.split(/\r?\n/)) {
      const line = stripInlineComment(raw).trim();
      if (!line) continue;
      const match = line.match(/^([^\s=]+)(?:\s*=\s*|\s+)(.*?)\s*$/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      const rawValue = match[2];

      if (key === "include") {
        for (const pattern of splitArguments(rawValue)) {
          for (const included of resolveIncludes(pattern, includeBase)) {
            parseFile(included, includeBase, state, activeFiles, depth + 1);
          }
        }
        continue;
      }

      const value = stripQuotes(rawValue);
      if (key === "host") {
        const aliases = splitArguments(rawValue).filter((item) => item && !/[*!?]/.test(item));
        state.current = aliases.length > 0 ? { aliases } : null;
        if (state.current) state.drafts.push(state.current);
        continue;
      }
      // A `Match` block is conditional on things this parser cannot evaluate, and it ends
      // the preceding `Host` block: its options must not be credited to that alias.
      if (key === "match") {
        state.current = null;
        continue;
      }
      if (!state.current) continue;
      // OpenSSH keeps the first value it obtains for each option, not the last.
      if (key === "hostname" && value) state.current.hostName ??= value;
      else if (key === "user" && value) state.current.user ??= value;
      else if (key === "port" && /^\d+$/.test(value)) {
        const port = Number(value);
        if (port >= 1 && port <= 65_535) state.current.port ??= port;
      } else if (key === "identityfile" && value && !value.startsWith("-") && !value.includes("%")) {
        state.current.identityFile ??= expandHome(value);
      }
    }
  } finally {
    activeFiles.delete(file);
  }
}

function resolveIncludes(pattern: string, includeBase: string): string[] {
  const expanded = expandHome(pattern);
  const absolutePattern = isAbsolute(expanded) ? expanded : resolve(includeBase, expanded);
  try {
    return globSync(absolutePattern).sort();
  } catch {
    return [];
  }
}

function stripInlineComment(line: string): string {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}

function splitArguments(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of value.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) result.push(current);
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
