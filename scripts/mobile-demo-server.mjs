#!/usr/bin/env node
/**
 * A stand-in FastVibe machine for photographing the native phone app.
 *
 * The app only has content once it is connected to a machine, so for the website's
 * phone pictures this answers the handful of methods the device list, the project list
 * and a chat call — password login, the App Protocol hello, then `conversations:list`,
 * `engine:get-snapshot` and friends — with the same fixture the desktop mock uses.
 *
 *   node scripts/mobile-demo-server.mjs [--lang zh|en] [--port 7788]
 *
 * Any password is accepted. Methods nobody asked for are logged and answered `null`.
 */
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const lang = arg("lang", "zh") === "en" ? "en" : "zh";
const port = Number(arg("port", 7788));
const { WebSocketServer } = createRequire(import.meta.url)("ws");
const { websiteFixture } = await import(pathToFileURL(path.join(root, "src/renderer/src/mock/website-fixtures.ts")).href);
const { MODELS } = await import(pathToFileURL(path.join(root, "src/renderer/src/mock/preview-data.ts")).href);

const fx = websiteFixture(lang);
const TOKEN = "demo-device-token";
const queue = (id) => ({ conversationId: id, revision: 0, items: [], pause: null });

const methods = {
  "conversations:list": () => ({ projects: fx.projects, conversations: fx.conversations, activeId: fx.activeId }),
  "engine:get-running": () => [],
  "engine:get-pending-ui": () => [],
  "settings:get": () => ({}),
  "engine:get-models": () => MODELS,
  "engine:get-state": (p) => ({ ...fx.session, conversationId: p?.conversationId ?? fx.activeId }),
  "engine:get-snapshot": (p) => {
    const id = p?.conversationId ?? fx.activeId;
    return {
      conversationId: id,
      messages: id === fx.activeId ? fx.messages : fx.messages.slice(0, 2),
      running: false,
      queue: queue(id),
      pendingUi: [],
      turnEvents: [],
      overflowed: false,
      seq: 0,
    };
  },
};

const http = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/login") {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: TOKEN }));
    });
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame.type === "auth") return ws.send(JSON.stringify({ type: "auth", ok: frame.token === TOKEN }));
    if (frame.kind === "hello") return ws.send(JSON.stringify({ kind: "welcome", welcome: { protocol: "fastvibe.app", protocolVersion: 1 } }));
    if (frame.kind === "call") {
      const handler = methods[frame.method];
      if (!handler) console.log(`unhandled: ${frame.method}`);
      return ws.send(JSON.stringify({ kind: "result", requestId: frame.requestId, ok: true, result: handler ? handler(frame.payload) : null }));
    }
  });
});

http.listen(port, "0.0.0.0", () => console.log(`mobile demo server (${lang}) on :${port}`));
