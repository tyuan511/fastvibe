import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSshTunnelArgs, classifySshFailure, probeSshHost, runSshCommand, sshDestination } from "../src/main/ssh/ssh-tunnel.ts";

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

test("a control socket is attached without asking for the password again", () => {
  const args = buildSshTunnelArgs({
    host: { id: "x", host: "server.example", user: "dev" },
    password: "secret",
    localPort: 17777,
    remotePort: 7777,
    controlPath: "/tmp/fv-1",
  });
  assert.equal(args[args.indexOf("-S") + 1], "/tmp/fv-1");
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(!args.includes("secret"));
});

test("buildSshTunnelArgs rejects invalid ports and empty hosts", () => {
  assert.throws(() => buildSshTunnelArgs({ host: { id: "x", host: "" }, localPort: 17777, remotePort: 7777 }));
  assert.throws(() => buildSshTunnelArgs({ host: { id: "x", host: "server" }, localPort: 0, remotePort: 7777 }));
  assert.throws(() => buildSshTunnelArgs({ host: { id: "x", host: "server" }, localPort: 17777, remotePort: 70000 }));
});

test("sshDestination joins the user when there is one", () => {
  // The test toast reports this string, so it has to be what OpenSSH was actually told to
  // connect to — a host with no user must not come back `undefined@host`.
  assert.equal(sshDestination({ id: "x", host: "us01.tangge.me", user: "root" }), "root@us01.tangge.me");
  assert.equal(sshDestination({ id: "x", host: "us01.tangge.me", user: "  " }), "us01.tangge.me");
  assert.equal(sshDestination({ id: "x", host: "us01.tangge.me" }), "us01.tangge.me");
});

test("the probe reports a failure as a value, with OpenSSH's own reason", async () => {
  // OpenSSH exits 255 with the real reason on stderr, and our wrapper would otherwise
  // report `SSH 远程初始化失败（exit 255）` — which says nothing about a denied key.
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-probe-"));
  const fake = join(dir, "ssh");
  writeFileSync(fake, "#!/bin/sh\necho 'Permission denied (publickey).' >&2\ncat >/dev/null\nexit 255\n", { mode: 0o700 });
  const result = await probeSshHost({
    host: { id: "x", host: "us01.tangge.me", user: "root", port: 22 },
    sshBinary: fake,
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.target, "root@us01.tangge.me");
  assert.equal(result.error, "Permission denied (publickey).");
});

test("the probe succeeds without deploying anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-probe-"));
  const fake = join(dir, "ssh");
  // Records the command it was asked to run, so the test can prove the probe is a login
  // and nothing else: no tar, no node download, no nohup of a remote Agent.
  const log = join(dir, "args");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > ${log}\ncat >/dev/null\nexit 0\n`, { mode: 0o700 });
  const result = await probeSshHost({ host: { id: "x", host: "host.example" }, sshBinary: fake });
  assert.deepEqual(result, { ok: true, target: "host.example" });
  const args = readFileSync(log, "utf8");
  assert.match(args, /exit 0|"exit 0"|exit 0/);
  assert.doesNotMatch(args, /tar|nohup|nodejs\.org/);
  assert.match(args, /StrictHostKeyChecking=yes/);
  assert.match(args, /ConnectTimeout=\d+/);
});

test("the probe does not spawn when the signal is already aborted", async () => {
  const result = await probeSshHost({
    host: { id: "x", host: "server.example" },
    signal: AbortSignal.abort(),
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /远程连接已取消/);
});

test("runSshCommand does not spawn when the signal is already aborted", async () => {
  await assert.rejects(
    () =>
      runSshCommand({
        host: { id: "x", host: "server.example" },
        command: "true",
        signal: AbortSignal.abort(),
      }),
    /远程连接已取消/,
  );
});

test("a host from ~/.ssh/config is passed by alias so OpenSSH resolves user, port and key", () => {
  const host = { id: "ssh:dev", host: "dev", source: "config" as const, user: "parsed", port: 2222, identityFile: "/keys/parsed" };
  const args = buildSshTunnelArgs({ host, localPort: 17777, remotePort: 7777 });
  assert.equal(args.at(-1), "dev");
  assert.equal(args.includes("-p"), false);
  assert.equal(args.includes("-i"), false);
  assert.equal(sshDestination(host), "dev");
  assert.equal(sshDestination({ ...host, source: "manual" }), "parsed@dev");
});

test("OpenSSH failures are classified, and a changed key is never taken for an unknown one", () => {
  assert.equal(classifySshFailure("No ED25519 host key is known for dev and you have requested strict checking.\nHost key verification failed."), "host-key-unknown");
  assert.equal(classifySshFailure("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed."), "host-key-changed");
  assert.equal(classifySshFailure("root@dev: Permission denied (publickey,password)."), "auth-failed");
  assert.equal(classifySshFailure("ssh: connect to host dev port 22: Connection refused"), undefined);
});

test("the probe carries the failure code for the GUI to act on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-probe-"));
  const fake = join(dir, "ssh");
  writeFileSync(fake, "#!/bin/sh\necho 'No ED25519 host key is known for dev and you have requested strict checking.' >&2\necho 'Host key verification failed.' >&2\ncat >/dev/null\nexit 255\n", { mode: 0o700 });
  const result = await probeSshHost({ host: { id: "x", host: "dev" }, sshBinary: fake, timeoutMs: 5_000 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "host-key-unknown");
});
