import test from "node:test";
import assert from "node:assert/strict";
import { formatMap, isStringRecord, mergeServers, parseMap, parseMcpJson, serializeMcpJson, serverFromEntry } from "../src/shared/mcp-config.ts";
import type { McpServerConfig } from "../src/shared/types.ts";

test("env: KEY=value per line, comments and blank lines skipped", () => {
  const parsed = parseMap("# token\nAPI_KEY=abc\n\n  HOME_DIR = /Users/me  \n", "env");
  assert.deepEqual(parsed.values, { API_KEY: "abc", HOME_DIR: "/Users/me" });
  assert.deepEqual(parsed.invalid, []);
});

test("env: the value keeps its own = signs", () => {
  assert.deepEqual(parseMap("URL=https://x/?a=b&c=d", "env").values, { URL: "https://x/?a=b&c=d" });
});

test("env: a line without =, or with a name a shell would reject, is reported", () => {
  const parsed = parseMap("GOOD=1\nnoseparator\n=novalue\n1BAD=x\nHAS SPACE=x", "env");
  assert.deepEqual(parsed.values, { GOOD: "1" });
  assert.deepEqual(parsed.invalid, ["noseparator", "=novalue", "1BAD=x", "HAS SPACE=x"]);
});

test("env: an empty value is allowed", () => {
  assert.deepEqual(parseMap("EMPTY=", "env").values, { EMPTY: "" });
});

test("headers: Name: value, and the value keeps its own colons", () => {
  const parsed = parseMap("Authorization: Bearer a:b\nX-Api-Key:k", "headers");
  assert.deepEqual(parsed.values, { Authorization: "Bearer a:b", "X-Api-Key": "k" });
});

test("headers: a name that is not an HTTP token is reported", () => {
  const parsed = parseMap("Good: 1\nBad Name: 2\nnocolon", "headers");
  assert.deepEqual(parsed.values, { Good: "1" });
  assert.deepEqual(parsed.invalid, ["Bad Name: 2", "nocolon"]);
});

test("a repeated name keeps the last value", () => {
  assert.deepEqual(parseMap("A=1\nA=2", "env").values, { A: "2" });
});

test("CRLF line endings are read like LF", () => {
  assert.deepEqual(parseMap("A=1\r\nB=2\r\n", "env").values, { A: "1", B: "2" });
});

test("format and parse are inverses, for both formats", () => {
  const env = { A: "1", B: "x=y" };
  assert.deepEqual(parseMap(formatMap(env, "env"), "env").values, env);
  const headers = { Authorization: "Bearer a:b", "X-Key": "v" };
  assert.deepEqual(parseMap(formatMap(headers, "headers"), "headers").values, headers);
});

test("format of nothing is an empty string, and headers read naturally", () => {
  assert.equal(formatMap(undefined, "env"), "");
  assert.equal(formatMap({ Authorization: "Bearer t" }, "headers"), "Authorization: Bearer t");
  assert.equal(formatMap({ A: "1" }, "env"), "A=1");
});

test("isStringRecord accepts only a plain record of strings", () => {
  assert.equal(isStringRecord({ a: "1" }), true);
  assert.equal(isStringRecord({}), true);
  assert.equal(isStringRecord({ a: 1 }), false);
  assert.equal(isStringRecord(null), false);
  assert.equal(isStringRecord(["a"]), false);
  assert.equal(isStringRecord("a"), false);
});

/* ---- the standard mcpServers JSON ------------------------------------------------------ */

test("json: the standard shape reads stdio and http entries", () => {
  const { servers, errors } = parseMcpJson(JSON.stringify({
    mcpServers: {
      fs: { command: "npx", args: ["-y", "srv"], env: { A: "1" } },
      docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
    },
  }));
  assert.deepEqual(errors, []);
  assert.deepEqual(servers, [
    { id: "fs", name: "fs", enabled: true, transport: "stdio", command: "npx", args: ["-y", "srv"], env: { A: "1" } },
    { id: "docs", name: "docs", enabled: true, transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } },
  ]);
});

test("json: VS Code's `servers` key and a bare name -> entry map are read too", () => {
  assert.equal(parseMcpJson('{"servers":{"a":{"command":"x"}}}').servers[0].name, "a");
  assert.equal(parseMcpJson('{"a":{"command":"x"},"b":{"url":"https://x/mcp"}}').servers.length, 2);
});

test("json: a README fragment without its outer braces is accepted", () => {
  const { servers, errors } = parseMcpJson('"filesystem": { "command": "npx", "args": ["-y", "srv"] }');
  assert.deepEqual(errors, []);
  assert.equal(servers[0].name, "filesystem");
});

test("json: a BOM and surrounding whitespace do not matter", () => {
  assert.equal(parseMcpJson('\uFEFF\n  {"a":{"command":"x"}}  \n').servers.length, 1);
});

test("json: broken JSON reports the parser's message, not a shape error", () => {
  const { servers, errors } = parseMcpJson('{"mcpServers": {');
  assert.equal(servers.length, 0);
  assert.equal(errors[0].code, "json");
});

test("json: empty input, an array and an object with no servers are a shape error", () => {
  for (const text of ["", "   ", "[]", "{}", '{"mcpServers":{}}', '{"a":1}']) {
    assert.deepEqual(parseMcpJson(text).errors, [{ code: "shape" }], JSON.stringify(text));
  }
});

test("json: an entry with neither command nor url names itself in the error", () => {
  const { servers, errors } = parseMcpJson('{"mcpServers":{"ok":{"command":"x"},"bad":{"nothing":true}}}');
  assert.deepEqual(servers.map((item) => item.name), ["ok"]);
  assert.deepEqual(errors, [{ code: "missing", name: "bad" }]);
});

test("json: type decides when both a url and a command are present", () => {
  assert.equal(serverFromEntry("a", { type: "stdio", command: "x", url: "https://x" }).server?.transport, "stdio");
  assert.equal(serverFromEntry("a", { type: "http", command: "x", url: "https://x" }).server?.transport, "http");
  assert.equal(serverFromEntry("a", { type: "streamable-http", url: "https://x" }).server?.transport, "http");
  // No type: a url alone is http, a command wins over a stray url.
  assert.equal(serverFromEntry("a", { url: "https://x" }).server?.transport, "http");
  assert.equal(serverFromEntry("a", { command: "x", url: "https://x" }).server?.transport, "stdio");
});

test("json: SSE is refused when pasting, and read as http when loading a stored file", () => {
  assert.deepEqual(parseMcpJson('{"a":{"type":"sse","url":"https://x/sse"}}').errors, [{ code: "sse", name: "a" }]);
  assert.equal(serverFromEntry("a", { type: "sse", url: "https://x/sse" }, { lenient: true }).server?.transport, "http");
});

test("json: both disabled flags switch a server off", () => {
  assert.equal(serverFromEntry("a", { command: "x", disabled: true }).server?.enabled, false);
  assert.equal(serverFromEntry("a", { command: "x", enabled: false }).server?.enabled, false);
  assert.equal(serverFromEntry("a", { command: "x" }).server?.enabled, true);
});

test("json: numbers and booleans in env and headers are taken as text; objects are not", () => {
  assert.deepEqual(serverFromEntry("a", { command: "x", env: { PORT: 3000, DEBUG: true } }).server?.env, { PORT: "3000", DEBUG: "true" });
  assert.deepEqual(serverFromEntry("a", { command: "x", env: { A: { nested: 1 } } }).error, { code: "field", name: "a", field: "env" });
  assert.deepEqual(serverFromEntry("a", { url: "https://x", headers: ["h"] }).error, { code: "field", name: "a", field: "headers" });
  assert.deepEqual(serverFromEntry("a", { command: "x", args: ["ok", 1] }).error, { code: "field", name: "a", field: "args" });
});

test("json: a blank name is an error rather than a server called nothing", () => {
  assert.equal(parseMcpJson('{"mcpServers":{"  ":{"command":"x"}}}').servers.length, 0);
});

test("json: serialize and parse are inverses for both transports", () => {
  const servers: McpServerConfig[] = [
    { id: "fs", name: "fs", enabled: true, transport: "stdio", command: "npx", args: ["-y", "a b"], env: { K: "v" } },
    { id: "docs", name: "docs", enabled: false, transport: "http", url: "https://x/mcp", headers: { Authorization: "Bearer a:b" } },
  ];
  assert.deepEqual(parseMcpJson(serializeMcpJson(servers)).servers, servers);
});

test("json: serialize leaves out what is empty", () => {
  const out = JSON.parse(serializeMcpJson([{ id: "a", name: "a", enabled: true, transport: "stdio", command: "x", args: [], env: {} }]));
  assert.deepEqual(out, { mcpServers: { a: { command: "x" } } });
});

test("merge: a pasted server replaces the one with its name and keeps the stored id", () => {
  const existing: McpServerConfig[] = [
    { id: "fs-123", name: "fs", enabled: true, transport: "stdio", command: "old" },
    { id: "keep-1", name: "keep", enabled: true, transport: "stdio", command: "k" },
  ];
  const incoming = parseMcpJson('{"fs":{"command":"new"},"fresh":{"url":"https://x/mcp"}}').servers;
  const merged = mergeServers(existing, incoming, (name) => `${name}-new`);
  assert.deepEqual(merged.map((item) => [item.id, item.name, item.command ?? item.url]), [
    ["fs-123", "fs", "new"],
    ["keep-1", "keep", "k"],
    ["fresh-new", "fresh", "https://x/mcp"],
  ]);
});
