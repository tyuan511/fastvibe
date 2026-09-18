import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSshTunnelArgs } from "../src/main/ssh/ssh-tunnel.ts";

test("buildSshTunnelArgs uses strict host verification and loopback forwarding", () => {
  assert.deepEqual(buildSshTunnelArgs({
    host: {
      id: "dev",
      host: "server.example",
      user: "deploy",
      port: 2222,
      identityFile: "/keys/dev",
      knownHostsFile: "/keys/known_hosts",
    },
    localPort: 17777,
    remotePort: 7777,
  }), [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ConnectTimeout=10",
    "-p",
    "2222",
    "-i",
    "/keys/dev",
    "-o",
    "UserKnownHostsFile=/keys/known_hosts",
    "-L",
    "17777:127.0.0.1:7777",
    "deploy@server.example",
  ]);
});

test("password authentication disables batch mode while keeping strict host checks", () => {
  const args = buildSshTunnelArgs({
    host: { id: "x", host: "server.example", user: "dev" },
    password: "secret",
    localPort: 17777,
    remotePort: 7777,
  });
  assert.equal(args[args.indexOf("BatchMode=no")], "BatchMode=no");
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(!args.includes("secret"));
});

test("buildSshTunnelArgs rejects invalid ports and empty hosts", () => {
  assert.throws(() => buildSshTunnelArgs({ host: { id: "x", host: "" }, localPort: 17777, remotePort: 7777 }));
  assert.throws(() => buildSshTunnelArgs({ host: { id: "x", host: "server" }, localPort: 0, remotePort: 7777 }));
  assert.throws(() => buildSshTunnelArgs({ host: { id: "x", host: "server" }, localPort: 17777, remotePort: 70000 }));
});
