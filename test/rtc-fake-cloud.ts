import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Just enough of the cloud for the desktop's official connection to run against: device
 * registration, the ICE list, and the signaling that introduces a "phone" to a "desktop".
 * Not a model of the service — the Go tests cover that — only of the messages the
 * desktop depends on.
 */
export type FakeCloud = {
  origin: string;
  /** Tokens the cloud accepts. */
  tokens: Set<string>;
  /** Overrides what the registration answers (status + body), for failure paths. */
  registration: { status: number; body: unknown } | null;
  /** What /api/rtc/ice answers. */
  ice: unknown;
  registrations: Array<{ installId: string; name: string; platform: string; token: string }>;
  /** Connect a phone, as a signaling client. */
  phone(token: string): Promise<FakePhone>;
  deviceSockets: Map<string, WebSocket>;
  closeDeviceSocket(deviceId: string, code: number): void;
  close(): Promise<void>;
};

export type FakePhone = {
  /** Place a call to a device; resolves with the call id. */
  connect(deviceId: string): Promise<string>;
  signal(cid: string, data: unknown): void;
  hangup(cid: string): void;
  onSignal(listener: (cid: string, data: unknown) => void): void;
  messages: Array<Record<string, unknown>>;
  close(): void;
};

export async function startFakeCloud(): Promise<FakeCloud> {
  const devices = new Map<string, string>(); // installId -> deviceId
  const deviceSockets = new Map<string, WebSocket>();
  const calls = new Map<string, { phone: WebSocket; device: WebSocket }>();
  const cloud: FakeCloud = {
    origin: "",
    tokens: new Set(["fvs_good"]),
    registration: null,
    ice: { ice_servers: [], relay_exhausted: false },
    registrations: [],
    deviceSockets,
    phone: async () => { throw new Error("not started"); },
    closeDeviceSocket: (id, code) => deviceSockets.get(id)?.close(code, "x"),
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((settle) => server.close(() => settle()));
    },
  };

  const bearer = (request: IncomingMessage): string | null => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    return cloud.tokens.has(token) ? token : null;
  };

  const server: Server = createServer(async (request, response) => {
    const token = bearer(request);
    if (!token) {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "unauthorized" } }));
      return;
    }
    if (request.url === "/api/devices/me" && request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { install_id: string; name: string; platform: string };
      cloud.registrations.push({ installId: body.install_id, name: body.name, platform: body.platform, token });
      if (cloud.registration) {
        response.writeHead(cloud.registration.status, { "content-type": "application/json" }).end(JSON.stringify(cloud.registration.body));
        return;
      }
      let id = devices.get(body.install_id);
      if (!id) devices.set(body.install_id, (id = randomUUID()));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ device: { id, name: body.name } }));
      return;
    }
    if (request.url === "/api/rtc/ice") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(cloud.ice));
      return;
    }
    response.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/rtc/signal" || !bearer(request)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let role = "";
      let deviceId = "";
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as Record<string, unknown>;
        if (m.type === "hello") {
          role = String(m.role);
          if (role === "device") {
            deviceId = String(m.device_id);
            deviceSockets.set(deviceId, ws);
          }
          ws.send(JSON.stringify({ type: "hello", role }));
        } else if (m.type === "connect" && role === "client") {
          const device = deviceSockets.get(String(m.device_id));
          if (!device) return ws.send(JSON.stringify({ type: "error", code: "device_offline" }));
          const cid = randomUUID();
          calls.set(cid, { phone: ws, device });
          ws.send(JSON.stringify({ type: "connected", cid }));
          device.send(JSON.stringify({ type: "incoming", cid, peer: { name: "Test phone", platform: "ios" } }));
        } else if (m.type === "signal" || m.type === "hangup") {
          const call = calls.get(String(m.cid));
          if (!call) return;
          const target = ws === call.phone ? call.device : call.phone;
          target.send(JSON.stringify({ type: m.type, cid: m.cid, ...(m.type === "signal" ? { data: m.data } : {}) }));
          if (m.type === "hangup") calls.delete(String(m.cid));
        }
      });
      ws.on("close", () => {
        if (deviceId && deviceSockets.get(deviceId) === ws) deviceSockets.delete(deviceId);
      });
    });
  });

  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  cloud.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  cloud.phone = async (token) => {
    const { default: WebSocketClient } = await import("ws");
    const ws = new WebSocketClient(`ws://${cloud.origin.slice("http://".length)}/api/rtc/signal`, { headers: { Authorization: `Bearer ${token}` } });
    const messages: Array<Record<string, unknown>> = [];
    const signalListeners: Array<(cid: string, data: unknown) => void> = [];
    const waiters: Array<(m: Record<string, unknown>) => void> = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      if (m.type === "signal") signalListeners.forEach((l) => l(String(m.cid), m.data));
      messages.push(m);
      waiters.splice(0).forEach((w) => w(m));
    });
    await new Promise<void>((settle, fail) => { ws.once("open", () => settle()); ws.once("error", fail); });
    const next = (match: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> =>
      new Promise((settle, fail) => {
        const found = messages.find(match);
        if (found) return settle(found);
        const timer = setTimeout(() => fail(new Error("timed out waiting for a signaling message")), 4000);
        const check = (m: Record<string, unknown>): void => {
          if (match(m)) { clearTimeout(timer); settle(m); } else waiters.push(check);
        };
        waiters.push(check);
      });
    ws.send(JSON.stringify({ type: "hello", role: "client", name: "Test phone", platform: "ios" }));
    await next((m) => m.type === "hello");
    return {
      messages,
      connect: async (deviceId) => {
        ws.send(JSON.stringify({ type: "connect", device_id: deviceId }));
        const m = await next((x) => x.type === "connected" || x.type === "error");
        if (m.type !== "connected") throw new Error(`connect refused: ${String(m.code)}`);
        return String(m.cid);
      },
      signal: (cid, data) => ws.send(JSON.stringify({ type: "signal", cid, data })),
      hangup: (cid) => ws.send(JSON.stringify({ type: "hangup", cid })),
      onSignal: (listener) => { signalListeners.push(listener); },
      close: () => ws.close(),
    };
  };
  return cloud;
}
