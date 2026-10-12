import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { mappedCandidate, parseCandidate, predictedCandidates } from "../src/main/rtc/candidates.ts";
import { PortMapper, wanServices } from "../src/main/rtc/portmap.ts";

const LOCAL = "127.0.0.1";
const closers: Array<() => void> = [];
after(() => {
  for (const close of closers) close();
});

function udp(): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.bind(0, LOCAL, () => resolve(socket));
    closers.push(() => socket.close());
  });
}

/** A gateway that speaks NAT-PMP: it reports an external address and remembers what it maps. */
async function natPmpGateway(external: string, options: { refuse?: boolean } = {}) {
  const socket = await udp();
  const mappings = new Map<number, { external: number; lifetime: number }>();
  const requests: Array<{ op: number; internal?: number; lifetime?: number }> = [];
  socket.on("message", (packet, from) => {
    const op = packet[1];
    const reply = (body: Buffer): void => void socket.send(body, from.port, from.address);
    if (op === 0) {
      requests.push({ op });
      const body = Buffer.alloc(12);
      body[1] = 128;
      Buffer.from(external.split(".").map(Number)).copy(body, 8);
      reply(body);
      return;
    }
    const internal = packet.readUInt16BE(4);
    const lifetime = packet.readUInt32BE(8);
    requests.push({ op, internal, lifetime });
    const body = Buffer.alloc(16);
    body[1] = 128 + op;
    body.writeUInt16BE(options.refuse ? 2 : 0, 2);
    body.writeUInt16BE(internal, 8);
    if (!options.refuse) {
      if (lifetime === 0) mappings.delete(internal);
      else mappings.set(internal, { external: internal + 1000, lifetime });
      body.writeUInt16BE(lifetime === 0 ? 0 : internal + 1000, 10);
      body.writeUInt32BE(lifetime, 12);
    }
    reply(body);
  });
  return { port: socket.address().port, mappings, requests };
}

/** A router that speaks UPnP: it answers the search, serves its description, and takes SOAP. */
async function upnpGateway(external: string, options: { taken?: number[]; permanentOnly?: boolean; describe?: (port: number) => string } = {}) {
  const mappings = new Map<number, { internal: number; client: string; lease: number; description: string }>();
  const actions: string[] = [];
  const server: Server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/xml" });
      response.end(options.describe?.(port) ?? `<?xml version="1.0"?><root><device><serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/ctl/L3F</controlURL></service>
        </serviceList><deviceList><device><deviceList><device><serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
        </serviceList></device></deviceList></device></deviceList></device></root>`);
      return;
    }
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      const action = /#(\w+)"/.exec(String(request.headers.soapaction))?.[1] ?? "";
      actions.push(action);
      const field = (name: string): string => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1] ?? "";
      const fail = (code: number): void => {
        response.writeHead(500, { "Content-Type": "text/xml" });
        response.end(`<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
      };
      const ok = (inner = ""): void => {
        response.writeHead(200, { "Content-Type": "text/xml" });
        response.end(`<s:Envelope><s:Body><u:${action}Response>${inner}</u:${action}Response></s:Body></s:Envelope>`);
      };
      if (request.url !== "/ctl/IPConn") return fail(401);
      if (action === "GetExternalIPAddress") return ok(`<NewExternalIPAddress>${external}</NewExternalIPAddress>`);
      if (action === "AddPortMapping") {
        const port = Number(field("NewExternalPort"));
        const lease = Number(field("NewLeaseDuration"));
        if (options.permanentOnly && lease !== 0) return fail(725);
        if (options.taken?.includes(port)) return fail(718);
        assert.equal(field("NewProtocol"), "UDP");
        mappings.set(port, { internal: Number(field("NewInternalPort")), client: field("NewInternalClient"), lease, description: field("NewPortMappingDescription") });
        return ok();
      }
      if (action === "DeletePortMapping") {
        mappings.delete(Number(field("NewExternalPort")));
        return ok();
      }
      fail(401);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, LOCAL, resolve));
  closers.push(() => server.close());
  const port = (server.address() as { port: number }).port;
  const ssdp = await udp();
  ssdp.on("message", (packet, from) => {
    if (!packet.toString().startsWith("M-SEARCH")) return;
    ssdp.send(`HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://${LOCAL}:${port}/rootDesc.xml\r\n\r\n`, from.port, from.address);
  });
  return { ssdp: { address: LOCAL, port: ssdp.address().port }, mappings, actions };
}

/** A port nothing listens on, so a protocol that is not being tested gets no answer. */
async function silentPort(): Promise<number> {
  const socket = await udp();
  return socket.address().port;
}

test("NAT-PMP: a port is mapped, reported with the router's address, and taken down", async () => {
  const gateway = await natPmpGateway("203.0.113.7");
  const mapper = new PortMapper({ natPmpPort: gateway.port, natPmpGateways: () => [LOCAL], ssdp: { address: LOCAL, port: await silentPort() }, timeoutMs: 400, leaseSeconds: 600 });
  const mapping = await mapper.map(LOCAL, 47811);
  assert.ok(mapping);
  assert.equal(mapping.protocol, "nat-pmp");
  assert.equal(mapping.externalAddress, "203.0.113.7");
  assert.equal(mapping.externalPort, 48811);
  assert.deepEqual(gateway.mappings.get(47811), { external: 48811, lifetime: 600 });
  await mapping.release();
  await mapping.release();
  assert.equal(gateway.mappings.size, 0);
  // One question about the address, one mapping, one removal — the second release asked nothing.
  assert.deepEqual(gateway.requests.map((request) => request.op), [0, 1, 1]);
});

test("NAT-PMP: a refusal is no mapping, not an error", async () => {
  const gateway = await natPmpGateway("203.0.113.7", { refuse: true });
  const mapper = new PortMapper({ natPmpPort: gateway.port, natPmpGateways: () => [LOCAL], ssdp: { address: LOCAL, port: await silentPort() }, timeoutMs: 300 });
  assert.equal(await mapper.map(LOCAL, 47811), null);
});

test("UPnP: the router is found, asked for the same port, and the mapping removed afterwards", async () => {
  const gateway = await upnpGateway("203.0.113.8");
  const mapper = new PortMapper({ ssdp: gateway.ssdp, natPmpPort: await silentPort(), natPmpGateways: () => [LOCAL], timeoutMs: 600, leaseSeconds: 900 });
  const mapping = await mapper.map(LOCAL, 47812);
  assert.ok(mapping);
  assert.equal(mapping.protocol, "upnp");
  assert.equal(mapping.externalAddress, "203.0.113.8");
  assert.equal(mapping.externalPort, 47812);
  assert.deepEqual(gateway.mappings.get(47812), { internal: 47812, client: LOCAL, lease: 900, description: "FastVibe" });
  // The gateway is remembered: a second call asks it nothing but the mapping itself.
  const second = await mapper.map(LOCAL, 47900);
  assert.equal(second?.externalPort, 47900);
  assert.deepEqual(gateway.actions, ["GetExternalIPAddress", "AddPortMapping", "AddPortMapping"]);
  await mapper.close();
  assert.equal(gateway.mappings.size, 0);
});

test("UPnP: a port somebody else holds moves the mapping along by one", async () => {
  const gateway = await upnpGateway("203.0.113.8", { taken: [47813] });
  const mapper = new PortMapper({ ssdp: gateway.ssdp, natPmpPort: await silentPort(), natPmpGateways: () => [LOCAL], timeoutMs: 600 });
  const mapping = await mapper.map(LOCAL, 47813);
  assert.equal(mapping?.externalPort, 47814);
  assert.equal(gateway.mappings.get(47814)?.internal, 47813);
  await mapping?.release();
});

test("UPnP: a router that only makes permanent mappings is left alone", async () => {
  const gateway = await upnpGateway("203.0.113.8", { permanentOnly: true });
  const mapper = new PortMapper({ ssdp: gateway.ssdp, natPmpPort: await silentPort(), natPmpGateways: () => [LOCAL], timeoutMs: 600 });
  assert.equal(await mapper.map(LOCAL, 47815), null);
  assert.equal(gateway.mappings.size, 0);
});

test("a router that is itself behind another NAT is not asked for a port", async () => {
  const gateway = await upnpGateway("100.72.3.4");
  const mapper = new PortMapper({ ssdp: gateway.ssdp, natPmpPort: await silentPort(), natPmpGateways: () => [LOCAL], timeoutMs: 600 });
  assert.equal(await mapper.map(LOCAL, 47816), null);
  assert.deepEqual(gateway.actions, ["GetExternalIPAddress"]);
});

test("no gateway at all is simply no mapping", async () => {
  const mapper = new PortMapper({ ssdp: { address: LOCAL, port: await silentPort() }, natPmpPort: await silentPort(), natPmpGateways: () => [LOCAL], timeoutMs: 250 });
  assert.equal(await mapper.map(LOCAL, 47817), null);
});

test("only the router's own WAN services are taken from a description", () => {
  const location = new URL("http://192.168.1.1:5000/rootDesc.xml");
  const description = `<root><URLBase>http://192.168.1.1:5000/</URLBase>
    <service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/ctl/common</controlURL></service>
    <service><serviceType> urn:schemas-upnp-org:service:WANPPPConnection:1 </serviceType><controlURL>ctl/ppp</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:2</serviceType><controlURL>http://192.168.1.1:5000/ctl/ip</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>http://203.0.113.50/ctl/elsewhere</controlURL></service>
  </root>`;
  assert.deepEqual(wanServices(description, location).map(({ service, control }) => [service, control.href]), [
    ["urn:schemas-upnp-org:service:WANPPPConnection:1", "http://192.168.1.1:5000/ctl/ppp"],
    ["urn:schemas-upnp-org:service:WANIPConnection:2", "http://192.168.1.1:5000/ctl/ip"],
  ]);
});

test("the ports a router hands out in order are offered as candidates beside the real one", () => {
  const real = "a=candidate:2 1 UDP 1678769919 183.156.1.2 50947 typ srflx raddr 0.0.0.0 rport 0";
  const predicted = predictedCandidates(real, 3);
  assert.deepEqual(predicted, [
    "a=candidate:fvp1 1 UDP 1678769918 183.156.1.2 50948 typ srflx raddr 0.0.0.0 rport 0",
    "a=candidate:fvp2 1 UDP 1678769917 183.156.1.2 50949 typ srflx raddr 0.0.0.0 rport 0",
    "a=candidate:fvp3 1 UDP 1678769916 183.156.1.2 50950 typ srflx raddr 0.0.0.0 rport 0",
  ]);
  for (const line of predicted) assert.equal(parseCandidate(line)?.type, "srflx");
  // Never past the last port, and only from a public IPv4 the library itself reported.
  assert.equal(predictedCandidates("candidate:2 1 UDP 100 183.156.1.2 65534 typ srflx", 4).length, 1);
  assert.deepEqual(predictedCandidates("candidate:1 1 UDP 2114977791 192.168.1.5 51282 typ host", 4), []);
  assert.deepEqual(predictedCandidates("candidate:2 1 UDP 100 2408:8207::1 50947 typ srflx", 4), []);
  assert.deepEqual(predictedCandidates("garbage", 4), []);
});

test("a forwarded port is written as a candidate ranked just above the real one", () => {
  const real = "candidate:2 1 UDP 1678769919 183.156.1.2 50947 typ srflx raddr 0.0.0.0 rport 0";
  assert.equal(mappedCandidate("183.156.1.2", 47811, real), "candidate:fvmap 1 UDP 1678769920 183.156.1.2 47811 typ srflx raddr 0.0.0.0 rport 0");
  // Before the library has found anything, it stands by itself.
  assert.equal(mappedCandidate("183.156.1.2", 47811, null), "a=candidate:fvmap 1 UDP 1694498816 183.156.1.2 47811 typ srflx raddr 0.0.0.0 rport 0");
});
