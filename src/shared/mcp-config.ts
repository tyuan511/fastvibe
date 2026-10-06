/**
 * The text form of an MCP server's environment and request headers, as the settings form
 * edits them: one entry per line, `KEY=value` for the environment and `Name: value` for
 * headers. Pure, so the form and the tests read the same rules.
 */

import type { McpServerConfig } from "./types";

export type MapFormat = "env" | "headers";

const SEPARATOR: Record<MapFormat, string> = { env: "=", headers: ":" };

/** An environment variable name, as a shell would accept it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An HTTP field name: RFC 9110 `token`. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export type ParsedMap = {
  values: Record<string, string>;
  /** Lines that are not an entry — a missing separator or a name the format cannot carry. */
  invalid: string[];
};

/**
 * Read `text` into a record. Blank lines and `#` comments are ignored; the value is
 * everything after the first separator, trimmed, so `Authorization: Bearer a:b` and
 * `URL=https://x/?a=b` keep their own separators. A repeated name keeps the last value.
 */
export function parseMap(text: string, format: MapFormat): ParsedMap {
  const separator = SEPARATOR[format];
  const valid = format === "env" ? ENV_NAME : HEADER_NAME;
  const values: Record<string, string> = {};
  const invalid: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf(separator);
    const name = at < 0 ? "" : line.slice(0, at).trim();
    if (!name || !valid.test(name)) {
      invalid.push(line);
      continue;
    }
    values[name] = line.slice(at + 1).trim();
  }
  return { values, invalid };
}

/** The inverse of `parseMap`: what the form shows for a stored record. */
export function formatMap(values: Record<string, string> | undefined, format: MapFormat): string {
  if (!values) return "";
  const separator = SEPARATOR[format];
  const glue = format === "headers" ? `${separator} ` : separator;
  return Object.entries(values)
    .map(([name, value]) => `${name}${glue}${value}`)
    .join("\n");
}

/* ------------------------------------------------------------------------------------------
 * The standard `mcpServers` JSON
 *
 * The shape every MCP client reads — Claude Desktop, Claude Code, Cursor, VS Code (under
 * `servers`) — and the one a server's own README tells you to paste:
 *
 *   { "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "…"], "env": { … } },
 *                     "docs": { "url": "https://…/mcp", "headers": { … } } } }
 *
 * The settings form edits it as text, and Main reads a file written in it, so both go
 * through the one reading below rather than each deciding what an entry means.
 * ---------------------------------------------------------------------------------------- */

/** What was wrong with some part of a pasted config. The pane words each one for the user. */
export type McpJsonError =
  | { code: "json"; message: string }
  | { code: "shape" }
  | { code: "missing"; name: string }
  | { code: "sse"; name: string }
  | { code: "field"; name: string; field: string };

export type McpJsonResult = {
  /** Valid entries, each with its name as its id (a caller that stores them assigns real ids). */
  servers: McpServerConfig[];
  errors: McpJsonError[];
};

/** `Record<string, string>` from a JSON object, taking numbers and booleans as their text. */
function toStringRecord(value: unknown): Record<string, string> | "invalid" {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
    else if (typeof item === "number" || typeof item === "boolean") out[key] = String(item);
    else return "invalid";
  }
  return out;
}

/**
 * One `mcpServers` entry. A `url` is an HTTP server and a `command` a local process, unless
 * `type` says otherwise. `disabled: true` (Claude) and `enabled: false` (pi) both switch it
 * off. SSE is a transport this app cannot speak: `lenient` reads such an entry as HTTP, so a
 * stored file keeps the row and the connection error says why, instead of the server
 * vanishing from the list.
 */
export function serverFromEntry(
  name: string,
  raw: unknown,
  options: { lenient?: boolean } = {},
): { server: McpServerConfig } | { error: McpJsonError } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: { code: "missing", name } };
  const item = raw as Record<string, unknown>;
  const type = typeof item.type === "string" ? item.type.toLowerCase() : undefined;
  if (type === "sse" && !options.lenient) return { error: { code: "sse", name } };
  const enabled = item.disabled !== true && item.enabled !== false;

  const isHttp = type === "http" || type === "streamable-http" || type === "streamablehttp" || type === "sse"
    ? true
    : type === "stdio"
      ? false
      : typeof item.url === "string" && item.url.trim() !== "" && typeof item.command !== "string";
  if (isHttp) {
    if (typeof item.url !== "string" || !item.url.trim()) return { error: { code: "missing", name } };
    const headers = item.headers === undefined ? undefined : toStringRecord(item.headers);
    if (headers === "invalid") return { error: { code: "field", name, field: "headers" } };
    return { server: { id: name, name, enabled, transport: "http", url: item.url.trim(), ...(headers && Object.keys(headers).length ? { headers } : {}) } };
  }
  if (typeof item.command !== "string" || !item.command.trim()) return { error: { code: "missing", name } };
  if (item.args !== undefined && !(Array.isArray(item.args) && item.args.every((arg) => typeof arg === "string"))) {
    return { error: { code: "field", name, field: "args" } };
  }
  const env = item.env === undefined ? undefined : toStringRecord(item.env);
  if (env === "invalid") return { error: { code: "field", name, field: "env" } };
  const args = item.args as string[] | undefined;
  return {
    server: {
      id: name,
      name,
      enabled,
      transport: "stdio",
      command: item.command.trim(),
      ...(args?.length ? { args } : {}),
      ...(env && Object.keys(env).length ? { env } : {}),
    },
  };
}

/** The name → entry map inside a parsed config, wherever the client that wrote it put it. */
function serverMap(parsed: unknown): Record<string, unknown> | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const root = parsed as Record<string, unknown>;
  for (const key of ["mcpServers", "servers"]) {
    const found = root[key];
    if (typeof found === "object" && found !== null && !Array.isArray(found)) return found as Record<string, unknown>;
  }
  // A README fragment is often just the map: `{ "filesystem": { "command": … } }`.
  const values = Object.values(root);
  return values.length > 0 && values.every((value) => typeof value === "object" && value !== null && !Array.isArray(value))
    ? root
    : undefined;
}

/**
 * Read a config pasted or typed as text. A fragment without its outer braces — what you get
 * from copying a single `"name": { … }` out of a README — is accepted.
 */
export function parseMcpJson(text: string): McpJsonResult {
  const source = text.replace(/^﻿/, "").trim();
  if (!source) return { servers: [], errors: [{ code: "shape" }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.startsWith("{") || source.startsWith("[") ? source : `{${source}}`);
  } catch (error) {
    return { servers: [], errors: [{ code: "json", message: error instanceof Error ? error.message : String(error) }] };
  }
  const map = serverMap(parsed);
  if (!map || Object.keys(map).length === 0) return { servers: [], errors: [{ code: "shape" }] };
  const servers: McpServerConfig[] = [];
  const errors: McpJsonError[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const trimmed = name.trim();
    if (!trimmed) {
      errors.push({ code: "missing", name });
      continue;
    }
    const result = serverFromEntry(trimmed, raw);
    if ("error" in result) errors.push(result.error);
    else servers.push(result.server);
  }
  return { servers, errors };
}

/** The standard JSON for `servers`, as the form's JSON view shows it. */
export function serializeMcpJson(servers: McpServerConfig[]): string {
  const map: Record<string, unknown> = {};
  for (const server of servers) {
    map[server.name] =
      server.transport === "stdio"
        ? {
            command: server.command ?? "",
            ...(server.args?.length ? { args: server.args } : {}),
            ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
            ...(server.enabled ? {} : { disabled: true }),
          }
        : {
            url: server.url ?? "",
            ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
            ...(server.enabled ? {} : { disabled: true }),
          };
  }
  return JSON.stringify({ mcpServers: map }, null, 2);
}

/**
 * Add `incoming` to `existing`. A server with the name of a stored one replaces it and keeps
 * its id — the id is what the engine names the server's tools by, so a pasted update must not
 * rename them — and anything else is appended with an id from `makeId`.
 */
export function mergeServers(
  existing: McpServerConfig[],
  incoming: McpServerConfig[],
  makeId: (name: string) => string,
): McpServerConfig[] {
  const next = [...existing];
  for (const server of incoming) {
    const at = next.findIndex((item) => item.name === server.name);
    if (at >= 0) next[at] = { ...server, id: next[at].id };
    else next.push({ ...server, id: makeId(server.name) });
  }
  return next;
}

/** A stored record that really is `Record<string, string>`; anything else is not one. */
export function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}
